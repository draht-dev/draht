/**
 * Builds one {@link ReleaseGroup} per release tag (plus "unreleased"), each
 * from its own exact revision range (redesign, 2026-10-05): `prevTag..tag`
 * where `prevTag` is the nearest older ancestor tag matching `tagPattern`,
 * and `lastTag..ref` for unreleased. `historyFloor` additionally excludes
 * its own ancestors (`^floor`) from every range it touches.
 *
 * The scan budget counts releases, not commits or units: by default the
 * newest {@link DEFAULT_RELEASE_SCAN} releases plus unreleased are built;
 * `allHistory` builds every release back to `historyFloor` (or the root,
 * when no floor is configured). One `git log --simplify-by-decoration` call
 * finds every `tagPattern`-matching tag that is an ancestor of `ref`,
 * already in ancestor order, so locating `prevTag` costs no extra `git`
 * call per tag; one {@link buildRangeUnits} call (itself two `git`
 * processes) per release is the only further git cost, bounded by the
 * number of releases actually built.
 */

import { assertValidSha, type GitRunner, listShas, runGit } from "./collect.ts";
import {
	buildRangeUnits,
	type ChangelogAnchor,
	filterFeatureAnchors,
	findChangelogAnchors,
	type MainlineUnit,
} from "./mainline.ts";
import { DEFAULT_REELS_CONFIG, type ReelsConfig } from "./reels-config.ts";

export interface ReleaseTag {
	name: string;
	/** The commit the tag resolves to (dereferenced for annotated tags). */
	sha: string;
	date: string;
}

const RELEASE_TAG_FORMAT = ["%(refname:strip=2)", "%(objectname)", "%(*objectname)", "%(creatordate:iso-strict)"].join(
	"%00",
);

/** Lists tags matching `tagPattern`, dereferencing annotated tags to their target commit. One `for-each-ref` call. */
export async function listReleaseTags(
	repo: string,
	tagPattern: string | RegExp,
	git: GitRunner = runGit,
): Promise<ReleaseTag[]> {
	const pattern = typeof tagPattern === "string" ? new RegExp(tagPattern) : tagPattern;
	const out = await git(["for-each-ref", `--format=${RELEASE_TAG_FORMAT}`, "--end-of-options", "refs/tags"], repo);

	const tags: ReleaseTag[] = [];
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [name, objectName, dereferenced, date] = trimmed.split("\x00");
		if (!name || !pattern.test(name)) continue;
		const sha = dereferenced || objectName;
		if (!sha) continue;
		tags.push({ name, sha: assertValidSha(sha), date: date ?? "" });
	}
	return tags;
}

/**
 * Lists `tagPattern`-matching tags that are ancestors of `ref`, newest
 * first, in ancestor order: one `git log --simplify-by-decoration`
 * traversal of `ref`'s history (a bounded method per the redesign note —
 * the walk is one process regardless of history size, and the per-release
 * scan budget is spent later, by {@link listReleaseRanges}, not here).
 * Order follows `--topo-order`'s parent-after-child guarantee, so for
 * ordinary release-tag topologies each entry's nearest older match is
 * simply the next one in this list.
 */
async function listAncestorTags(repo: string, ref: string, tagPattern: RegExp, git: GitRunner): Promise<ReleaseTag[]> {
	const out = await git(
		[
			"log",
			"--simplify-by-decoration",
			"--topo-order",
			"--decorate=full",
			"--format=%H%x00%ai%x00%D",
			"--end-of-options",
			ref,
		],
		repo,
	);
	const tags: ReleaseTag[] = [];
	const seen = new Set<string>();
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [sha, date, decorations] = trimmed.split("\x00");
		if (!sha || !decorations) continue;
		for (const raw of decorations.split(",")) {
			const decoration = raw.trim();
			const match = decoration.match(/^tag:\s*refs\/tags\/(.+)$/);
			if (!match) continue;
			const name = match[1] ?? "";
			if (!name || !tagPattern.test(name) || seen.has(name)) continue;
			seen.add(name);
			tags.push({ name, sha: assertValidSha(sha), date: date ?? "" });
		}
	}
	return tags;
}

export interface ReleaseRange {
	/** Absent for the "unreleased" range (newer than the newest matching tag). */
	tag?: string;
	tagSha?: string;
	date?: string;
	/** Name of the nearest older matching tag, absent for the oldest release built. */
	previousTag?: string;
	/** `git rev-list`/`git log` revision arguments for this release's exact set, e.g. `[tagSha, "^" + prevTagSha]`. */
	revisions: string[];
}

export const DEFAULT_RELEASE_SCAN = 6;

export interface ListReleaseRangesOptions {
	repo: string;
	ref: string;
	tagPattern: string | RegExp;
	/** Overrides `config.historyFloor`. A tag or sha; resolved the same way `ref` is. */
	historyFloor?: string;
	/** Number of released (tagged) ranges to build, newest first. Ignored when `allHistory`. Defaults to {@link DEFAULT_RELEASE_SCAN}. */
	scan?: number;
	/** Build every release back to `historyFloor` (or the root). */
	allHistory?: boolean;
	config?: ReelsConfig;
	git?: GitRunner;
}

/**
 * Computes the exact revision range for each release to build: the newest
 * `scan` tagged ranges (or all of them, back to `historyFloor`, when
 * `allHistory`) plus one "unreleased" range for everything newer than the
 * newest tag. Pure revision-range arithmetic over one `git` discovery call;
 * {@link buildRangeUnits} does the actual classification per range.
 */
export async function listReleaseRanges(opts: ListReleaseRangesOptions): Promise<ReleaseRange[]> {
	const git = opts.git ?? runGit;
	const config = opts.config ?? DEFAULT_REELS_CONFIG;
	const tagPattern = typeof opts.tagPattern === "string" ? new RegExp(opts.tagPattern) : opts.tagPattern;
	const historyFloorRef = opts.historyFloor ?? config.historyFloor;

	const [refSha] = await listShas(git, opts.repo, opts.ref, { limit: 1 });
	if (!refSha) return [];
	const historyFloorSha = historyFloorRef
		? (await listShas(git, opts.repo, historyFloorRef, { limit: 1 }))[0]
		: undefined;

	const ancestorTags = await listAncestorTags(opts.repo, refSha, tagPattern, git);

	// historyFloor excludes its own ancestors: a tag that is itself an
	// ancestor of the floor sits entirely below it, so it is dropped rather
	// than producing an empty (or negative) range.
	const floorExclusions = historyFloorSha ? [`^${historyFloorSha}`] : [];
	const tags: ReleaseTag[] = [];
	for (const tag of ancestorTags) {
		tags.push(tag);
		if (!opts.allHistory && tags.length >= (opts.scan ?? DEFAULT_RELEASE_SCAN) + 1) break;
	}

	const ranges: ReleaseRange[] = [];
	const lastTag = tags[0];
	ranges.push({
		tag: undefined,
		revisions: [refSha, ...(lastTag ? [`^${lastTag.sha}`] : []), ...floorExclusions],
	});

	const scanCount = opts.allHistory ? tags.length : Math.min(tags.length, opts.scan ?? DEFAULT_RELEASE_SCAN);
	for (let i = 0; i < scanCount; i++) {
		const tag = tags[i];
		if (!tag) continue;
		const prevTag = tags[i + 1];
		if (prevTag && historyFloorSha) {
			const isPrevAncestorOfFloor = await isAncestor(git, opts.repo, prevTag.sha, historyFloorSha);
			if (isPrevAncestorOfFloor) {
				ranges.push({
					tag: tag.name,
					tagSha: tag.sha,
					date: tag.date,
					previousTag: undefined,
					revisions: [tag.sha, ...floorExclusions],
				});
				continue;
			}
		}
		ranges.push({
			tag: tag.name,
			tagSha: tag.sha,
			date: tag.date,
			previousTag: prevTag?.name,
			revisions: [tag.sha, ...(prevTag ? [`^${prevTag.sha}`] : []), ...floorExclusions],
		});
	}

	return ranges;
}

async function isAncestor(git: GitRunner, repo: string, maybeAncestor: string, descendant: string): Promise<boolean> {
	try {
		await git(["merge-base", "--is-ancestor", "--end-of-options", maybeAncestor, descendant], repo);
		return true;
	} catch {
		return false;
	}
}

/** One release's grouping of mainline units, with changelog anchors attached. */
export interface ReleaseGroup {
	/** Absent for the "unreleased" group (newer than the newest tag). */
	tag?: string;
	tagSha?: string;
	date?: string;
	/** Name of the next-older release, absent for the oldest one built. */
	previousTag?: string;
	/** This release's own units, newest first. */
	units: MainlineUnit[];
	/** Unit shas that are feature-branch merges, or (once anchors are attached) own a changelog anchor. */
	featureUnitIds: string[];
	/** Unit shas classified `upstream-sync`. */
	syncUnitIds: string[];
	/** Everything else: back-merge containers, oversized merges, branch-sync merges, and unanchored direct commits. */
	otherUnitIds: string[];
	anchors: ChangelogAnchor[];
	tiny: boolean;
}

export const DEFAULT_MIN_STORIES = 2;
export const DEFAULT_MIN_CHANGELOG_ENTRIES = 8;

export interface TinyReleaseThresholds {
	minStories?: number;
	minChangelogEntries?: number;
}

/** A release is tiny when it has neither enough feature units nor enough matched changelog entries to carry an overview reel. */
export function isTinyRelease(
	group: Pick<ReleaseGroup, "featureUnitIds" | "anchors">,
	thresholds: TinyReleaseThresholds = {},
): boolean {
	const minStories = thresholds.minStories ?? DEFAULT_MIN_STORIES;
	const minChangelogEntries = thresholds.minChangelogEntries ?? DEFAULT_MIN_CHANGELOG_ENTRIES;
	return group.featureUnitIds.length < minStories && group.anchors.length < minChangelogEntries;
}

function bucketUnits(
	units: readonly MainlineUnit[],
): Pick<ReleaseGroup, "featureUnitIds" | "syncUnitIds" | "otherUnitIds"> {
	const featureUnitIds: string[] = [];
	const syncUnitIds: string[] = [];
	const otherUnitIds: string[] = [];
	for (const unit of units) {
		if (unit.class === "feature") featureUnitIds.push(unit.sha);
		else if (unit.class === "upstream-sync") syncUnitIds.push(unit.sha);
		// back-merge, oversized, branch-sync, and plain commits all land here;
		// a branch-sync merge carries no upstream work, so it must not join
		// syncUnitIds and get a recap reel it doesn't deserve.
		else otherUnitIds.push(unit.sha);
	}
	return { featureUnitIds, syncUnitIds, otherUnitIds };
}

export interface BuildReleaseGroupsOptions extends ListReleaseRangesOptions {
	thresholds?: TinyReleaseThresholds;
}

/**
 * Builds one {@link ReleaseGroup} per {@link listReleaseRanges} entry: units
 * from {@link buildRangeUnits}, then changelog anchors from one {@link
 * findChangelogAnchors} call over that same exact range (bounded by release
 * count, never by unit count). A direct commit that owns a feature anchor
 * (owner decision Q1) is promoted from `otherUnitIds` into `featureUnitIds`,
 * since it is a story even without being a feature merge.
 */
export async function buildReleaseGroups(opts: BuildReleaseGroupsOptions): Promise<ReleaseGroup[]> {
	const git = opts.git ?? runGit;
	const config = opts.config ?? DEFAULT_REELS_CONFIG;
	const ranges = await listReleaseRanges(opts);
	const groups: ReleaseGroup[] = [];

	for (const range of ranges) {
		const units = await buildRangeUnits({ repo: opts.repo, revisions: range.revisions, config, git });
		const buckets = bucketUnits(units);

		let anchors: ChangelogAnchor[] = [];
		if (units.length > 0) {
			const rangeArg = range.revisions.join(" ");
			const rawAnchors = await findChangelogAnchors(units, { repo: opts.repo, range: rangeArg, git });
			anchors = filterFeatureAnchors(rawAnchors, units);
		}

		const groupShas = new Set(units.map((unit) => unit.sha));
		const anchorUnitIds = new Set(anchors.map((anchor) => anchor.unitId).filter((id) => groupShas.has(id)));
		const featureUnitIds = Array.from(new Set([...buckets.featureUnitIds, ...anchorUnitIds]));
		const otherUnitIds = buckets.otherUnitIds.filter((id) => !anchorUnitIds.has(id));

		groups.push({
			tag: range.tag,
			tagSha: range.tagSha,
			date: range.date,
			previousTag: range.previousTag,
			units,
			featureUnitIds,
			syncUnitIds: buckets.syncUnitIds,
			otherUnitIds,
			anchors,
			tiny: isTinyRelease({ featureUnitIds, anchors }, opts.thresholds),
		});
	}

	return groups;
}
