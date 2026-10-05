/**
 * Maps a {@link walkMainline} unit list to release tags, in the walk's own
 * topological order (never `git tag --contains` per unit, and never one
 * process per unit): a unit's position in the walked array already encodes
 * "how far back from the walk's start" it is, and `MainlineUnit.position`
 * equals its index, so release boundaries fall out of a single linear scan
 * once tags are located in that same array. Units after the newest tag have
 * no release ("unreleased"). Tags not reachable on the walk (off-mainline,
 * or not matching `tagPattern`) are ignored.
 *
 * Changelog anchors are attached per release with one `findChangelogAnchors`
 * call per release's own commit range (bounded by the number of releases,
 * not the number of units).
 */

import { assertValidSha, type GitRunner, runGit } from "./collect.ts";
import { type ChangelogAnchor, filterFeatureAnchors, findChangelogAnchors, type MainlineUnit } from "./mainline.ts";

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

/** One release's grouping of mainline units, before changelog anchors are attached. */
export interface ReleaseGroup {
	/** Absent for the "unreleased" group (units newer than the newest tag). */
	tag?: string;
	tagSha?: string;
	date?: string;
	/** Name of the next-older release on the walk, absent for the oldest one. */
	previousTag?: string;
	/** This release's own units, newest first (matching the walk order). */
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

/**
 * Partitions `units` (as returned by {@link walkMainline}, so `position`
 * already equals the array index) into release groups: a unit belongs to the
 * nearest tag at or above its position (D1's walk order, not calendar time
 * or `git tag --contains`). Pure: no git access, and tags not found among
 * `units` (off-mainline, or already filtered by `tagPattern`) are ignored.
 */
export function mapUnitsToReleases(units: readonly MainlineUnit[], tags: readonly ReleaseTag[]): ReleaseGroup[] {
	const positionBySha = new Map(units.map((unit) => [unit.sha, unit.position]));
	const onMainline = tags
		.map((tag) => ({ tag, position: positionBySha.get(tag.sha) }))
		.filter((entry): entry is { tag: ReleaseTag; position: number } => entry.position !== undefined)
		.sort((a, b) => a.position - b.position);

	const makeGroup = (
		tagEntry: { tag: ReleaseTag; position: number } | undefined,
		previousTagEntry: { tag: ReleaseTag; position: number } | undefined,
		rangeUnits: MainlineUnit[],
	): ReleaseGroup => {
		const buckets = bucketUnits(rangeUnits);
		return {
			tag: tagEntry?.tag.name,
			tagSha: tagEntry?.tag.sha,
			date: tagEntry?.tag.date,
			previousTag: previousTagEntry?.tag.name,
			units: rangeUnits,
			...buckets,
			anchors: [],
			tiny: isTinyRelease({ ...buckets, anchors: [] }),
		};
	};

	if (onMainline.length === 0) {
		return units.length > 0 ? [makeGroup(undefined, undefined, [...units])] : [];
	}

	const groups: ReleaseGroup[] = [];
	const firstTag = onMainline[0] as { tag: ReleaseTag; position: number };
	if (firstTag.position > 0) {
		groups.push(makeGroup(undefined, undefined, units.slice(0, firstTag.position)));
	}
	for (let i = 0; i < onMainline.length; i++) {
		const tagEntry = onMainline[i] as { tag: ReleaseTag; position: number };
		const nextTagEntry = onMainline[i + 1];
		const end = nextTagEntry ? nextTagEntry.position : units.length;
		groups.push(makeGroup(tagEntry, nextTagEntry, units.slice(tagEntry.position, end)));
	}
	return groups;
}

export interface AttachChangelogAnchorsOptions {
	repo: string;
	/** The full mainline unit list (not just one group's slice), so folded branch commits still resolve to their owning unit. */
	units: readonly MainlineUnit[];
	git?: GitRunner;
	thresholds?: TinyReleaseThresholds;
}

/**
 * Attaches changelog anchors to each group with one `findChangelogAnchors`
 * call per group (bounded by release count, never by unit count), using each
 * group's own oldest/newest unit as the commit range. A direct commit that
 * owns a feature anchor (owner decision Q1) is promoted from `otherUnitIds`
 * into `featureUnitIds`, since it is a story even without being a feature
 * merge. `tiny` is recomputed from the attached anchors.
 */
export async function attachChangelogAnchors(
	groups: readonly ReleaseGroup[],
	opts: AttachChangelogAnchorsOptions,
): Promise<ReleaseGroup[]> {
	const git = opts.git ?? runGit;
	const result: ReleaseGroup[] = [];

	for (const group of groups) {
		if (group.units.length === 0) {
			result.push(group);
			continue;
		}

		const newest = group.units[0] as MainlineUnit;
		const oldest = group.units[group.units.length - 1] as MainlineUnit;
		const lowerParent = oldest.parents[0];
		const range = lowerParent ? `${lowerParent}..${newest.sha}` : newest.sha;

		const rawAnchors = await findChangelogAnchors(opts.units, { repo: opts.repo, range, git });
		const anchors = filterFeatureAnchors(rawAnchors, opts.units);

		const groupShas = new Set(group.units.map((unit) => unit.sha));
		const anchorUnitIds = new Set(anchors.map((anchor) => anchor.unitId).filter((id) => groupShas.has(id)));

		const featureUnitIds = Array.from(new Set([...group.featureUnitIds, ...anchorUnitIds]));
		const otherUnitIds = group.otherUnitIds.filter((id) => !anchorUnitIds.has(id));

		result.push({
			...group,
			featureUnitIds,
			otherUnitIds,
			anchors,
			tiny: isTinyRelease({ featureUnitIds, anchors }, opts.thresholds),
		});
	}

	return result;
}

export interface BuildReleaseGroupsOptions {
	repo: string;
	units: readonly MainlineUnit[];
	tagPattern: string | RegExp;
	git?: GitRunner;
	thresholds?: TinyReleaseThresholds;
}

/** Convenience wrapper: lists tags, maps units to releases, and attaches changelog anchors in one call. */
export async function buildReleaseGroups(opts: BuildReleaseGroupsOptions): Promise<ReleaseGroup[]> {
	const git = opts.git ?? runGit;
	const tags = await listReleaseTags(opts.repo, opts.tagPattern, git);
	const groups = mapUnitsToReleases(opts.units, tags);
	return attachChangelogAnchors(groups, { repo: opts.repo, units: opts.units, git, thresholds: opts.thresholds });
}
