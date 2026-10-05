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
 * branch's story rather than duplicated as a second one. A `branch-sync`
 * merge (one draht branch catching up with another, not an upstream sync)
 * is itself skipped — it is neither a story nor a recap — but an anchor it
 * owns is routed like a direct commit's: it can still become its own story,
 * since the branch commits underneath it are draht's own work.
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

/** Entry text, subjects, and bodies the identifier/exact-match stage ever looks at are capped here, before any regex runs on them. */
export const MAX_ENTRY_TEXT_BYTES = 16 * 1024;

/** Common English words and abbreviations that match an identifier pattern syntactically (slash, dots) but never name real code. */
const IDENTIFIER_STOPLIST: ReadonlySet<string> = new Set([
	"e.g",
	"e.g.",
	"i.e",
	"i.e.",
	"and/or",
	"read/write",
	"input/output",
	"on/off",
	"true",
	"false",
	"null",
	"undefined",
	"id",
	"node.js",
]);

const MIN_IDENTIFIER_LENGTH = 4;

/** Whether `raw` itself carries code shape, independent of which pattern matched it (a backtick always counts). */
function isCodeShaped(raw: string, backticked: boolean): boolean {
	if (backticked) return true;
	if (/^--/.test(raw)) return true;
	if (/^\//.test(raw)) return true;
	if (/[_./]/.test(raw)) return true;
	return /[a-z][A-Z]/.test(raw); // camelCase
}

/**
 * Extracts candidate identifiers from one changelog entry's text (T1
 * amendment, strengthened in the fix round): a stoplist drops common prose
 * that matches an identifier pattern syntactically, a minimum length of
 * {@link MIN_IDENTIFIER_LENGTH} drops noise like `"id"`, and every survivor
 * must independently look code-shaped ({@link isCodeShaped}) — otherwise a
 * capitalized proper noun or a two-word slash phrase could pass as a
 * "symbol" and send the pickaxe search chasing prose. Pure, order-stable,
 * deduped, capped at `max`. `entryText` is capped at {@link
 * MAX_ENTRY_TEXT_BYTES} before any regex runs on it.
 */
export function extractIdentifiers(entryText: string, max: number = DEFAULT_MAX_IDENTIFIERS): string[] {
	const text = entryText.slice(0, MAX_ENTRY_TEXT_BYTES);
	const seen = new Set<string>();
	for (const pattern of IDENTIFIER_PATTERNS) {
		const backticked = pattern.source.startsWith("`");
		for (const match of text.matchAll(pattern)) {
			const raw = (match[1] ?? match[0]).trim();
			if (raw.length < MIN_IDENTIFIER_LENGTH) continue;
			if (IDENTIFIER_STOPLIST.has(raw.toLowerCase())) continue;
			if (!isCodeShaped(raw, backticked)) continue;
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

/** `range` may be a single `a..b` token or several space-separated revision args (e.g. `"tagSha ^prevTagSha ^floorSha"`, as `releases.ts` builds it); every token is a sha or a `^`-prefixed sha, never attacker-controlled text. */
function splitRevisionArgs(range: string): string[] {
	return range.split(/\s+/).filter(Boolean);
}

async function searchIdentifier(
	git: GitRunner,
	repo: string,
	range: string,
	pathspecs: readonly string[],
	identifier: string,
): Promise<ImplementingCommit[]> {
	const out = await git(
		[
			"log",
			"--reverse",
			`-S${identifier}`,
			"--format=%H%x00%s",
			"--end-of-options",
			...splitRevisionArgs(range),
			"--",
			...pathspecs,
		],
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

function normalizeForExactMatch(text: string): string {
	return text.toLowerCase().replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Strips a conventional-commit `type(scope): ` prefix, since that prefix is never part of a changelog entry's own wording. */
function stripConventionalPrefix(subject: string): string {
	return subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "");
}

const MIN_EXACT_MATCH_LENGTH = 12;

/** True when two already-normalized strings are the same sentence, or one contains the other verbatim (both sides long enough to rule out a coincidental short match). */
function isExactOrNearMatch(a: string, b: string): boolean {
	if (a.length < MIN_EXACT_MATCH_LENGTH || b.length < MIN_EXACT_MATCH_LENGTH) return false;
	if (a === b) return true;
	return a.includes(b) || b.includes(a);
}

export interface ExactMatchCandidate {
	sha: string;
	subject: string;
	body: string;
}

interface NormalizedCandidate {
	subject: string;
	body: string;
}

/**
 * {@link findExactSubjectMatch} is called once per changelog anchor against
 * the same, range-wide `candidates` array (`collectStories` fetches a
 * range's commits once and reuses that array for every anchor in it), so
 * normalizing a candidate's subject/body is cached by object identity here
 * instead of being redone for every anchor — the difference between O(anchors
 * + commits) and O(anchors * commits) normalization work over a range.
 */
const normalizedCandidateCache = new WeakMap<ExactMatchCandidate, NormalizedCandidate>();

function normalizedCandidate(candidate: ExactMatchCandidate): NormalizedCandidate {
	const cached = normalizedCandidateCache.get(candidate);
	if (cached) return cached;
	const computed: NormalizedCandidate = {
		subject: normalizeForExactMatch(stripConventionalPrefix(candidate.subject)),
		body: normalizeForExactMatch(candidate.body.slice(0, MAX_ENTRY_TEXT_BYTES)),
	};
	normalizedCandidateCache.set(candidate, computed);
	return computed;
}

/**
 * Looks for a release-range commit whose subject or body already states the
 * changelog entry's own wording near-verbatim (fix round: tried before any
 * pickaxe process is spawned). A hit here is unambiguous enough to skip
 * identifier extraction and pickaxe search entirely.
 */
export function findExactSubjectMatch(
	entryText: string,
	candidates: readonly ExactMatchCandidate[],
): ImplementingCommit[] {
	const text = normalizeForExactMatch(entryText.slice(0, MAX_ENTRY_TEXT_BYTES));
	for (const candidate of candidates) {
		const { subject, body } = normalizedCandidate(candidate);
		if (isExactOrNearMatch(text, subject) || isExactOrNearMatch(text, body)) {
			return [{ sha: candidate.sha, subject: candidate.subject }];
		}
	}
	return [];
}

export const DEFAULT_MAX_PICKAXE_PER_RUN = 200;

/** Shared, mutable pickaxe-process budget across one `collectStories` run, independent of the per-story {@link FindImplementingCommitsOptions.maxProcesses} cap. */
export interface PickaxeBudget {
	remaining: number;
}

export function createPickaxeBudget(max: number = DEFAULT_MAX_PICKAXE_PER_RUN): PickaxeBudget {
	return { remaining: max };
}

export interface FindImplementingCommitsOptions {
	repo: string;
	/** A `git log` revision range covering the entry's release, e.g. `"<fromSha>..<toSha>"`. */
	range: string;
	packages: readonly string[];
	/** The release range's own commits (subject + body), tried for an exact/near-exact match before any pickaxe search. */
	rangeCommits?: readonly ExactMatchCandidate[];
	git?: GitRunner;
	maxIdentifiers?: number;
	/** Pickaxe processes spawned for this one entry. */
	maxProcesses?: number;
	/** Shared across every entry in the current `collectStories` run; decremented as pickaxe processes run, never exceeded even mid-entry. */
	runBudget?: PickaxeBudget;
}

/**
 * Finds the commits that likely implemented a changelog entry (T1
 * amendment): first an exact/near-exact match against `rangeCommits`
 * ({@link findExactSubjectMatch}), then (only if that finds nothing) one
 * `git log -S<id>` per extracted identifier, bounded by both `maxProcesses`
 * (this entry) and `runBudget` (the whole run), restricted to `range` and
 * the entry's package paths. Returns the top-ranked commits (most
 * identifier hits, capped at {@link MAX_IMPLEMENTING_COMMITS}, oldest first
 * on a tie), or `[]` when nothing is found.
 */
export async function findImplementingCommits(
	entryText: string,
	opts: FindImplementingCommitsOptions,
): Promise<ImplementingCommit[]> {
	const exact = findExactSubjectMatch(entryText, opts.rangeCommits ?? []);
	if (exact.length > 0) return exact;

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
		if (opts.runBudget && opts.runBudget.remaining <= 0) break;
		if (opts.runBudget) opts.runBudget.remaining--;
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
 *
 * Fix round: only `"strong"` attributions ever union through a shared
 * commit. A `"weak"` attribution's "implementing" set is just its anchor
 * commit, a fallback, not real evidence — on draht-mono a single later
 * docs/release commit can anchor many unrelated upstream-carried entries
 * (the T1 amendment's `42fdbb49c`), and merging every entry that commit
 * touches into one story would be wrong. Each weak attribution is therefore
 * always its own singleton group.
 */
export function groupOverlappingAttributions(attributions: readonly AnchorAttribution[]): AnchorAttribution[][] {
	const strongIndices: number[] = [];
	const groups: AnchorAttribution[][] = [];
	attributions.forEach((attribution, index) => {
		if (attribution.strength === "strong") strongIndices.push(index);
		else groups.push([attribution]);
	});

	const parent = new Map(strongIndices.map((i) => [i, i]));
	const find = (i: number): number => {
		let root = i;
		while (parent.get(root) !== root) root = parent.get(root) as number;
		return root;
	};
	const union = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};

	const byCommit = new Map<string, number>();
	for (const index of strongIndices) {
		for (const sha of attributions[index]?.implementing ?? []) {
			const existing = byCommit.get(sha);
			if (existing !== undefined) union(existing, index);
			else byCommit.set(sha, index);
		}
	}

	const strongGroups = new Map<number, AnchorAttribution[]>();
	for (const index of strongIndices) {
		const root = find(index);
		const attribution = attributions[index];
		if (!attribution) continue;
		const group = strongGroups.get(root);
		if (group) group.push(attribution);
		else strongGroups.set(root, [attribution]);
	}
	return [...groups, ...Array.from(strongGroups.values())];
}

// --- Story id ----------------------------------------------------------------

const STORY_ID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?(-[0-9a-f]{8})?$/;
const STORY_ID_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?/;

/** Validates a story id where it becomes a path component or an `assertValidSha`-compatible media id. */
export function isValidStoryId(id: string): boolean {
	return STORY_ID_RE.test(id);
}

/** Validates a release tag as a safe path segment (D9's `releases/<tag>` media dir, and the `release-<tag>`/`recap-<tag>` id convention below): no `../`, no `/`, no leading dot. Canonical home for this pattern; `publish.ts` re-exports it. */
export const SAFE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const RELEASE_ARTIFACT_ID_RE = /^(release|recap)-(.+)$/;

/**
 * The stable id for a release overview draft/entry: `release-<tag>`, or
 * `release-unreleased` for the still-open "Unreleased" group (matching
 * `release-writer.ts`'s own `release-${tag ?? "unreleased"}` convention).
 */
export function releaseOverviewId(tag: string): string {
	if (!SAFE_TAG_RE.test(tag)) throw new Error(`"${tag}" is not a valid release tag`);
	return `release-${tag}`;
}

/** The stable id for a pooled upstream-recap draft/entry: `recap-<tag>` (T11 finding: one recap per release, not per sync merge). */
export function recapId(tag: string): string {
	if (!SAFE_TAG_RE.test(tag)) throw new Error(`"${tag}" is not a valid release tag`);
	return `recap-${tag}`;
}

/** Validates a `release-<tag>` or `recap-<tag>` id: sibling to {@link isValidStoryId} for the other two draft/entry kinds `build`'s `release` command writes. */
export function isValidReleaseArtifactId(id: string): boolean {
	const match = RELEASE_ARTIFACT_ID_RE.exec(id);
	return match !== null && SAFE_TAG_RE.test(match[2] as string);
}

/** The tag a `release-<tag>`/`recap-<tag>` id was built from. Throws on an id that does not match either shape — callers must check {@link isValidReleaseArtifactId} first. */
export function releaseArtifactTag(id: string): string {
	const match = RELEASE_ARTIFACT_ID_RE.exec(id);
	if (!match) throw new Error(`"${id}" is not a valid release/recap id`);
	return match[2] as string;
}

/** True for any id this pipeline ever writes as a draft directory or feed entry: a story id, or a release overview / sync recap id. Use wherever a bare {@link isValidStoryId} check used to be the complete one (draft listing, approve/reject, prune). */
export function isValidDraftId(id: string): boolean {
	return isValidStoryId(id) || isValidReleaseArtifactId(id);
}

/** The sha a story id is built from, stripping any `-<hash8>` disambiguation suffix — the part every `git`/`fetchCommitMetadata` call must use instead of the raw id. */
export function storyIdSha(id: string): string {
	const match = STORY_ID_SHA_RE.exec(id);
	if (!match) throw new Error(`"${id}" is not a valid story id`);
	return match[0];
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
 * The stable story id for a branch/PR story: the merge sha, already a valid
 * `assertValidSha` id (D9's `id = head sha` media-path convention).
 */
export function computeBranchStoryId(mergeSha: string): string {
	return mergeSha;
}

/**
 * The stable story id for a changelog story (fix round): the *anchor*
 * commit sha (never the implementing commits, which can change as new
 * commits land in a still-open Unreleased range) plus a hash of the
 * grouped entry texts, so the id never changes across runs purely because a
 * later pickaxe search finds a different implementing commit. Always
 * suffixed (not just on collision): stability matters more than a shorter
 * id for this origin.
 */
export function computeChangelogStoryId(anchorSha: string, anchorTexts: readonly string[]): string {
	return `${anchorSha}-${hash8(anchorTexts.join("\u0000"))}`;
}

// --- Story collection ----------------------------------------------------------

export interface SyncRecapAnchor {
	anchor: ChangelogAnchor;
	implementing: string[];
}

export interface SkippedUnit {
	sha: string;
	reason: "oversized" | "back-merge" | "upstream-sync" | "branch-sync";
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
	/** Shared pickaxe-process budget for this run; a fresh {@link createPickaxeBudget} is used when omitted. */
	pickaxeBudget?: PickaxeBudget;
}

// `execFile` rejects a literal NUL byte in argv, so the `--format` string
// spells the trailing record separator with git's `%x00` escape (plain
// ASCII text in argv, a real NUL only in git's output) — the same pattern
// as `mainline.ts`'s `METADATA_RECORD_SEP_FORMAT`.
const RANGE_COMMIT_RECORD_SEP = "\x00\x00RECORD\x00\x00";

/** One `git log` call per distinct range, reused by every anchor in that range for the exact/near-exact match pass. */
async function fetchRangeCommits(git: GitRunner, repo: string, range: string): Promise<ExactMatchCandidate[]> {
	const out = await git(
		["log", "--format=%H%x00%s%x00%b%x00%x00RECORD%x00%x00", "--end-of-options", ...splitRevisionArgs(range)],
		repo,
	);
	return out
		.split(RANGE_COMMIT_RECORD_SEP)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => {
			const [sha, subject, ...bodyParts] = block.split("\x00");
			return { sha: assertValidSha((sha ?? "").trim()), subject: subject ?? "", body: bodyParts.join("\x00") };
		});
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

const MERGE_SUBJECT_PREFIX_RE = /^merge:\s*/i;
const MERGE_PR_SUBJECT_PREFIX_RE = /^Merge pull request #\d+ from\s+\S+\s*/i;

/**
 * A branch/PR story's title (fix round): the PR title when GitHub reports
 * one, else the merge commit's own subject minus a leading `"merge: "` or
 * `"Merge pull request #N from …"` prefix — neither of which names the
 * feature itself. Falls back to the unstripped subject when stripping would
 * leave nothing (the common no-trailing-text shape of a GitHub merge
 * commit).
 */
export function deriveBranchTitle(subject: string, prTitle?: string): string {
	if (prTitle) return prTitle;
	const stripped = subject.replace(MERGE_PR_SUBJECT_PREFIX_RE, "").replace(MERGE_SUBJECT_PREFIX_RE, "").trim();
	return stripped || subject;
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
		id: computeBranchStoryId(unit.sha),
		commits: [unit.sha, ...(unit.branchShas ?? [])].map((s) => s.slice(0, 12)),
		title: deriveBranchTitle(unit.subject, pr?.title),
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

/** The longest a {@link deriveShortTitle} result is ever allowed to be, ellipsis included. */
export const MAX_SHORT_TITLE_LENGTH = 90;

/** Split points {@link deriveShortTitle} looks for, tried left-to-right (earliest match in the text wins, not earliest in this list). */
const SHORT_TITLE_DELIMITERS = [". ", "; ", ": ", " — "];

/** The first comma at or after this offset ends the title clause too — short entries never need it, long ones usually ramble past their first idea by here. */
const SHORT_TITLE_COMMA_FLOOR = 40;

function shortTitleSplitIndex(text: string): number | null {
	let earliest = -1;
	for (const delimiter of SHORT_TITLE_DELIMITERS) {
		const index = text.indexOf(delimiter);
		if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index;
	}
	const commaIndex = text.indexOf(",");
	if (commaIndex !== -1 && commaIndex >= SHORT_TITLE_COMMA_FLOOR && (earliest === -1 || commaIndex < earliest)) {
		earliest = commaIndex;
	}
	return earliest === -1 ? null : earliest;
}

function capAtWordBoundary(text: string, max: number): string {
	if (text.length <= max) return text;
	const truncated = text.slice(0, max - 1);
	const lastSpace = truncated.lastIndexOf(" ");
	const base = (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trimEnd();
	return `${base}…`;
}

/**
 * A changelog story's title (fix round): a changelog entry's full text is
 * often several sentences and hundreds of characters, unusable as a story
 * title even though the writer still needs the full text in the story body.
 * Takes the entry's first sentence or clause — split at the earliest of
 * `". "`, `"; "`, `": "`, `" — "`, or the first comma at or after {@link
 * SHORT_TITLE_COMMA_FLOOR} — then caps the result at {@link
 * MAX_SHORT_TITLE_LENGTH} on a word boundary with `"…"`. Markdown backticks
 * are never stripped.
 */
export function deriveShortTitle(entryText: string): string {
	const text = entryText.trim();
	const splitIndex = shortTitleSplitIndex(text);
	const clause = splitIndex !== null ? text.slice(0, splitIndex).trim() : text;
	return capAtWordBoundary(clause, MAX_SHORT_TITLE_LENGTH);
}

async function buildCommitStory(
	headSha: string,
	anchorSha: string,
	anchorTexts: readonly string[],
	opts: { repo: string; git: GitRunner },
): Promise<Story> {
	const head = await fetchCommitMetadata(opts.git, opts.repo, headSha);
	const files = await fetchFileChanges(opts.git, opts.repo, headSha);
	const base = head.parents[0] ?? headSha;

	return {
		id: computeChangelogStoryId(anchorSha, anchorTexts),
		commits: [headSha.slice(0, 12)],
		title: deriveShortTitle(anchorTexts[0] ?? head.subject),
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
		} else if (unit.class === "branch-sync") {
			// The merge itself is neither a story nor a sync recap — it carries no
			// upstream work. Its branch commits are still eligible for a commit
			// story below: a branch-sync-owned anchor is handled like a direct
			// commit's, not routed to syncRecap or dropped (mainline.ts's
			// filterFeatureAnchors deliberately keeps them).
			skipped.push({ sha: unit.sha, reason: "branch-sync" });
		}
	}

	const subjectBySha = new Map<string, string>();
	const attributions: AnchorAttribution[] = [];
	const rangeCommitsByRange = new Map<string, Promise<ExactMatchCandidate[]>>();
	const pickaxeBudget = opts.pickaxeBudget ?? createPickaxeBudget();
	for (const { anchor, range } of opts.anchors ?? []) {
		const owningUnit = ownerByCommit.get(anchor.unitId);
		// A changelog entry that documents a feature merge's own branch is not a
		// second story: the merge already produced one in the loop above.
		if (owningUnit?.class === "feature") continue;

		let rangeCommits = rangeCommitsByRange.get(range);
		if (!rangeCommits) {
			rangeCommits = fetchRangeCommits(git, opts.repo, range);
			rangeCommitsByRange.set(range, rangeCommits);
		}

		const found = await findImplementingCommits(anchor.entryText, {
			repo: opts.repo,
			range,
			packages: anchor.packages,
			rangeCommits: await rangeCommits,
			git,
			maxIdentifiers: opts.maxIdentifiers,
			maxProcesses: opts.maxProcesses,
			runBudget: pickaxeBudget,
		});
		for (const commit of found) subjectBySha.set(commit.sha, commit.subject);
		const implementing = found.length > 0 ? found.map((c) => c.sha) : [anchor.commitSha];
		attributions.push({ anchor, implementing, strength: found.length > 0 ? "strong" : "weak" });
	}

	for (const group of groupOverlappingAttributions(attributions)) {
		const implementing = Array.from(new Set(group.flatMap((a) => a.implementing)));
		const owningUnits = implementing.map((sha) => ownerByCommit.get(sha));
		const upstreamCarried =
			owningUnits.some((unit) => unit?.class === "upstream-sync") ||
			implementing.some((sha) => isUpstreamCarriedSubject(subjectBySha.get(sha) ?? ""));

		if (upstreamCarried) {
			for (const { anchor, implementing: anchorImplementing } of group) {
				syncRecap.push({ anchor, implementing: anchorImplementing });
			}
			continue;
		}
		if (owningUnits.some((unit) => unit?.class === "feature")) continue;

		const anchorSha = group[0]?.anchor.commitSha;
		const headSha = group[0]?.implementing[0] ?? anchorSha;
		if (!headSha || !anchorSha) continue;

		const anchorTexts = group.map((a) => a.anchor.entryText);
		const story = await buildCommitStory(headSha, anchorSha, anchorTexts, { repo: opts.repo, git });
		stories.push(story);

		const strength: AttributionStrength = group.every((a) => a.strength === "strong") ? "strong" : "weak";
		attribution.set(story.id, strength);
	}

	return { stories, syncRecap, attribution, skipped };
}

/** One release's pooled upstream-carried material, fed to `release-writer.ts`'s `writeSyncRecap` (T11 finding). */
export interface ReleaseUpstreamPool {
	/** This release's `upstream-sync` merge units, informational (mentioned in the recap's narration, never a theme). */
	syncMerges: Array<{ sha: string; subject: string; commitCount: number }>;
	/** This release's direct `upstream: <type>(scope): ...` replay commits (`isUpstreamCarriedSubject`), the common case in draht: upstream work usually arrives this way, not inside a sync merge. */
	upstreamCommits: Array<{ sha: string; subject: string }>;
	/** The changelog anchors `collectStories` routed to `syncRecap` for this release: the actual narration material. */
	anchors: SyncRecapAnchor[];
}

/**
 * Pools one release's upstream-carried material: the `syncRecap` anchors
 * `collectStories` already routed away from story-hood (owned by an
 * `upstream-sync` merge or an `upstream:`-prefixed commit), plus the sync
 * merges and direct `upstream:` commits themselves (informational — never
 * narrated as their own reel). T11 finding: in draht, upstream changes are
 * spread over `upstream:` commits across a release, not concentrated inside
 * its sync merges, so recapping per-merge (the original owner decision Q2)
 * would mostly produce empty recaps; pooling by release is what actually has
 * material to narrate. The pool is "non-empty" — worth drafting a recap for
 * — exactly when `anchors.length > 0`: `syncMerges`/`upstreamCommits` with no
 * routed anchor carry nothing a recap could narrate (no changelog entry).
 */
export function poolReleaseUpstreamRecap(
	units: readonly MainlineUnit[],
	syncRecap: readonly SyncRecapAnchor[],
): ReleaseUpstreamPool {
	return {
		syncMerges: units
			.filter((u) => u.class === "upstream-sync")
			.map((u) => ({ sha: u.sha, subject: u.subject, commitCount: u.branchShas?.length ?? 0 })),
		upstreamCommits: units
			.filter((u) => u.class === "commit" && isUpstreamCarriedSubject(u.subject))
			.map((u) => ({ sha: u.sha, subject: u.subject })),
		anchors: [...syncRecap],
	};
}
