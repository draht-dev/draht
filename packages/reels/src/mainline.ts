/**
 * Classifies the commits inside one git revision range ("a release set", in
 * `releases.ts`'s terms) into {@link MainlineUnit}s: merges (their branch
 * commits folded in, innermost merge wins when merges nest) and direct
 * commits owned by no merge.
 *
 * Range-based, not walk-order-based (redesign, 2026-10-05): the previous
 * design walked first-parent history and swapped to a back-merge's second
 * parent to find "the real mainline", classifying every unit it swapped
 * away from as a "side" line that was then treated as upstream. That made
 * ownership depend on which parent the walk happened to prefer: upstream
 * commits unowned by any merge in a normal (bounded) scan became
 * mis-classified "features", a subject-pattern swap could put a draht
 * feature branch on the "side" where it was then wrongly recapped as
 * upstream, and a bounded scan's side chain landed in the oldest release it
 * reached rather than its own. Fixed by classifying every unit from its own
 * signals only, over an exact commit set defined by two tags (or a tag and
 * `ref`), never by which parent a walk preferred.
 *
 * Security: every revision used in a `git` call is either resolved from
 * validated commit output ({@link assertValidSha}) or a config-controlled
 * literal (`refs/tags`, a pathspec, a `^`-prefixed validated sha). Commit
 * subjects and bodies are read-only classification/anchor input: they are
 * matched with regexes or split in JS, never passed to `git` as an argument,
 * and record separators used to split multi-commit `git log` output are NUL
 * bytes, which git refuses inside a commit's own content — so no subject or
 * body can forge a fake record boundary (a leading `\x01` marker could not
 * make this guarantee, since `\x01` is ordinary commit-message text).
 */

import { assertValidSha, type GitRunner, listShas, runGit } from "./collect.ts";
import { DEFAULT_REELS_CONFIG, type MergeOverride, type ReelsConfig, type UpstreamConfig } from "./reels-config.ts";

export type MergeClass = "feature" | "upstream-sync" | "back-merge" | "oversized" | "branch-sync";
export type UnitClass = "commit" | MergeClass;

export interface MainlineUnit {
	sha: string;
	parents: string[];
	subject: string;
	class: UnitClass;
	/** Index in this unit list, newest first. Display/ordering only — ownership and release mapping never depend on it. */
	position: number;
	/** For merges only: the folded branch commits owned by this merge (no nested merge owns them more closely), oldest first. */
	branchShas?: string[];
}

export const DEFAULT_MAINLINE_SCAN = 500;

/** Below this many branch commits, an author-ratio sample is too small to trust (D2). */
const FOREIGN_AUTHOR_SAMPLE_MIN = 20;
/** "the last 200 non-merge mainline commits" (D2). */
const LOCAL_AUTHOR_WINDOW = 200;
/** Subject regexes never run on more than this many characters of a subject. */
const MAX_SUBJECT_CHARS = 512;

const BACK_MERGE_SUBJECT_PATTERNS: readonly RegExp[] = [
	/^Merge (?:remote-tracking )?branch '(?:main|master)'(?: of \S+)? into /i,
	/^merge (?:origin\/)?main into /i,
	/^Merge origin\/main into /i,
	/bring .*\bmain\b.* into /i,
];

/** True when `subject` announces "main merged into a branch" (D1): kept informational only — it never changes ownership or marks anything upstream. */
export function isBackMergeSubject(subject: string): boolean {
	const truncated = subject.slice(0, MAX_SUBJECT_CHARS);
	return BACK_MERGE_SUBJECT_PATTERNS.some((re) => re.test(truncated));
}

/**
 * Subjects that announce a branch-sync merge (one branch catching up with
 * another, e.g. "merge: sync with origin/main (…)" or a remote-tracking
 * branch merge of `.../main` or `.../master`) in wording the back-merge
 * patterns above do not already cover. A branch-sync merge is not an
 * upstream pi sync (it carries no recap-worthy upstream work, just draht's
 * own branches catching up with each other), so {@link classifyMergeClass}
 * gives it its own `branch-sync` class rather than folding it into
 * `upstream-sync`: `upstream-sync` units each get a recap reel (one per pi
 * sync), and a branch sync would wrongly produce one.
 */
const BRANCH_SYNC_SUBJECT_PATTERNS: readonly RegExp[] = [
	/^merge:\s*sync with \S+\/(?:main|master)\b/i,
	/^Merge remote-tracking branch '[^']*\/(?:main|master)'/i,
];

/** True for a branch-sync merge subject not already caught by {@link isBackMergeSubject}. */
export function isBranchSyncSubject(subject: string): boolean {
	const truncated = subject.slice(0, MAX_SUBJECT_CHARS);
	return BRANCH_SYNC_SUBJECT_PATTERNS.some((re) => re.test(truncated));
}

export interface ClassifyMergeInput {
	subject: string;
	/** Branch commits owned by this merge, excluding the merge itself. */
	branchCommitCount: number;
	markerTouched: boolean;
	/** Undefined when the branch is smaller than {@link FOREIGN_AUTHOR_SAMPLE_MIN}. */
	foreignAuthorRatio?: number;
	override?: MergeOverride;
	upstream: UpstreamConfig;
	maxBranchCommits: number;
}

/** Classifies one merge from its own signals only (redesign: no parent swap, no "side means upstream"). Pure: all git-derived facts are passed in. */
export function classifyMergeClass(input: ClassifyMergeInput): MergeClass {
	if (
		input.override === "feature" ||
		input.override === "upstream-sync" ||
		input.override === "branch-sync" ||
		input.override === "back-merge"
	) {
		return input.override;
	}

	const subject = input.subject.slice(0, MAX_SUBJECT_CHARS);
	if (isBackMergeSubject(subject)) return "back-merge";
	if (isBranchSyncSubject(subject)) return "branch-sync";

	const subjectMatches = input.upstream.subjectPatterns.some((pattern) => new RegExp(pattern, "i").test(subject));
	const foreignDominated =
		input.foreignAuthorRatio !== undefined && input.foreignAuthorRatio > input.upstream.foreignAuthorRatio;
	if (subjectMatches || input.markerTouched || foreignDominated) return "upstream-sync";

	if (input.branchCommitCount > input.maxBranchCommits) return "oversized";
	return "feature";
}

/**
 * True for draht's convention of replaying one upstream commit directly onto
 * the mainline (`upstream: feat(x): ...`), as opposed to folding a whole
 * sync branch into a merge. A unit-ownership check alone misses these: the
 * commit is its own, ordinary direct commit, not a branch commit of any
 * `upstream-sync` merge.
 */
export function isUpstreamCarriedSubject(subject: string): boolean {
	return /^upstream:\s/i.test(subject.slice(0, MAX_SUBJECT_CHARS));
}

interface RawCommitNode {
	sha: string;
	parents: string[];
}

/** One `git rev-list --topo-order --parents` call: the exact set of a revision range, newest first, with full parent lists (octopus merges included). */
async function listRangeCommits(git: GitRunner, repo: string, revisions: readonly string[]): Promise<RawCommitNode[]> {
	const out = await git(["rev-list", "--topo-order", "--parents", "--end-of-options", ...revisions], repo);
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [sha, ...parents] = line.split(" ").filter(Boolean);
			return { sha: assertValidSha(sha ?? ""), parents: parents.map(assertValidSha) };
		});
}

interface CommitMeta {
	sha: string;
	authorName: string;
	subject: string;
	body: string;
}

// `execFile` rejects a literal NUL byte inside an argv string outright, so
// the `--format` argument itself must spell the separator with git's own
// `%x00` escape (plain ASCII text in argv); the escape only becomes a real
// NUL byte in git's OUTPUT, which is what `METADATA_RECORD_SEP` below
// actually splits on.
const METADATA_RECORD_SEP_FORMAT = "%x00%x00RECORD%x00%x00";
const METADATA_RECORD_SEP = "\x00\x00RECORD\x00\x00";

/**
 * One `git log --format` call per release for commit metadata (D redesign):
 * NUL-based record separators, body last. Git refuses a literal NUL byte
 * inside a commit's own content, so no subject or body can forge a fake
 * record boundary — unlike the previous `\x01` marker, which is ordinary
 * commit-message text.
 */
async function listRangeMetadata(
	git: GitRunner,
	repo: string,
	revisions: readonly string[],
): Promise<Map<string, CommitMeta>> {
	const format = [METADATA_RECORD_SEP_FORMAT, "%H", "%an", "%s", "%b"].join("%x00");
	const out = await git(["log", `--format=${format}`, "--end-of-options", ...revisions], repo);
	const result = new Map<string, CommitMeta>();
	for (const record of out.split(METADATA_RECORD_SEP)) {
		if (!record.trim()) continue;
		const fields = record.split("\x00");
		// fields[0] is the empty string before the leading separator's own "\x00".
		const sha = assertValidSha((fields[1] ?? "").trim());
		const authorName = fields[2] ?? "";
		const subject = fields[3] ?? "";
		const body = fields.slice(4).join("\x00").replace(/\n+$/, "");
		result.set(sha, { sha, authorName, subject, body });
	}
	return result;
}

function ancestorsWithinSet(
	start: string,
	memberSet: ReadonlySet<string>,
	parentsOf: Map<string, string[]>,
): Set<string> {
	const seen = new Set<string>();
	if (!memberSet.has(start)) return seen;
	const stack = [start];
	while (stack.length > 0) {
		const sha = stack.pop();
		if (!sha || seen.has(sha)) continue;
		seen.add(sha);
		for (const parent of parentsOf.get(sha) ?? []) {
			if (memberSet.has(parent) && !seen.has(parent)) stack.push(parent);
		}
	}
	return seen;
}

/** `M^1..Mi` ∩ set, unioned over every parent after the first (octopus merges included). */
function rawBranchSet(
	merge: RawCommitNode,
	memberSet: ReadonlySet<string>,
	parentsOf: Map<string, string[]>,
): Set<string> {
	const [p1, ...rest] = merge.parents;
	const firstAncestors = p1 ? ancestorsWithinSet(p1, memberSet, parentsOf) : new Set<string>();
	const branch = new Set<string>();
	for (const p of rest) {
		for (const sha of ancestorsWithinSet(p, memberSet, parentsOf)) {
			if (sha !== merge.sha && !firstAncestors.has(sha)) branch.add(sha);
		}
	}
	return branch;
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

export interface BuildRangeUnitsOptions {
	repo: string;
	/** `git rev-list`/`git log` revision arguments, e.g. `[tagSha, "^" + prevTagSha]`. */
	revisions: readonly string[];
	config?: ReelsConfig;
	git?: GitRunner;
	/** Caps the number of rev-list entries considered (newest first), for callers without a release boundary of their own. Omit for an exact release range. */
	limit?: number;
}

/**
 * Classifies every commit in `revisions`' exact set into {@link
 * MainlineUnit}s: one `git rev-list --topo-order --parents` call defines
 * the set and its parent graph, one `git log --format` call reads metadata,
 * and ownership/classification run in memory from there — no `git` call per
 * unit.
 */
export async function buildRangeUnits(opts: BuildRangeUnitsOptions): Promise<MainlineUnit[]> {
	const git = opts.git ?? runGit;
	const config = opts.config ?? DEFAULT_REELS_CONFIG;

	const allNodes = await listRangeCommits(git, opts.repo, opts.revisions);
	const nodes = opts.limit !== undefined ? allNodes.slice(0, opts.limit) : allNodes;
	if (nodes.length === 0) return [];

	const memberSet = new Set(nodes.map((n) => n.sha));
	const parentsOf = new Map(nodes.map((n) => [n.sha, n.parents]));
	const metaBySha = await listRangeMetadata(git, opts.repo, opts.revisions);

	const merges = nodes.filter((n) => n.parents.length > 1);

	// A back-merge (main merged into a branch) is informational only: it must
	// not change ownership, so it never claims a branch range. Determined the
	// same way `classifyMergeClass` would (override, else subject), but ahead
	// of branch-size classification since ownership is what produces that size.
	const isBackMergeNode = (node: RawCommitNode): boolean => {
		const override = config.overrides[node.sha];
		if (override) return override === "back-merge";
		return isBackMergeSubject(metaBySha.get(node.sha)?.subject ?? "");
	};
	const claimingMerges = merges.filter((m) => !isBackMergeNode(m));

	const rawSets = new Map(claimingMerges.map((m) => [m.sha, rawBranchSet(m, memberSet, parentsOf)]));

	// Innermost merge wins: of every merge whose raw M1..Mi range contains a
	// given non-merge commit, the one with the smallest raw range is the
	// closest-nesting one, so it owns the commit.
	const ownerOf = new Map<string, { sha: string; size: number }>();
	for (const [mergeSha, set] of rawSets) {
		const size = set.size;
		for (const sha of set) {
			if (!memberSet.has(sha) || merges.some((m) => m.sha === sha)) continue;
			const existing = ownerOf.get(sha);
			if (!existing || size < existing.size) ownerOf.set(sha, { sha: mergeSha, size });
		}
	}

	const branchShasByMerge = new Map<string, string[]>();
	for (const [sha, owner] of ownerOf) {
		const list = branchShasByMerge.get(owner.sha) ?? [];
		list.push(sha);
		branchShasByMerge.set(owner.sha, list);
	}
	// Oldest first, matching position order within the owning merge's own branch.
	const positionInNodes = new Map(nodes.map((n, i) => [n.sha, i]));
	for (const list of branchShasByMerge.values()) {
		list.sort((a, b) => (positionInNodes.get(b) ?? 0) - (positionInNodes.get(a) ?? 0));
	}

	let localAuthors: Set<string> | undefined;
	const getLocalAuthors = async (): Promise<Set<string>> => {
		if (!localAuthors) localAuthors = await collectLocalAuthorSet(git, opts.repo, nodes[0]?.sha ?? "HEAD");
		return localAuthors;
	};

	const units: MainlineUnit[] = [];
	for (const node of nodes) {
		const meta = metaBySha.get(node.sha);
		const subject = meta?.subject ?? "";

		if (node.parents.length <= 1) {
			if (ownerOf.has(node.sha)) continue; // folded into a merge's branchShas, not a top-level unit
			units.push({ sha: node.sha, parents: node.parents, subject, class: "commit", position: units.length });
			continue;
		}

		const branchShas = branchShasByMerge.get(node.sha) ?? [];
		const override = config.overrides[node.sha];
		const p1 = node.parents[0];
		let markerTouched = false;
		let foreignAuthorRatio: number | undefined;
		if (p1 && config.upstream.markerPaths.length > 0) {
			markerTouched = await diffTouchesPaths(git, opts.repo, p1, node.sha, config.upstream.markerPaths);
		}
		if (branchShas.length >= FOREIGN_AUTHOR_SAMPLE_MIN) {
			const authors = branchShas.map((sha) => metaBySha.get(sha)?.authorName ?? "").filter(Boolean);
			const local = await getLocalAuthors();
			const foreign = authors.filter((author) => !local.has(author)).length;
			foreignAuthorRatio = authors.length > 0 ? foreign / authors.length : 0;
		}

		const cls = classifyMergeClass({
			subject,
			branchCommitCount: branchShas.length,
			markerTouched,
			foreignAuthorRatio,
			override,
			upstream: config.upstream,
			maxBranchCommits: config.story.maxBranchCommits,
		});

		units.push({
			sha: node.sha,
			parents: node.parents,
			subject,
			class: cls,
			position: units.length,
			branchShas,
		});
	}

	return units;
}

export interface WalkMainlineOptions {
	repo: string;
	ref: string;
	/** Caps the number of rev-list entries scanned, newest first. Ignored when `allHistory`. */
	scan?: number;
	allHistory?: boolean;
	/** Unused by the walk itself (kept for API compatibility with callers that still pass it; release boundaries are computed by `releases.ts`, not here). */
	tagPattern?: string | RegExp;
	/** Overrides `config.historyFloor`. A tag or sha; resolved the same way `ref` is. */
	historyFloor?: string;
	config?: ReelsConfig;
	git?: GitRunner;
}

/**
 * Convenience wrapper over {@link buildRangeUnits} for callers that just
 * want "every unit reachable from `ref`" with no release boundaries of
 * their own (`prune`'s reachability set, and tests that exercise
 * classification directly). Reduced from the previous walk-order design
 * (redesign, 2026-10-05): no first-parent walk, no back-merge parent swap,
 * no side chains — `git rev-list` already follows every parent, so a commit
 * behind a back-merge's first parent is reachable without any of that.
 */
export async function walkMainline(opts: WalkMainlineOptions): Promise<MainlineUnit[]> {
	const git = opts.git ?? runGit;
	const config = opts.config ?? DEFAULT_REELS_CONFIG;
	const historyFloorRef = opts.historyFloor ?? config.historyFloor;

	const [refSha] = await listShas(git, opts.repo, opts.ref, { limit: 1 });
	if (!refSha) return [];
	const historyFloorSha = historyFloorRef
		? (await listShas(git, opts.repo, historyFloorRef, { limit: 1 }))[0]
		: undefined;

	const revisions = [refSha, ...(historyFloorSha ? [`^${historyFloorSha}`] : [])];
	const limit = opts.allHistory ? undefined : (opts.scan ?? DEFAULT_MAINLINE_SCAN);
	return buildRangeUnits({ repo: opts.repo, revisions, config, git, limit });
}

const CHANGELOG_SECTIONS: readonly string[] = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];
/** Argv-safe form of {@link CHANGELOG_RECORD_SEP} for the `--format` argument — see {@link METADATA_RECORD_SEP_FORMAT}. */
const CHANGELOG_RECORD_SEP_FORMAT = "%x00%x00RECORD%x00%x00";
const CHANGELOG_RECORD_SEP = "\x00\x00RECORD\x00\x00";

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
		.split(CHANGELOG_RECORD_SEP)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const fields = chunk.split("\x00");
			return { sha: (fields[0] ?? "").trim(), subject: fields[1] ?? "", body: fields.slice(2).join("\x00") };
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
 * the changelog paths, not one process per entry. NUL-based record
 * separators (redesign: a subject can contain `\x01`, so that byte can
 * never delimit a record safely — a NUL can, since git refuses one inside a
 * commit's own content).
 *
 * An anchor's `unitId` is resolved against `units`; when `commitSha` is not
 * a member of the release set `units` describes (a forged or out-of-range
 * sha), the anchor is discarded rather than falling back to `commitSha`
 * itself as its own owner.
 * Entries with identical text in the same section added by the same commit
 * (e.g. duplicated across package changelogs) collapse into one anchor.
 */
export async function findChangelogAnchors(
	units: readonly MainlineUnit[],
	opts: FindChangelogAnchorsOptions,
): Promise<ChangelogAnchor[]> {
	const git = opts.git ?? runGit;
	// `range` may be a single `a..b` token or several space-separated revision
	// args (e.g. `"tagSha ^prevTagSha ^floorSha"`, as `releases.ts` builds it);
	// splitting on whitespace is safe since every token is a sha or a
	// `^`-prefixed sha, never attacker-controlled text.
	const revisions = opts.range.split(/\s+/).filter(Boolean);
	const out = await git(
		[
			"log",
			"-p",
			"--reverse",
			"--unified=1000",
			`--format=${CHANGELOG_RECORD_SEP_FORMAT}%H%x00%s%x00`,
			"--end-of-options",
			...revisions,
			"--",
			"CHANGELOG.md",
			"packages/*/CHANGELOG.md",
		],
		opts.repo,
	);

	const owner = buildUnitOwnerMap(units);
	const raw: RawAnchor[] = [];

	for (const { sha, subject, body } of splitCommitBlocks(out)) {
		if (!owner.has(sha)) continue; // not a member of this release set: discarded, never falls back to itself
		const commitSha = assertValidSha(sha);
		for (const fileDiff of splitFileDiffs(body)) {
			const pkg = packageFromChangelogPath(fileDiff.path);
			if (!pkg) continue;
			for (const entry of extractAddedEntries(fileDiff.body)) {
				raw.push({ ...entry, pkg, commitSha, commitSubject: subject });
			}
		}
	}

	return dedupeAnchors(raw).map((anchor) => ({ ...anchor, unitId: owner.get(anchor.commitSha) ?? anchor.commitSha }));
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
	return /^release:\s/.test(subject.slice(0, MAX_SUBJECT_CHARS));
}

/**
 * Narrows raw {@link findChangelogAnchors} output to roughly "one anchor per
 * real feature": drops anchors whose owning unit is an upstream sync, whose
 * owning commit's own subject is `upstream:`-prefixed ({@link
 * isUpstreamCarriedSubject}), and anchors added by the release-cut commit
 * itself ({@link isReleaseCutCommit}), since on draht-mono's history that
 * commit accounts for the large majority of raw anchors (94% in a spot
 * check) by restating entries an earlier commit in the same range already
 * anchored. Pure: takes exactly the data `findChangelogAnchors` already
 * returns.
 *
 * Deliberately NOT dropped: anchors owned by a `branch-sync` unit. Unlike an
 * `upstream-sync` merge, a branch-sync merge carries no upstream work at
 * all — its branch commits are draht's own, just caught up from another of
 * draht's own branches — so an anchor it owns is a real feature and is
 * routed like any other direct commit's anchor, not dropped or recapped.
 */
export function filterFeatureAnchors(
	anchors: readonly ChangelogAnchor[],
	units: readonly MainlineUnit[],
): ChangelogAnchor[] {
	const unitBySha = new Map(units.map((unit) => [unit.sha, unit]));
	return anchors.filter((anchor) => {
		if (isReleaseCutCommit(anchor.commitSubject)) return false;
		if (isUpstreamCarriedSubject(anchor.commitSubject)) return false;
		const unit = unitBySha.get(anchor.unitId);
		if (unit?.class === "upstream-sync") return false;
		return true;
	});
}
