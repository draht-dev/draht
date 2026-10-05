/**
 * `draht-reels plan --unit story` (read-only dry run, mirrors `build --unit
 * story`'s selection without writing a script, synthesizing audio, or
 * touching the public feed/drafts dir). Reports, per release in scope, which
 * stories/weak-features/overview/recap would be drafted and their current
 * status (`approved` from the public feed, `pending` from an existing
 * draft, `rejected` from state, else `new`), plus a rough TTS character
 * budget check for everything still `new`.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "./collect.ts";
import { runGit } from "./collect.ts";
import type { FileChange, Story } from "./contract.ts";
import type { GithubLookup } from "./github.ts";
import type { ChangelogAnchor } from "./mainline.ts";
import { redactText } from "./privacy.ts";
import { readFeed } from "./publish.ts";
import type { ReelsConfig } from "./reels-config.ts";
import type { ChangelogSection, WeakFeatureInput } from "./release-writer.ts";
import { selectWeakFeatures } from "./release-writer.ts";
import { buildReleaseGroups, type ReleaseGroup } from "./releases.ts";
import { changelogSourceId } from "./sources.ts";
import { cappedIds, isRejected, type ReelsState, readState } from "./state.ts";
import {
	type AttributionStrength,
	collectStories,
	isValidDraftId,
	poolReleaseUpstreamRecap,
	type ReleaseUpstreamPool,
	recapId,
	releaseOverviewId,
	selectStoryUnits,
} from "./stories.ts";
import { computeDeepDiveScoreInputs, type DeepDiveMode, deepDiveScore, shouldRenderDeepDive } from "./story-writer.ts";

/** `"later"`: eligible and not yet drafted/approved/rejected, but beyond this run's `selectStoryUnits` window (e.g. `--limit`) — the next `build --unit story` run would not draft it either. */
export type DraftStatus = "approved" | "pending" | "rejected" | "new" | "later";

export interface StoryPlanEntry {
	id: string;
	origin: Story["origin"];
	attribution?: AttributionStrength;
	title: string;
	status: DraftStatus;
}

export interface ReleaseArtifactPlan {
	wouldDraft: boolean;
	status: DraftStatus;
}

export interface ReleasePlan {
	/** Absent for the still-open "Unreleased" group. */
	tag?: string;
	date?: string;
	tiny: boolean;
	stories: StoryPlanEntry[];
	/** Already deduplicated and capped the same way `release-writer.ts`'s `selectWeakFeatures` caps what the overview writer sees. */
	weakFeatures: string[];
	/** Count of near-duplicate-free weak features the cap above would cut, matching `weakFeaturesRemainderCount`'s "and N more smaller changes" sentence. */
	weakFeaturesRemainderCount: number;
	upstreamAnchorCount: number;
	overview: ReleaseArtifactPlan;
	recap: ReleaseArtifactPlan;
}

export interface TtsEstimateItem {
	id: string;
	kind: "story" | "overview" | "recap";
	title: string;
	chars: number;
	fits: boolean;
}

export interface TtsEstimate {
	items: TtsEstimateItem[];
	totalChars: number;
	fitsWithinCap: boolean;
}

export interface StoryPlan {
	name: string;
	maxTtsChars: number;
	releases: ReleasePlan[];
	ttsEstimate: TtsEstimate;
}

/** The per-item TTS char estimates the plan assigns a `"new"` item, approximating `countTtsChars` without
 * actually writing a script (no LLM call). The deep-dive add-on reuses `deepDiveScore`'s real signals, except
 * `hasAlternativesDoc` (needs assembled context sources, which the plan never builds) always reads `false`. */
const SHORT_STORY_CHARS = 1_200;
const DEEP_DIVE_CHARS = 600;
const OVERVIEW_CHARS = 900;
const RECAP_CHARS = 900;

export interface PlanStoryOptions {
	repo: string;
	ref: string;
	allHistory?: boolean;
	scan?: number;
	/** Same `--limit` `build --unit story` applies through `selectStoryUnits`; stories beyond it are reported `"later"`, not planned for this run. */
	limit?: number;
	/** Same `--force` `build --unit story` applies: bypasses the render retry cap and re-selects rejected stories. */
	force?: boolean;
	config: ReelsConfig;
	deepDive: DeepDiveMode;
	maxTtsChars: number;
	outDir: string;
	name: string;
	draftsBaseDir: string;
	git?: GitRunner;
	gh?: GithubLookup;
}

function statusOf(
	id: string,
	approvedIds: ReadonlySet<string>,
	draftedIds: ReadonlySet<string>,
	state: ReelsState,
): DraftStatus {
	if (approvedIds.has(id)) return "approved";
	if (draftedIds.has(id)) return "pending";
	if (isRejected(state, id)) return "rejected";
	return "new";
}

/** A story's status additionally considers `selectStoryUnits`' window (`--limit`, floor/scan): a story that is
 * otherwise `"new"` but outside this run's selected ids is `"later"` — the next real `build --unit story` run
 * would not draft it either. Release overview/recap artifacts are never limited this way (`draftReleaseArtifacts`
 * has no `--limit` of its own), so they keep plain {@link statusOf}. */
function storyStatusOf(
	id: string,
	approvedIds: ReadonlySet<string>,
	draftedIds: ReadonlySet<string>,
	state: ReelsState,
	selectedIds: ReadonlySet<string>,
): DraftStatus {
	const status = statusOf(id, approvedIds, draftedIds, state);
	return status === "new" && !selectedIds.has(id) ? "later" : status;
}

const CHANGELOG_SECTIONS = new Set<ChangelogSection>(["Breaking Changes", "Added", "Changed", "Fixed", "Removed"]);

function asChangelogSection(section: string): ChangelogSection | undefined {
	return CHANGELOG_SECTIONS.has(section as ChangelogSection) ? (section as ChangelogSection) : undefined;
}

/** A weak-attributed story's own changelog anchor is always its head commit (`buildCommitStory`'s weak path never
 * finds a separate implementing commit), so matching `group.anchors` by that commit's 12-char prefix recovers the
 * section the story's title has no other record of. Mirrors `cli.ts`'s `weakStorySection`. */
function weakStorySection(story: Story, anchors: readonly ChangelogAnchor[]): ChangelogSection | undefined {
	const sha12 = story.commits[0];
	if (!sha12) return undefined;
	const anchor = anchors.find((a) => a.commitSha.startsWith(sha12));
	return anchor ? asChangelogSection(anchor.section) : undefined;
}

/** Mirrors `cli.ts`'s `topPackage`: a story's deterministic theme/package key from its first `packages/<pkg>/...`
 * changed path, else `"general"`. */
function topPackage(files: readonly FileChange[]): string {
	for (const file of files) {
		const match = /^packages\/([^/]+)\//.exec(file.path);
		if (match) return match[1] as string;
	}
	return "general";
}

/** Candidate weak features of a release — the same subset `release-writer.ts`'s overview lists instead of giving
 * its own reel, see `cli.ts`'s `collectWeakFeatures` — not yet deduplicated or capped. */
function weakFeatureCandidates(
	group: ReleaseGroup,
	allStories: readonly Story[],
	attribution: ReadonlyMap<string, AttributionStrength>,
	storyById: ReadonlyMap<string, Story>,
): WeakFeatureInput[] {
	return allStories
		.filter(
			(s) =>
				s.release === group.tag &&
				s.origin === "commit" &&
				attribution.get(s.id) === "weak" &&
				!storyById.has(s.id),
		)
		.map((s, i) => ({
			title: s.title,
			anchorText: s.title,
			changelogSourceId: changelogSourceId(topPackage(s.files), group.tag ?? "unreleased", i),
			section: weakStorySection(s, group.anchors),
		}));
}

export async function planStories(options: PlanStoryOptions): Promise<StoryPlan> {
	const git = options.git ?? runGit;

	const groups = await buildReleaseGroups({
		repo: options.repo,
		ref: options.ref,
		tagPattern: options.config.tagPattern,
		historyFloor: options.config.historyFloor,
		scan: options.scan,
		allHistory: options.allHistory,
		config: options.config,
		git,
	});

	const draftsDir = join(options.draftsBaseDir, options.name);
	const state = await readState(options.draftsBaseDir, options.name);
	const draftedIds = new Set((await readdir(draftsDir).catch(() => [] as string[])).filter(isValidDraftId));
	const existingFeed = await readFeed(options.outDir, options.name);
	const approvedIds = new Set(existingFeed?.reels.map((r) => r.id) ?? []);

	const allStories: Story[] = [];
	const attribution = new Map<string, AttributionStrength>();
	const poolByGroup = new Map<ReleaseGroup, ReleaseUpstreamPool>();
	for (const group of groups) {
		const anchorsWithRange = group.anchors.map((anchor) => ({ anchor, range: group.range }));
		const result = await collectStories(group.units, {
			repo: options.repo,
			git,
			gh: options.gh,
			anchors: anchorsWithRange,
		});
		for (const story of result.stories) story.release = group.tag;
		allStories.push(...result.stories);
		for (const [id, strength] of result.attribution) attribution.set(id, strength);
		poolByGroup.set(group, poolReleaseUpstreamRecap(group.units, result.syncRecap));
	}

	const minAttribution = options.config.story.minAttribution;
	const eligibleStories = allStories.filter((story) => {
		if (story.origin !== "commit") return true;
		if (minAttribution === "weak") return true;
		return attribution.get(story.id) !== "weak";
	});
	const storyById = new Map(eligibleStories.map((s) => [s.id, s]));

	// Mirrors `runBuildStory`'s own selection exactly: the same floor/scan/limit/force semantics through
	// `selectStoryUnits`, over the same flat, rejection-filtered id list, so a story's reported status matches what
	// the next real `build --unit story` run would do with it.
	const capped = options.force ? new Set<string>() : cappedIds(state);
	const rejectedIds = options.force ? new Set<string>() : new Set(Object.keys(state.rejected ?? {}));
	const storyIdsForSelection = eligibleStories.map((s) => s.id).filter((id) => !rejectedIds.has(id));
	const selection = selectStoryUnits(storyIdsForSelection, approvedIds, capped, {
		allHistory: options.allHistory,
		limit: options.limit,
		force: options.force,
	});
	const selectedIds = new Set(selection.ids);

	const releases: ReleasePlan[] = [];
	const ttsItems: TtsEstimateItem[] = [];

	for (const group of groups) {
		const groupStories = eligibleStories.filter((s) => s.release === group.tag);
		const storyEntries: StoryPlanEntry[] = groupStories.map((s) => ({
			id: s.id,
			origin: s.origin,
			attribution: s.origin === "commit" ? attribution.get(s.id) : undefined,
			title: redactText(s.title),
			status: storyStatusOf(s.id, approvedIds, draftedIds, state, selectedIds),
		}));

		for (const story of groupStories) {
			if (storyStatusOf(story.id, approvedIds, draftedIds, state, selectedIds) !== "new") continue;
			const score = deepDiveScore(computeDeepDiveScoreInputs(story, new Map()));
			const chars = SHORT_STORY_CHARS + (shouldRenderDeepDive(options.deepDive, score) ? DEEP_DIVE_CHARS : 0);
			ttsItems.push({ id: story.id, kind: "story", title: redactText(story.title), chars, fits: false });
		}

		const pool = poolByGroup.get(group) ?? { syncMerges: [], upstreamCommits: [], anchors: [] };
		const { kept: weakFeaturesKept, remainderCount: weakFeaturesRemainderCount } = selectWeakFeatures(
			weakFeatureCandidates(group, allStories, attribution, storyById),
		);
		const weakFeatures = weakFeaturesKept.map((w) => redactText(w.title));

		const tagKey = group.tag ?? "unreleased";
		const overviewLabel = `Release overview: ${group.tag ?? "Unreleased"}`;
		const overviewId = releaseOverviewId(tagKey);
		// No release overview or upstream recap for still-open "Unreleased" work: there is no release to summarize
		// yet. Stories in unreleased work stay eligible above; only these two artifacts are skipped.
		const overviewWouldDraft = !group.tiny && group.tag !== undefined;
		const overviewStatus = statusOf(overviewId, approvedIds, draftedIds, state);
		if (overviewWouldDraft && overviewStatus === "new") {
			ttsItems.push({ id: overviewId, kind: "overview", title: overviewLabel, chars: OVERVIEW_CHARS, fits: false });
		}

		const recapLabel = `Upstream recap: ${group.tag ?? "Unreleased"}`;
		const recapIdValue = recapId(tagKey);
		const recapWouldDraft = pool.anchors.length > 0 && group.tag !== undefined;
		const recapStatus = statusOf(recapIdValue, approvedIds, draftedIds, state);
		if (recapWouldDraft && recapStatus === "new") {
			ttsItems.push({ id: recapIdValue, kind: "recap", title: recapLabel, chars: RECAP_CHARS, fits: false });
		}

		releases.push({
			tag: group.tag,
			date: group.date,
			tiny: group.tiny,
			stories: storyEntries,
			weakFeatures,
			weakFeaturesRemainderCount,
			upstreamAnchorCount: pool.anchors.length,
			overview: { wouldDraft: overviewWouldDraft, status: overviewStatus },
			recap: { wouldDraft: recapWouldDraft, status: recapStatus },
		});
	}

	let running = 0;
	let overCap = false;
	for (const item of ttsItems) {
		if (!overCap && running + item.chars <= options.maxTtsChars) {
			running += item.chars;
			item.fits = true;
		} else {
			overCap = true;
			item.fits = false;
		}
	}
	const totalChars = ttsItems.reduce((sum, item) => sum + item.chars, 0);

	return {
		name: options.name,
		maxTtsChars: options.maxTtsChars,
		releases,
		ttsEstimate: { items: ttsItems, totalChars, fitsWithinCap: totalChars <= options.maxTtsChars },
	};
}

function statusLabel(status: DraftStatus): string {
	return status;
}

export function formatStoryPlan(plan: StoryPlan): string {
	const lines: string[] = [];
	lines.push(`draht-reels plan --unit story: ${plan.name}`);
	lines.push(`TTS cap: ${plan.maxTtsChars} chars`);
	lines.push("");

	for (const release of plan.releases) {
		const label = release.tag ?? "Unreleased";
		lines.push(`${label}${release.date ? ` (${release.date})` : ""} — tiny=${release.tiny}`);
		if (release.stories.length === 0) {
			lines.push("  stories: none");
		} else {
			for (const story of release.stories) {
				const attr = story.attribution ?? "-";
				lines.push(
					`  story  ${story.id.slice(0, 12)}  ${story.origin}  ${attr}  ${statusLabel(story.status)}  ${story.title}`,
				);
			}
		}
		if (release.weakFeatures.length > 0) {
			const remainder =
				release.weakFeaturesRemainderCount > 0
					? ` (and ${release.weakFeaturesRemainderCount} more smaller change${release.weakFeaturesRemainderCount === 1 ? "" : "s"})`
					: "";
			lines.push(`  weak features: ${release.weakFeatures.join("; ")}${remainder}`);
		}
		lines.push(`  pooled upstream anchors: ${release.upstreamAnchorCount}`);
		lines.push(
			`  overview: ${release.overview.wouldDraft ? "would draft" : release.tag === undefined ? "would not draft (unreleased)" : "would not draft (tiny)"} (${statusLabel(release.overview.status)})`,
		);
		lines.push(
			`  recap: ${release.recap.wouldDraft ? "would draft" : release.tag === undefined ? "would not draft (unreleased)" : "would not draft (no pooled anchors)"} (${statusLabel(release.recap.status)})`,
		);
		lines.push("");
	}

	lines.push('TTS estimate (status "new" items only):');
	if (plan.ttsEstimate.items.length === 0) {
		lines.push("  none");
	} else {
		for (const item of plan.ttsEstimate.items) {
			lines.push(
				`  ${item.kind}  ${item.id.slice(0, 32)}  ${item.chars} chars  ${item.fits ? "fits" : "over cap"}  ${item.title}`,
			);
		}
	}
	lines.push(
		`  total: ${plan.ttsEstimate.totalChars} / ${plan.maxTtsChars} chars — ${plan.ttsEstimate.fitsWithinCap ? "fits within cap" : "exceeds cap"}`,
	);

	return lines.join("\n");
}
