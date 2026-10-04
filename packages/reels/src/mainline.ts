/**
 * Walks a repo's "mainline" — the path a story walk and `prune` should treat
 * as reachable — which is not always `git log --first-parent`. At a
 * back-merge (the second parent carries release tags the first parent
 * lacks, as in draht-mono's `0c354b3a4`), the walk follows the second
 * parent instead, and the first parent's own first-parent chain becomes a
 * "side" line of units. Every other merge stays on its first parent and is
 * classified `feature | upstream-sync | oversized`.
 *
 * Security: every revision used in a `git` call is either resolved from
 * validated commit output ({@link assertValidSha}) or a config-controlled
 * literal (`refs/tags`, a pathspec). Commit subjects are read-only
 * classification input: they are matched with regexes in JS, never passed
 * to `git` as an argument.
 */

import {
	assertValidSha,
	type FirstParentMeta,
	type GitRunner,
	listFirstParentMeta,
	listShas,
	runGit,
} from "./collect.ts";
import { DEFAULT_REELS_CONFIG, type MergeOverride, type ReelsConfig, type UpstreamConfig } from "./reels-config.ts";

export type MergeClass = "feature" | "upstream-sync" | "back-merge" | "oversized";
export type UnitClass = "commit" | MergeClass;

export interface MainlineUnit {
	sha: string;
	parents: string[];
	subject: string;
	class: UnitClass;
	side: "main" | "side";
	position: number;
	/** For merges only: the folded branch commits (`M^1..M` minus `M`), oldest first. */
	branchShas?: string[];
}

export const DEFAULT_MAINLINE_SCAN = 500;

/** Below this many branch commits, an author-ratio sample is too small to trust (D2). */
const FOREIGN_AUTHOR_SAMPLE_MIN = 20;
/** "the last 200 non-merge mainline commits" (D2). */
const LOCAL_AUTHOR_WINDOW = 200;

const BACK_MERGE_SUBJECT_PATTERNS: readonly RegExp[] = [
	/^Merge (?:remote-tracking )?branch '(?:main|master)'(?: of \S+)? into /i,
	/^merge (?:origin\/)?main into /i,
	/^Merge origin\/main into /i,
	/bring .*\bmain\b.* into /i,
];

/** Subject-pattern backup for the back-merge rule (D1), used when tag reachability is inconclusive. */
export function isBackMergeSubject(subject: string): boolean {
	return BACK_MERGE_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

export interface ClassifyMergeInput {
	subject: string;
	/** Branch commits excluding the merge itself. */
	branchCommitCount: number;
	markerTouched: boolean;
	/** Undefined when the branch is smaller than {@link FOREIGN_AUTHOR_SAMPLE_MIN}. */
	foreignAuthorRatio?: number;
	override?: MergeOverride;
	upstream: UpstreamConfig;
	maxBranchCommits: number;
}

/** Classifies an ordinary (non-back-merge) merge. Pure: all git-derived facts are passed in. */
export function classifyMergeClass(input: ClassifyMergeInput): "feature" | "upstream-sync" | "oversized" {
	if (input.override === "feature" || input.override === "upstream-sync") {
		return input.override;
	}

	const subjectMatches = input.upstream.subjectPatterns.some((pattern) =>
		new RegExp(pattern, "i").test(input.subject),
	);
	const foreignDominated =
		input.foreignAuthorRatio !== undefined && input.foreignAuthorRatio > input.upstream.foreignAuthorRatio;
	if (subjectMatches || input.markerTouched || foreignDominated) return "upstream-sync";

	if (input.branchCommitCount > input.maxBranchCommits) return "oversized";
	return "feature";
}

async function listMergedTagNames(
	git: GitRunner,
	repo: string,
	mergedInto: string,
	notMergedInto: string,
): Promise<string[]> {
	const out = await git(
		[
			"for-each-ref",
			"--format=%(refname:short)",
			`--merged=${mergedInto}`,
			`--no-merged=${notMergedInto}`,
			"--end-of-options",
			"refs/tags",
		],
		repo,
	);
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The back-merge rule's mechanical check (D1): tags reachable only from `p2`, none only from `p1`. */
async function detectBackMergeByTags(
	git: GitRunner,
	repo: string,
	p1: string,
	p2: string,
	tagPattern: RegExp,
): Promise<boolean> {
	const [onlyP2, onlyP1] = await Promise.all([
		listMergedTagNames(git, repo, p2, p1),
		listMergedTagNames(git, repo, p1, p2),
	]);
	const matches = (names: string[]) => names.some((name) => tagPattern.test(name));
	return matches(onlyP2) && !matches(onlyP1);
}

/** `rev-list --count p1..m` counts commits reachable from `m` but not `p1`, which includes `m` itself. */
async function countBranchCommits(git: GitRunner, repo: string, p1: string, m: string): Promise<number> {
	const out = await git(["rev-list", "--count", "--end-of-options", `${p1}..${m}`], repo);
	const n = Number.parseInt(out.trim(), 10);
	return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
}

async function listBranchShas(git: GitRunner, repo: string, p1: string, m: string): Promise<string[]> {
	return (await listShas(git, repo, `${p1}..${m}`, {})).filter((sha) => sha !== m);
}

async function diffTouchesPaths(
	git: GitRunner,
	repo: string,
	p1: string,
	m: string,
	paths: readonly string[],
): Promise<boolean> {
	if (paths.length === 0) return false;
	const out = await git(["diff", "--name-only", "--end-of-options", p1, m], repo);
	const changed = new Set(
		out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	return paths.some((path) => changed.has(path));
}

async function collectLocalAuthorSet(git: GitRunner, repo: string, ref: string): Promise<Set<string>> {
	const out = await git(
		[
			"log",
			"--first-parent",
			"--no-merges",
			"-n",
			String(LOCAL_AUTHOR_WINDOW),
			"--format=%an",
			"--end-of-options",
			ref,
		],
		repo,
	);
	return new Set(
		out
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

async function computeForeignAuthorRatio(
	git: GitRunner,
	repo: string,
	p1: string,
	m: string,
	localAuthors: ReadonlySet<string>,
): Promise<number> {
	const out = await git(["log", "--format=%an", "--end-of-options", `${p1}..${m}`], repo);
	const authors = out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	if (authors.length === 0) return 0;
	const foreign = authors.filter((author) => !localAuthors.has(author)).length;
	return foreign / authors.length;
}

export interface WalkMainlineOptions {
	repo: string;
	ref: string;
	/** Size of the scan budget (total units emitted across the main and any side lines). Ignored when `allHistory`. */
	scan?: number;
	allHistory?: boolean;
	tagPattern: string | RegExp;
	/** Overrides `config.historyFloor`. A tag or sha; resolved the same way `ref` is. */
	historyFloor?: string;
	config?: ReelsConfig;
	git?: GitRunner;
}

/**
 * Walks the mainline from `ref` backward, newest first, swapping to the
 * second parent of a back-merge (D1) and classifying every other merge
 * (D2). One function feeds story selection, release mapping, and prune, so
 * they can never disagree about what is reachable.
 */
export async function walkMainline(opts: WalkMainlineOptions): Promise<MainlineUnit[]> {
	const git = opts.git ?? runGit;
	const config = opts.config ?? DEFAULT_REELS_CONFIG;
	const tagPattern = typeof opts.tagPattern === "string" ? new RegExp(opts.tagPattern) : opts.tagPattern;
	const historyFloorRef = opts.historyFloor ?? config.historyFloor;
	const scanLimit = opts.allHistory ? Number.MAX_SAFE_INTEGER : (opts.scan ?? DEFAULT_MAINLINE_SCAN);

	const [startSha] = await listShas(git, opts.repo, opts.ref, { limit: 1 });
	if (!startSha) return [];

	const historyFloor = historyFloorRef
		? (await listShas(git, opts.repo, historyFloorRef, { limit: 1 }))[0]
		: undefined;

	const metaCache = new Map<string, FirstParentMeta>();
	const getMeta = async (sha: string): Promise<FirstParentMeta> => {
		const cached = metaCache.get(sha);
		if (cached) return cached;
		const [meta] = await listFirstParentMeta(git, opts.repo, sha, 1);
		if (!meta) throw new Error(`commit ${sha} not found while walking the mainline`);
		metaCache.set(sha, meta);
		return meta;
	};

	let localAuthors: Set<string> | undefined;
	const getLocalAuthors = async (): Promise<Set<string>> => {
		if (!localAuthors) localAuthors = await collectLocalAuthorSet(git, opts.repo, startSha);
		return localAuthors;
	};

	const units: MainlineUnit[] = [];
	const budget = { remaining: scanLimit };
	// Deferred, not recursed into immediately: a back-merge's side (first-
	// parent) chain is often the deeper history (e.g. an upstream fork's own
	// past), while the swapped-to second parent is the shallow, real
	// continuation of the mainline. Walking the side chain eagerly would let
	// it drain the whole scan budget before the main walk ever resumes past
	// the swap, so every side root is queued and only walked once the main
	// line itself is exhausted (reaches its floor or its own root commit).
	const pendingSideRoots: string[] = [];
	// A back-merge's side chain and the swapped-to main chain can reconverge
	// on shared history below the fork point (every back-merge observed on
	// draht-mono's real history does, once walked past `historyFloor`). Once
	// a sha has been emitted once, re-walking it would both waste budget and
	// emit a duplicate unit, so every chain stops the moment it rejoins
	// already-visited history.
	const visited = new Set<string>();

	const walkChain = async (chainStart: string, side: "main" | "side"): Promise<void> => {
		let cursor: string | undefined = chainStart;
		while (cursor && budget.remaining > 0) {
			if (visited.has(cursor)) return;
			visited.add(cursor);
			budget.remaining--;
			const meta = await getMeta(cursor);
			const parents = meta.parents;

			if (parents.length <= 1) {
				units.push({ sha: cursor, parents, subject: meta.subject, class: "commit", side, position: units.length });
				if (cursor === historyFloor) return;
				cursor = parents[0];
				continue;
			}

			const p1 = assertValidSha(parents[0] ?? "");
			const p2 = assertValidSha(parents[1] ?? "");
			// "skip" is a story-selection override (phase 2), not a classification
			// override here, so it falls through to mechanical detection.
			const override = config.overrides[cursor];

			let isBack: boolean;
			if (override === "back-merge") isBack = true;
			else if (override === "feature" || override === "upstream-sync") isBack = false;
			else
				isBack =
					(await detectBackMergeByTags(git, opts.repo, p1, p2, tagPattern)) || isBackMergeSubject(meta.subject);

			if (isBack) {
				units.push({
					sha: cursor,
					parents,
					subject: meta.subject,
					class: "back-merge",
					side,
					position: units.length,
				});
				if (cursor === historyFloor) return;
				pendingSideRoots.push(p1);
				cursor = p2;
				continue;
			}

			const branchCommitCount = await countBranchCommits(git, opts.repo, p1, cursor);
			const markerTouched = await diffTouchesPaths(git, opts.repo, p1, cursor, config.upstream.markerPaths);
			let foreignAuthorRatio: number | undefined;
			if (branchCommitCount >= FOREIGN_AUTHOR_SAMPLE_MIN) {
				foreignAuthorRatio = await computeForeignAuthorRatio(git, opts.repo, p1, cursor, await getLocalAuthors());
			}
			const cls = classifyMergeClass({
				subject: meta.subject,
				branchCommitCount,
				markerTouched,
				foreignAuthorRatio,
				override,
				upstream: config.upstream,
				maxBranchCommits: config.story.maxBranchCommits,
			});
			const branchShas = await listBranchShas(git, opts.repo, p1, cursor);
			units.push({
				sha: cursor,
				parents,
				subject: meta.subject,
				class: cls,
				side,
				position: units.length,
				branchShas,
			});
			if (cursor === historyFloor) return;
			cursor = p1;
		}
	};

	await walkChain(startSha, "main");
	while (pendingSideRoots.length > 0 && budget.remaining > 0) {
		const root = pendingSideRoots.shift();
		if (root) await walkChain(root, "side");
	}
	return units;
}

const CHANGELOG_SECTIONS: readonly string[] = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];
const COMMIT_MARKER = "\x01REELS-COMMIT\x01";

export interface ChangelogAnchor {
	entryText: string;
	section: string;
	/** Package names from `packages/<pkg>/CHANGELOG.md`, or `"root"` for the top-level changelog. */
	packages: string[];
	commitSha: string;
	/** The subject of `commitSha`, carried along so callers can filter without a second git call (e.g. {@link isReleaseCutCommit}). */
	commitSubject: string;
	/** The owning {@link MainlineUnit.sha}: the commit itself, or the merge sha if it is a folded branch commit. */
	unitId: string;
}

export interface FindChangelogAnchorsOptions {
	repo: string;
	/** A `git log` revision range, e.g. `"<fromSha>..<toSha>"` or `"<toSha>"`. */
	range: string;
	git?: GitRunner;
}

interface RawAnchor {
	entryText: string;
	section: string;
	pkg: string;
	commitSha: string;
	commitSubject: string;
}

function splitCommitBlocks(raw: string): Array<{ sha: string; subject: string; body: string }> {
	return raw
		.split(COMMIT_MARKER)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const newlineIdx = chunk.indexOf("\n");
			const header = newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx);
			const body = newlineIdx === -1 ? "" : chunk.slice(newlineIdx + 1);
			const nulIdx = header.indexOf("\x00");
			const sha = nulIdx === -1 ? header.trim() : header.slice(0, nulIdx).trim();
			const subject = nulIdx === -1 ? "" : header.slice(nulIdx + 1).trim();
			return { sha, subject, body };
		});
}

function splitFileDiffs(diffText: string): Array<{ path: string; body: string }> {
	const lines = diffText.split("\n");
	const blocks: Array<{ path: string; body: string }> = [];
	let currentPath: string | undefined;
	let current: string[] = [];
	const flush = () => {
		if (currentPath && current.length > 0) blocks.push({ path: currentPath, body: current.join("\n") });
	};
	for (const line of lines) {
		const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
		if (match) {
			flush();
			currentPath = match[2];
			current = [];
		} else if (currentPath) {
			current.push(line);
		}
	}
	flush();
	return blocks;
}

function packageFromChangelogPath(path: string): string | undefined {
	if (path === "CHANGELOG.md") return "root";
	const match = path.match(/^packages\/([^/]+)\/CHANGELOG\.md$/);
	return match ? match[1] : undefined;
}

/** Scans one file's `-U1000` diff for added bullets under `## [...]` / `### <section>` headings. */
function extractAddedEntries(diffBody: string): Array<{ entryText: string; section: string }> {
	const entries: Array<{ entryText: string; section: string }> = [];
	let inVersionSection = false;
	let currentSection: string | undefined;

	for (const line of diffBody.split("\n")) {
		if (line.startsWith("@@") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
			continue;
		}
		if (!/^[ +-]/.test(line)) continue;
		const marker = line[0];
		const trimmed = line.slice(1).trim();

		if (/^##\s*\[/.test(trimmed)) {
			inVersionSection = true;
			currentSection = undefined;
			continue;
		}
		if (trimmed.startsWith("## ")) {
			inVersionSection = false;
			currentSection = undefined;
			continue;
		}
		const sectionMatch = trimmed.match(/^###\s+(.+)$/);
		if (sectionMatch) {
			const name = sectionMatch[1]?.trim() ?? "";
			currentSection = CHANGELOG_SECTIONS.includes(name) ? name : undefined;
			continue;
		}

		if (marker !== "+" || !inVersionSection || !currentSection) continue;
		const bulletMatch = trimmed.match(/^-\s+(.*)$/);
		if (!bulletMatch) continue;
		const entryText = (bulletMatch[1] ?? "").trim();
		if (entryText) entries.push({ entryText, section: currentSection });
	}

	return entries;
}

function dedupeAnchors(
	raw: RawAnchor[],
): Array<{ entryText: string; section: string; packages: string[]; commitSha: string; commitSubject: string }> {
	const byKey = new Map<
		string,
		{ entryText: string; section: string; packages: Set<string>; commitSha: string; commitSubject: string }
	>();
	for (const anchor of raw) {
		const key = `${anchor.commitSha}\u0000${anchor.section}\u0000${anchor.entryText}`;
		const existing = byKey.get(key);
		if (existing) existing.packages.add(anchor.pkg);
		else {
			byKey.set(key, {
				entryText: anchor.entryText,
				section: anchor.section,
				packages: new Set([anchor.pkg]),
				commitSha: anchor.commitSha,
				commitSubject: anchor.commitSubject,
			});
		}
	}
	return Array.from(byKey.values()).map((v) => ({
		entryText: v.entryText,
		section: v.section,
		packages: Array.from(v.packages).sort(),
		commitSha: v.commitSha,
		commitSubject: v.commitSubject,
	}));
}

function buildUnitOwnerMap(units: readonly MainlineUnit[]): Map<string, string> {
	const owner = new Map<string, string>();
	for (const unit of units) {
		owner.set(unit.sha, unit.sha);
		for (const branchSha of unit.branchShas ?? []) owner.set(branchSha, unit.sha);
	}
	return owner;
}

/**
 * Finds changelog anchors (owner decision Q1): each Added/Changed/Fixed/
 * Breaking Changes/Removed entry added under `## [Unreleased]` or a version
 * heading, in any package's `CHANGELOG.md` or the root one, mapped to the
 * commit that added that exact line. One `git log -p --reverse` pass over
 * the changelog paths, not one process per entry.
 * Entries with identical text in the same section added by the same commit
 * (e.g. duplicated across package changelogs) collapse into one anchor.
 */
export async function findChangelogAnchors(
	units: readonly MainlineUnit[],
	opts: FindChangelogAnchorsOptions,
): Promise<ChangelogAnchor[]> {
	const git = opts.git ?? runGit;
	const out = await git(
		[
			"log",
			"-p",
			"--reverse",
			"--unified=1000",
			`--format=${COMMIT_MARKER}%H%x00%s`,
			"--end-of-options",
			opts.range,
			"--",
			"CHANGELOG.md",
			"packages/*/CHANGELOG.md",
		],
		opts.repo,
	);

	const owner = buildUnitOwnerMap(units);
	const raw: RawAnchor[] = [];

	for (const { sha, subject, body } of splitCommitBlocks(out)) {
		const commitSha = assertValidSha(sha);
		for (const fileDiff of splitFileDiffs(body)) {
			const pkg = packageFromChangelogPath(fileDiff.path);
			if (!pkg) continue;
			for (const entry of extractAddedEntries(fileDiff.body)) {
				raw.push({ ...entry, pkg, commitSha, commitSubject: subject });
			}
		}
	}

	return dedupeAnchors(raw).map((anchor) => ({
		...anchor,
		unitId: owner.get(anchor.commitSha) ?? anchor.commitSha,
	}));
}

/**
 * True for the automated commit that cuts a release (`draht-release[bot]`,
 * subject `release: <version>`). On draht-mono that commit rewrites almost
 * all of `## [Unreleased]` into the new version heading wholesale (observed:
 * 446 insertions / 53 deletions for one package in one release) rather than
 * moving lines verbatim, so most of its "added" bullets are a reworded
 * restatement of a feature already captured by an earlier anchor in the
 * same range, not a new one.
 */
export function isReleaseCutCommit(subject: string): boolean {
	return /^release:\s/.test(subject);
}

/**
 * Narrows raw {@link findChangelogAnchors} output to roughly "one anchor per
 * real feature": drops anchors whose owning unit is an upstream sync (or
 * sits on its side chain — those are covered by the sync recap reel, D2/Q2)
 * and anchors added by the release-cut commit itself ({@link
 * isReleaseCutCommit}), since on draht-mono's history that commit accounts
 * for the large majority of raw anchors (94% in a spot check) by restating
 * entries an earlier commit in the same range already anchored. Pure: takes
 * exactly the data `findChangelogAnchors` already returns.
 */
export function filterFeatureAnchors(
	anchors: readonly ChangelogAnchor[],
	units: readonly MainlineUnit[],
): ChangelogAnchor[] {
	const unitBySha = new Map(units.map((unit) => [unit.sha, unit]));
	return anchors.filter((anchor) => {
		if (isReleaseCutCommit(anchor.commitSubject)) return false;
		const unit = unitBySha.get(anchor.unitId);
		if (unit?.class === "upstream-sync") return false;
		if (unit?.side === "side") return false;
		return true;
	});
}
