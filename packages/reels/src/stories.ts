/**
 * Turns a {@link MainlineUnit} walk plus changelog anchors into `Story`s
 * (owner decision Q1): one per feature-branch merge (`origin: "pr"` when
 * GitHub reports a PR for the head sha, else `"branch"`) and one per
 * changelog entry that anchors direct-work (`origin: "commit"`, the Data
 * model's name for what the plan text calls a "changelog" story).
 *
 * Attribution (T1 amendment, 2026-10-05): a changelog entry's *owning*
 * commit (the one `git log -S` on the changelog file finds) is often not the
 * commit that did the work — a later docs/release commit can record the
 * entry after the fact. So each entry's identifiers (backticked tokens,
 * `/commands`, `--flags`, `ENV_VARS`, `dotted.symbols`, camelCase/snake_case
 * names, file paths) are searched for with `git log -S`/`-G` inside the
 * entry's own release range and package paths, bounded by
 * {@link DEFAULT_MAX_IDENTIFIERS} and {@link DEFAULT_MAX_PROCESSES}. The
 * ranked result is the "implementing set"; when nothing is found, the
 * anchor commit itself is the fallback and the story is marked `"weak"`
 * (see {@link CollectStoriesResult.attribution}, kept out of `contract.ts`
 * since it is a pipeline-internal confidence signal, never published).
 *
 * Routing: an implementing set owned by an `upstream-sync` (or side-chain)
 * unit means the entry's actual work was carried in from upstream, so it is
 * routed to {@link CollectStoriesResult.syncRecap} instead of becoming a
 * story (Q2). An implementing set owned by a `feature` merge unit means the
 * entry documents that merge's own branch, so it is folded into that
 * branch's story rather than duplicated as a second one.
 *
 * Selection reuses `collect.ts`'s `selectFromWindow` (the same floor,
 * bootstrap, drain, all-history, and retry-cap semantics as `--unit
 * commit`), over the story-eligible subset of the mainline walk.
 */

import {
	assertValidSha,
	fetchCommitMetadata,
	fetchFileChanges,
	type GitRunner,
	runGit,
	selectFromWindow,
	type WindowSelection,
} from "./collect.ts";
import type { CommitInfo, PullRequestInfo, Story } from "./contract.ts";
import type { GithubLookup } from "./github.ts";
import type { ChangelogAnchor, MainlineUnit } from "./mainline.ts";

export const DEFAULT_MAX_IDENTIFIERS = 8;
export const DEFAULT_MAX_PROCESSES = 8;
/** Of the candidates found for one entry, at most this many implementing commits are kept, even when several tie on identifier-hit count. */
const MAX_IMPLEMENTING_COMMITS = 3;

/** A story's confidence in its implementing-commit attribution. Pipeline-internal: never published (not part of `StoryMeta`). */
export type AttributionStrength = "strong" | "weak";

export interface SelectStoryUnitsOptions {
	allHistory?: boolean;
	limit?: number;
	force?: boolean;
}

/**
 * The story-selection analogue of `selectBuildShas`: `storyIds` is the
 * story-eligible subset of the mainline walk (or any other already-ordered,
 * newest-first id list — including legacy per-commit `change` ids, which
 * stay eligible as opaque published ids). Capped ids are skipped unless
 * `force`.
 */
export function selectStoryUnits(
	storyIds: string[],
	published: ReadonlySet<string>,
	capped: ReadonlySet<string>,
	opts: SelectStoryUnitsOptions = {},
): WindowSelection {
	return selectFromWindow({
		windowIds: storyIds,
		allHistory: opts.allHistory,
		limit: opts.limit,
		force: opts.force,
		publishedIds: published,
		cappedIds: capped,
	});
}

// --- Identifier extraction -------------------------------------------------

const IDENTIFIER_PATTERNS: RegExp[] = [
	/`([^`]+)`/g, // backticked tokens
	/(?<![\w/-])\/[a-zA-Z][\w-]*/g, // /commands
	/(?<![\w-])--[a-zA-Z][\w-]*/g, // --flags
	/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // ENV_VARS
	/\b[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)+\b/g, // dotted.symbols
	/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // camelCase
	/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, // snake_case
	/\b[\w.-]+\/[\w./-]+\b/g, // file paths
];

/**
 * Extracts candidate identifiers from one changelog entry's text (T1
 * amendment). Pure, order-stable, deduped, capped at `max`.
 */
export function extractIdentifiers(entryText: string, max: number = DEFAULT_MAX_IDENTIFIERS): string[] {
	const seen = new Set<string>();
	for (const pattern of IDENTIFIER_PATTERNS) {
		for (const match of entryText.matchAll(pattern)) {
			const raw = (match[1] ?? match[0]).trim();
			if (raw.length < 2) continue;
			seen.add(raw);
		}
	}
	return Array.from(seen).slice(0, max);
}

// --- Implementing-commit search --------------------------------------------

export interface ImplementingCommit {
	sha: string;
	subject: string;
}

interface ImplementingCandidate extends ImplementingCommit {
	hits: number;
	/** Position in oldest-first traversal; smaller is older. Ties prefer the oldest candidate — the likeliest original author of the work, not a later commit that merely mentions it. */
	firstSeenOrder: number;
}

/**
 * Pathspecs for one entry's identifier search: the entry's own package(s),
 * excluding that package's `CHANGELOG.md` itself — otherwise a quoted
 * identifier would "match" the changelog-editing commit that introduced the
 * entry text, defeating the whole point of looking past it.
 */
function packagePathspecs(packages: readonly string[]): string[] {
	const includes = packages.map((pkg) => (pkg === "root" ? "." : `packages/${pkg}`));
	const excludes = packages.map((pkg) => `:(exclude)${pkg === "root" ? "" : `packages/${pkg}/`}CHANGELOG.md`);
	return [...(includes.length > 0 ? includes : ["."]), ...excludes];
}

async function searchIdentifier(
	git: GitRunner,
	repo: string,
	range: string,
	pathspecs: readonly string[],
	identifier: string,
): Promise<ImplementingCommit[]> {
	const out = await git(
		["log", "--reverse", `-S${identifier}`, "--format=%H%x00%s", "--end-of-options", range, "--", ...pathspecs],
		repo,
	);
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [sha, subject] = line.split("\x00");
			return { sha: assertValidSha(sha ?? ""), subject: subject ?? "" };
		});
}

export interface FindImplementingCommitsOptions {
	repo: string;
	/** A `git log` revision range covering the entry's release, e.g. `"<fromSha>..<toSha>"`. */
	range: string;
	packages: readonly string[];
	git?: GitRunner;
	maxIdentifiers?: number;
	maxProcesses?: number;
}

/**
 * Finds the commits that likely implemented a changelog entry (T1
 * amendment): one `git log -S<id>` per extracted identifier (bounded by
 * `maxProcesses`), restricted to `range` and the entry's package paths.
 * Returns the top-ranked commits (most identifier hits, capped at
 * {@link MAX_IMPLEMENTING_COMMITS}, oldest first on a tie), or `[]` when
 * nothing is found.
 */
export async function findImplementingCommits(
	entryText: string,
	opts: FindImplementingCommitsOptions,
): Promise<ImplementingCommit[]> {
	const git = opts.git ?? runGit;
	const identifiers = extractIdentifiers(entryText, opts.maxIdentifiers ?? DEFAULT_MAX_IDENTIFIERS).slice(
		0,
		opts.maxProcesses ?? DEFAULT_MAX_PROCESSES,
	);
	if (identifiers.length === 0) return [];

	const pathspecs = packagePathspecs(opts.packages);
	const candidates = new Map<string, ImplementingCandidate>();
	let order = 0;

	for (const identifier of identifiers) {
		const commits = await searchIdentifier(git, opts.repo, opts.range, pathspecs, identifier);
		for (const commit of commits) {
			const existing = candidates.get(commit.sha);
			if (existing) existing.hits++;
			else candidates.set(commit.sha, { ...commit, hits: 1, firstSeenOrder: order++ });
		}
	}
	if (candidates.size === 0) return [];

	const maxHits = Math.max(...Array.from(candidates.values(), (c) => c.hits));
	return Array.from(candidates.values())
		.filter((c) => c.hits === maxHits)
		.sort((a, b) => a.firstSeenOrder - b.firstSeenOrder)
		.slice(0, MAX_IMPLEMENTING_COMMITS)
		.map((c) => ({ sha: c.sha, subject: c.subject }));
}

/**
 * True for draht's convention of replaying one upstream commit directly onto
 * the mainline (`upstream: feat(x): ...`), as opposed to folding a whole
 * sync branch into a merge. A `walkMainline` unit-ownership check alone
 * misses these: the commit is its own, ordinary `"commit"`-class unit, not a
 * branch commit of any `upstream-sync` merge.
 */
export function isUpstreamCarriedSubject(subject: string): boolean {
	return /^upstream:\s/i.test(subject);
}

// --- Overlap merging ---------------------------------------------------------

interface AnchorAttribution {
	anchor: ChangelogAnchor;
	implementing: string[];
	strength: AttributionStrength;
}

/**
 * Unions anchors whose implementing sets share at least one commit, so a
 * feature with several changelog lines yields one story, not several. Pure
 * union-find over plain arrays; group order follows first appearance.
 */
export function groupOverlappingAttributions(attributions: readonly AnchorAttribution[]): AnchorAttribution[][] {
	const parent = attributions.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) i = parent[i] as number;
		return i;
	};
	const union = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};

	const byCommit = new Map<string, number>();
	attributions.forEach((attribution, index) => {
		for (const sha of attribution.implementing) {
			const existing = byCommit.get(sha);
			if (existing !== undefined) union(existing, index);
			else byCommit.set(sha, index);
		}
	});

	const groups = new Map<number, AnchorAttribution[]>();
	attributions.forEach((attribution, index) => {
		const root = find(index);
		const group = groups.get(root);
		if (group) group.push(attribution);
		else groups.set(root, [attribution]);
	});
	return Array.from(groups.values());
}

// --- Story id ----------------------------------------------------------------

const STORY_ID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?(-[0-9a-f]{8})?$/;

/** Validates a story id where it becomes a path component or an `assertValidSha`-compatible media id. */
export function isValidStoryId(id: string): boolean {
	return STORY_ID_RE.test(id);
}

function hash8(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The stable story id (point 4 of T6): the head sha of the implementing set
 * for a changelog story, or the merge sha for a branch story — both already
 * valid `assertValidSha` ids, so the common case keeps today's `id = head
 * sha` media-path convention (D9). A `-<hash>` suffix is appended only to
 * disambiguate two distinct stories that would otherwise collapse onto the
 * same head sha (`usedIds` tracks ids already assigned this run).
 */
export function computeStoryId(headSha: string, anchorTexts: readonly string[], usedIds: ReadonlySet<string>): string {
	if (!usedIds.has(headSha)) return headSha;
	return `${headSha}-${hash8(anchorTexts.join("\u0000"))}`;
}

// --- Story collection ----------------------------------------------------------

export interface SyncRecapAnchor {
	anchor: ChangelogAnchor;
	implementing: string[];
}

export interface SkippedUnit {
	sha: string;
	reason: "oversized" | "back-merge" | "upstream-sync";
}

export interface CollectStoriesResult {
	stories: Story[];
	/** Changelog entries whose implementing work was carried in from upstream (Q2): feeds the sync recap, not a feature reel. */
	syncRecap: SyncRecapAnchor[];
	/** Confidence per story id; absent (never `"weak"`) stories used a found implementing set. */
	attribution: ReadonlyMap<string, AttributionStrength>;
	skipped: SkippedUnit[];
}

export interface AnchorWithRange {
	anchor: ChangelogAnchor;
	/** The `git log` range covering this anchor's own release (see `releases.ts`'s group ranges). */
	range: string;
}

export interface CollectStoriesOptions {
	repo: string;
	git?: GitRunner;
	gh?: GithubLookup;
	anchors?: readonly AnchorWithRange[];
	maxIdentifiers?: number;
	maxProcesses?: number;
}

function buildUnitOwnerMap(units: readonly MainlineUnit[]): Map<string, MainlineUnit> {
	const owner = new Map<string, MainlineUnit>();
	for (const unit of units) {
		owner.set(unit.sha, unit);
		for (const branchSha of unit.branchShas ?? []) owner.set(branchSha, unit);
	}
	return owner;
}

function toCommitInfo(raw: {
	sha: string;
	subject: string;
	body: string;
	authorName: string;
	date: string;
}): CommitInfo {
	return { sha: raw.sha, subject: raw.subject, body: raw.body, author: raw.authorName, date: raw.date };
}

async function buildBranchStory(
	unit: MainlineUnit,
	opts: { repo: string; git: GitRunner; gh?: GithubLookup },
): Promise<Story> {
	const head = await fetchCommitMetadata(opts.git, opts.repo, unit.sha);
	const branchCommits: CommitInfo[] = [];
	for (const sha of unit.branchShas ?? []) {
		branchCommits.push(toCommitInfo(await fetchCommitMetadata(opts.git, opts.repo, sha)));
	}

	let pr: PullRequestInfo | undefined;
	if (opts.gh) pr = await opts.gh.lookupPullRequestForSha(unit.sha);

	const files = await fetchFileChanges(opts.git, opts.repo, unit.sha);
	const authors = Array.from(new Set([head.authorName, ...branchCommits.map((c) => c.author)]));
	const base = unit.parents[0] ?? unit.sha;

	return {
		id: unit.sha,
		commits: [unit.sha, ...(unit.branchShas ?? [])].map((s) => s.slice(0, 12)),
		title: unit.subject,
		body: branchCommits
			.map((c) => c.body)
			.filter(Boolean)
			.join("\n\n"),
		authors,
		date: head.date,
		files,
		origin: pr ? "pr" : "branch",
		base,
		branchCommits,
		pr,
		related: [],
	};
}

async function buildCommitStory(
	headSha: string,
	anchorTexts: readonly string[],
	usedIds: ReadonlySet<string>,
	opts: { repo: string; git: GitRunner },
): Promise<Story> {
	const head = await fetchCommitMetadata(opts.git, opts.repo, headSha);
	const files = await fetchFileChanges(opts.git, opts.repo, headSha);
	const base = head.parents[0] ?? headSha;

	return {
		id: computeStoryId(headSha, anchorTexts, usedIds),
		commits: [headSha.slice(0, 12)],
		title: anchorTexts[0] ?? head.subject,
		body: head.body,
		authors: [head.authorName],
		date: head.date,
		files,
		origin: "commit",
		base,
		branchCommits: [],
		related: [],
	};
}

/**
 * Collects `Story`s from a mainline walk's feature-branch merges and from
 * changelog-anchored direct work (owner decision Q1), attributing each
 * anchor's implementing commits per the T1 amendment and merging anchors
 * whose implementing sets overlap into one story.
 */
export async function collectStories(
	units: readonly MainlineUnit[],
	opts: CollectStoriesOptions,
): Promise<CollectStoriesResult> {
	const git = opts.git ?? runGit;
	const ownerByCommit = buildUnitOwnerMap(units);
	const stories: Story[] = [];
	const skipped: SkippedUnit[] = [];
	const attribution = new Map<string, AttributionStrength>();
	const syncRecap: SyncRecapAnchor[] = [];

	for (const unit of units) {
		if (unit.class === "feature") {
			stories.push(await buildBranchStory(unit, { repo: opts.repo, git, gh: opts.gh }));
		} else if (unit.class === "oversized") {
			skipped.push({ sha: unit.sha, reason: "oversized" });
		} else if (unit.class === "back-merge") {
			skipped.push({ sha: unit.sha, reason: "back-merge" });
		} else if (unit.class === "upstream-sync") {
			skipped.push({ sha: unit.sha, reason: "upstream-sync" });
		}
	}

	const subjectBySha = new Map<string, string>();
	const attributions: AnchorAttribution[] = [];
	for (const { anchor, range } of opts.anchors ?? []) {
		const owningUnit = ownerByCommit.get(anchor.unitId);
		// A changelog entry that documents a feature merge's own branch is not a
		// second story: the merge already produced one in the loop above.
		if (owningUnit?.class === "feature") continue;

		const found = await findImplementingCommits(anchor.entryText, {
			repo: opts.repo,
			range,
			packages: anchor.packages,
			git,
			maxIdentifiers: opts.maxIdentifiers,
			maxProcesses: opts.maxProcesses,
		});
		for (const commit of found) subjectBySha.set(commit.sha, commit.subject);
		const implementing = found.length > 0 ? found.map((c) => c.sha) : [anchor.commitSha];
		attributions.push({ anchor, implementing, strength: found.length > 0 ? "strong" : "weak" });
	}

	for (const group of groupOverlappingAttributions(attributions)) {
		const implementing = Array.from(new Set(group.flatMap((a) => a.implementing)));
		const owningUnits = implementing.map((sha) => ownerByCommit.get(sha));
		const upstreamCarried =
			owningUnits.some((unit) => unit?.class === "upstream-sync" || unit?.side === "side") ||
			implementing.some((sha) => isUpstreamCarriedSubject(subjectBySha.get(sha) ?? ""));

		if (upstreamCarried) {
			for (const { anchor, implementing: anchorImplementing } of group) {
				syncRecap.push({ anchor, implementing: anchorImplementing });
			}
			continue;
		}
		if (owningUnits.some((unit) => unit?.class === "feature")) continue;

		const headSha = group[0]?.implementing[0] ?? group[0]?.anchor.commitSha;
		if (!headSha) continue;

		const anchorTexts = group.map((a) => a.anchor.entryText);
		const usedIds = new Set(stories.map((s) => s.id));
		const story = await buildCommitStory(headSha, anchorTexts, usedIds, { repo: opts.repo, git });
		stories.push(story);

		const strength: AttributionStrength = group.every((a) => a.strength === "strong") ? "strong" : "weak";
		attribution.set(story.id, strength);
	}

	return { stories, syncRecap, attribution, skipped };
}
