/**
 * Turns git history into {@link ChangeSet}s. Diff parsing is pure and
 * fixture-testable; `git` process calls live only in the `collect*`
 * functions so the parsers can be exercised without a repo on disk.
 *
 * Security: commit SHAs are never derived from commit message/body content
 * (which is attacker-controlled and can contain arbitrary bytes). They come
 * only from `git rev-list` output and are validated against {@link SHA_RE}
 * before being used in any later `git` call, and `--end-of-options` is
 * placed before every revision argument so a validated-but-adversarial-
 * looking string can never be parsed as a flag (e.g. `--output=...`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangeSet, FileChange, FileStatus, Hunk } from "./contract.ts";

const execFileAsync = promisify(execFile);

const NUL = "\x00";
const MAX_HUNK_LINES = 200;

/** A full sha1 (40 hex) or sha256 (64 hex) object id. Never matches attacker-controlled text. */
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function assertValidSha(sha: string): string {
	if (!SHA_RE.test(sha)) {
		throw new Error(`refusing to use "${sha}" as a git object id: it does not look like a real commit sha`);
	}
	return sha;
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitRunner = async (args, cwd) => {
	const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
		cwd,
		maxBuffer: 1024 * 1024 * 256,
	});
	return stdout;
};

export interface CollectOptions {
	repo: string;
	ref?: string;
	since?: string;
	until?: string;
	limit?: number;
	git?: GitRunner;
}

export interface RawCommit {
	sha: string;
	parents: string[];
	authorName: string;
	date: string;
	subject: string;
	body: string;
}

/** Lists commit shas via `git rev-list`, validating every entry before returning it. */
export async function listShas(
	git: GitRunner,
	repo: string,
	ref: string,
	options: { firstParent?: boolean; since?: string; until?: string; limit?: number } = {},
): Promise<string[]> {
	const args = ["rev-list"];
	if (options.firstParent) args.push("--first-parent");
	if (options.since) args.push(`--since=${options.since}`);
	if (options.until) args.push(`--until=${options.until}`);
	if (options.limit) args.push("-n", String(options.limit));
	args.push("--end-of-options", ref);
	const out = await git(args, repo);
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map(assertValidSha);
}

export interface FirstParentMeta {
	sha: string;
	parents: string[];
	authorName: string;
	subject: string;
}

/**
 * Reads commit sha, parents, author, and subject for up to `limit` commits
 * in one `git log --first-parent` call (newest first), instead of one
 * `git show` per commit. Used by `mainline.ts` to seed its walk; `ref` may
 * be a single revision (returns that commit as the first entry) or a range.
 */
export async function listFirstParentMeta(
	git: GitRunner,
	repo: string,
	ref: string,
	limit?: number,
): Promise<FirstParentMeta[]> {
	const format = ["%H", "%P", "%an", "%s"].join("%x00");
	const args = ["log", "--first-parent", `--format=${format}`];
	if (limit) args.push("-n", String(limit));
	args.push("--end-of-options", ref);
	const out = await git(args, repo);
	return out
		.split("\n")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [sha, parents, authorName, subject] = entry.split(NUL);
			return {
				sha: assertValidSha(sha ?? ""),
				parents: (parents ?? "").split(" ").filter(Boolean).map(assertValidSha),
				authorName: authorName ?? "",
				subject: subject ?? "",
			};
		});
}

/** Fetches one commit's metadata with NUL-separated fields (body last), never trusting its content as structure. */
export async function fetchCommitMetadata(git: GitRunner, repo: string, sha: string): Promise<RawCommit> {
	assertValidSha(sha);
	// "%x00" is git's pretty-format escape for a literal NUL byte in the
	// OUTPUT. We must not put a real NUL in the argv string itself (execFile
	// rejects that, and it would not survive process argument passing anyway).
	const format = ["%P", "%an", "%aI", "%s", "%b"].join("%x00");
	const raw = await git(["show", "-s", `--format=${format}`, "--end-of-options", sha], repo);
	const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	const parts = trimmed.split(NUL);
	const parents = parts[0] ?? "";
	const authorName = parts[1] ?? "";
	const date = parts[2] ?? "";
	const subject = parts[3] ?? "";
	const body = parts.slice(4).join(NUL).trim();
	return { sha, parents: parents.split(" ").filter(Boolean), authorName, date, subject, body };
}

/** Parses `git show --numstat -z` output: `<add>\t<del>\t<path>\0` or, for renames, `<add>\t<del>\t\0<old>\0<new>\0`. */
function parseNumstatZ(text: string): Map<string, { additions: number; deletions: number }> {
	const result = new Map<string, { additions: number; deletions: number }>();
	const tokens = text.split(NUL);
	let i = 0;
	while (i < tokens.length) {
		const head = tokens[i];
		if (head === undefined || head === "") {
			i++;
			continue;
		}
		const tabParts = head.split("\t");
		const add = tabParts[0];
		const del = tabParts[1];
		const inlinePath = tabParts.slice(2).join("\t");
		const stat = { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del) };
		if (inlinePath) {
			result.set(inlinePath, stat);
			i++;
		} else {
			const newPath = tokens[i + 2];
			if (newPath) result.set(newPath, stat);
			i += 3;
		}
	}
	return result;
}

/** Parses `git show --name-status -z` output: `<status>\0<path>\0` or, for renames, `<statusR###>\0<old>\0<new>\0`. */
function parseNameStatusZ(text: string): Map<string, { status: FileStatus; oldPath?: string }> {
	const result = new Map<string, { status: FileStatus; oldPath?: string }>();
	const tokens = text.split(NUL).filter((t, idx, arr) => !(t === "" && idx === arr.length - 1));
	let i = 0;
	while (i < tokens.length) {
		const code = tokens[i];
		if (!code) {
			i++;
			continue;
		}
		if (code.startsWith("R") || code.startsWith("C")) {
			const oldPath = tokens[i + 1];
			const newPath = tokens[i + 2];
			if (newPath) result.set(newPath, { status: "renamed", oldPath });
			i += 3;
		} else {
			const path = tokens[i + 1];
			const status: FileStatus = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
			if (path) result.set(path, { status });
			i += 2;
		}
	}
	return result;
}

/**
 * Parses the body of `git show --format= --patch --find-renames -U3`,
 * combined with `-z`-formatted `--numstat` and `--name-status` passes, into
 * {@link FileChange}s. Binary files get empty hunks.
 */
export function parseUnifiedDiff(diffText: string, numstatZText: string, nameStatusZText: string): FileChange[] {
	const numstat = parseNumstatZ(numstatZText);
	const statuses = parseNameStatusZ(nameStatusZText);

	const fileBlocks = splitDiffIntoFileBlocks(diffText);
	const files: FileChange[] = [];
	for (const block of fileBlocks) {
		const path = block.path;
		const known = statuses.get(path);
		const stat = numstat.get(path) ?? { additions: 0, deletions: 0 };
		files.push({
			path,
			oldPath: known?.oldPath ?? block.oldPath,
			status: known?.status ?? block.status,
			additions: stat.additions,
			deletions: stat.deletions,
			hunks: block.isBinary ? [] : capHunkLines(parseHunks(block.body)),
		});
	}

	// Files present only in numstat/name-status (e.g. empty diffs) are skipped:
	// the contract requires hunks to be verbatim diff content.
	return files;
}

interface DiffFileBlock {
	path: string;
	oldPath?: string;
	status: FileStatus;
	isBinary: boolean;
	body: string;
}

function splitDiffIntoFileBlocks(diffText: string): DiffFileBlock[] {
	const lines = diffText.split("\n");
	const blocks: DiffFileBlock[] = [];
	let current: string[] | undefined;

	const flush = () => {
		if (!current || current.length === 0) return;
		blocks.push(parseFileBlock(current.join("\n")));
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			flush();
			current = [line];
		} else if (current) {
			current.push(line);
		}
	}
	flush();
	return blocks;
}

/** Paths containing `"`, a backslash, or (with `core.quotePath` left at its default) non-ASCII bytes are C-quoted by git, even on a `diff --git` header line. */
function unquoteGitPath(raw: string): string {
	if (!(raw.startsWith('"') && raw.endsWith('"'))) return raw;
	return raw
		.slice(1, -1)
		.replace(/\\(["\\])/g, "$1")
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t");
}

function parseFileBlock(block: string): DiffFileBlock {
	const lines = block.split("\n");
	const header = lines[0] ?? "";
	const quoted = header.match(/^diff --git "a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/);
	const plain = quoted ? undefined : header.match(/^diff --git a\/(.*) b\/(.*)$/);
	let path = quoted ? unquoteGitPath(`"${quoted[2]}"`) : (plain?.[2] ?? "");
	let oldPath: string | undefined;
	let status: FileStatus = "modified";

	if (lines.some((l) => l.startsWith("new file mode"))) status = "added";
	if (lines.some((l) => l.startsWith("deleted file mode"))) status = "deleted";
	const renameFrom = lines.find((l) => l.startsWith("rename from "));
	const renameTo = lines.find((l) => l.startsWith("rename to "));
	if (renameFrom && renameTo) {
		status = "renamed";
		oldPath = unquoteGitPath(renameFrom.slice("rename from ".length));
		path = unquoteGitPath(renameTo.slice("rename to ".length));
	}
	if (!path) path = quoted ? unquoteGitPath(`"${quoted[1]}"`) : (plain?.[1] ?? "");

	const isBinary = lines.some((l) => l.startsWith("Binary files ") || l.startsWith("GIT binary patch"));

	const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
	const body = hunkStart === -1 ? "" : lines.slice(hunkStart).join("\n");

	return { path, oldPath, status, isBinary, body };
}

function parseHunks(body: string): Hunk[] {
	if (!body.trim()) return [];
	const lines = body.split("\n");
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			current = { header: line, lines: [] };
			hunks.push(current);
		} else if (current && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
			current.lines.push(line);
		} else if (current && line === "\\ No newline at end of file") {
			// drop marker, not real content
		}
	}
	return hunks;
}

function capHunkLines(hunks: Hunk[]): Hunk[] {
	return hunks.map((hunk) => ({
		...hunk,
		lines: hunk.lines.length > MAX_HUNK_LINES ? hunk.lines.slice(0, MAX_HUNK_LINES) : hunk.lines,
	}));
}

/**
 * Folds each first-parent commit (and, for merges, the branch commits it
 * merged in) into one {@link ChangeSet}. `allCommits` must contain the full
 * ancestry (not just first-parent) so merge branches can be walked.
 */
export function foldMergeChangeSets(
	commits: RawCommit[],
	allCommits: RawCommit[],
	filesByHead: Map<string, FileChange[]>,
): ChangeSet[] {
	const bySha = new Map(allCommits.map((c) => [c.sha, c]));
	const changeSets: ChangeSet[] = [];
	const consumed = new Set<string>();

	for (const commit of commits) {
		if (consumed.has(commit.sha)) continue;
		const isMerge = commit.parents.length > 1;
		const folded: string[] = [commit.sha];

		if (isMerge) {
			const [firstParent, secondParent] = commit.parents;
			// Walk second-parent ancestry until it reconnects with first-parent
			// history; those commits are "branch commits" folded into this set.
			let cursor = secondParent;
			const firstParentAncestors = new Set<string>();
			let fp: string | undefined = firstParent;
			while (fp) {
				firstParentAncestors.add(fp);
				fp = bySha.get(fp)?.parents[0];
			}
			while (cursor && !firstParentAncestors.has(cursor) && bySha.has(cursor)) {
				folded.push(cursor);
				consumed.add(cursor);
				cursor = bySha.get(cursor)?.parents[0] ?? "";
			}
		}

		consumed.add(commit.sha);
		const authors = Array.from(
			new Set(folded.map((sha) => bySha.get(sha)?.authorName).filter((a): a is string => !!a)),
		);
		changeSets.push({
			id: commit.sha,
			commits: folded.map((sha) => sha.slice(0, 12)),
			title: commit.subject,
			body: commit.body,
			authors,
			date: commit.date,
			files: filesByHead.get(commit.sha) ?? [],
		});
	}

	return changeSets;
}

/**
 * Collects change sets for the first-parent commits in `ref` (which may be
 * a plain ref like `HEAD` or a range like `<sha>..HEAD`). `ref`, `since`,
 * `until` are passed to `git rev-list`/`git show`, never interpolated into
 * a format string; every sha used downstream is validated.
 */
export async function collectChangeSets(options: CollectOptions): Promise<ChangeSet[]> {
	const git = options.git ?? runGit;
	const ref = options.ref ?? "HEAD";

	const primaryShas = await listShas(git, options.repo, ref, {
		firstParent: true,
		since: options.since,
		until: options.until,
		limit: options.limit,
	});
	// Full ancestry (not just first-parent) of the same ref/range, needed to fold merges.
	const allShas = await listShas(git, options.repo, ref, {});
	const neededShas = new Set([...primaryShas, ...allShas]);

	const metadataBySha = new Map<string, RawCommit>();
	for (const sha of neededShas) {
		metadataBySha.set(sha, await fetchCommitMetadata(git, options.repo, sha));
	}

	const commits = primaryShas.map((sha) => metadataBySha.get(sha)).filter((c): c is RawCommit => !!c);
	const allCommits = allShas.map((sha) => metadataBySha.get(sha)).filter((c): c is RawCommit => !!c);

	const filesByHead = new Map<string, FileChange[]>();
	for (const sha of primaryShas) {
		filesByHead.set(sha, await fetchFileChanges(git, options.repo, sha));
	}

	return foldMergeChangeSets(commits, allCommits, filesByHead).filter((cs) => commits.some((c) => c.sha === cs.id));
}

/** Fetches one head commit's verbatim diff (patch, numstat, name-status), the three `git show` passes {@link parseUnifiedDiff} needs. */
export async function fetchFileChanges(git: GitRunner, repo: string, sha: string): Promise<FileChange[]> {
	const diff = await git(
		["show", "--format=", "--patch", "--find-renames", "--diff-merges=first-parent", "-U3", "--end-of-options", sha],
		repo,
	);
	const numstat = await git(
		["show", "--format=", "--numstat", "--diff-merges=first-parent", "-z", "--end-of-options", sha],
		repo,
	);
	const nameStatus = await git(
		[
			"show",
			"--format=",
			"--name-status",
			"--find-renames",
			"--diff-merges=first-parent",
			"-z",
			"--end-of-options",
			sha,
		],
		repo,
	);
	return parseUnifiedDiff(diff, numstat, nameStatus);
}

const DEFAULT_BUILD_LIMIT = 10;
export const DEFAULT_SCAN_WINDOW = 500;

export interface SelectBuildShasOptions {
	repo: string;
	ref: string;
	/** Ignore the scan window and the floor: walk everything, oldest first, bounded by `limit` only when given explicitly. */
	allHistory: boolean;
	/** Size of the bounded `git rev-list --first-parent` window to scan for a floor, newest first. Ignored when `allHistory`. Defaults to {@link DEFAULT_SCAN_WINDOW}. */
	scan?: number;
	since?: string;
	until?: string;
	limit?: number;
	/** Bypass the retry cap, so capped commits become candidates again. Published commits are never re-selected. */
	force?: boolean;
	/** ids of already-published reels (feed.reels[].id). */
	publishedIds: ReadonlySet<string>;
	/** ids that have hit the render retry cap and should not be retried unless `force`. */
	cappedIds: ReadonlySet<string>;
	git?: GitRunner;
}

export interface BuildSelection {
	/** Commit shas to render this run, oldest first, at most `limit` entries. */
	shas: string[];
	/** Shas that were in scope but skipped solely because they hit the retry cap (for the "use --force" warning). Always empty when `force`. */
	cappedSkipped: string[];
}

export interface SelectFromWindowOptions {
	/** The scan window, newest first. Ids are opaque: callers may pass commit shas (as `selectBuildShas` does) or any other stable id (e.g. a story id). */
	windowIds: string[];
	/** Ignore the floor: select everything unpublished and uncapped in the window, oldest first, bounded by `limit` only when given explicitly. */
	allHistory?: boolean;
	limit?: number;
	/** Bypass the retry cap, so capped ids become candidates again. Published ids are never re-selected. */
	force?: boolean;
	publishedIds: ReadonlySet<string>;
	cappedIds: ReadonlySet<string>;
}

export interface WindowSelection {
	/** Selected ids, oldest first, at most `limit` entries. */
	ids: string[];
	/** Ids that were in scope but skipped solely because they hit the retry cap. Always empty when `force`. */
	cappedSkipped: string[];
}

/**
 * The floor/bootstrap/drain/all-history selection core shared by
 * `selectBuildShas` (`--unit commit`) and `stories.ts`'s story selection
 * (`--unit story`). Pure: no git access, so it works over any window of
 * already-ordered ids. See `selectBuildShas` for the semantics in detail.
 */
export function selectFromWindow(options: SelectFromWindowOptions): WindowSelection {
	const windowIds = options.windowIds;
	const limit = options.limit ?? DEFAULT_BUILD_LIMIT;
	const isPublished = (id: string) => options.publishedIds.has(id);
	const isCapped = (id: string) => !options.force && options.cappedIds.has(id);

	if (options.allHistory) {
		const eligible = windowIds.filter((id) => !isPublished(id) && !isCapped(id));
		const cappedSkipped = windowIds.filter((id) => !isPublished(id) && isCapped(id));
		// `eligible` is newest first; an explicit limit keeps the OLDEST, so a backfill drains in order.
		const bounded =
			options.limit !== undefined ? eligible.slice(Math.max(0, eligible.length - options.limit)) : eligible;
		return { ids: bounded.reverse(), cappedSkipped };
	}

	let floorIndex = -1;
	for (let i = windowIds.length - 1; i >= 0; i--) {
		const id = windowIds[i];
		if (id !== undefined && options.publishedIds.has(id)) {
			floorIndex = i;
			break;
		}
	}

	// In scope: strictly newer than the floor (or, with no floor found, the whole window).
	const inScope = floorIndex === -1 ? windowIds : windowIds.slice(0, floorIndex);
	const eligible = inScope.filter((id) => !isPublished(id) && !isCapped(id));
	const cappedSkipped = inScope.filter((id) => !isPublished(id) && isCapped(id));

	const bounded =
		floorIndex === -1
			? eligible.slice(0, limit) // bootstrap: newest `limit` only
			: eligible.slice(Math.max(0, eligible.length - limit)); // drain: oldest `limit` above the floor

	return { ids: bounded.reverse(), cappedSkipped };
}

/**
 * Selects which commits a `build` run should render in a single bounded
 * `git rev-list --first-parent` scan (newest first, size `scan`), instead of
 * walking all of history or tracking a separate cursor file.
 *
 * The floor is the OLDEST already-published commit found within the scan
 * window (by first-parent position, never author date — rebases and
 * cherry-picks keep old dates). Candidates are the unpublished, uncapped
 * commits newer than the floor; the OLDEST `limit` of them are selected, so
 * a burst of unpublished commits drains over successive runs, and a commit
 * that fails between two published ones is retried on later runs until the
 * retry cap. If no published id falls within the window (first run, or
 * history was rewritten past the window), this bootstraps with only the
 * newest `limit` unpublished candidates — it never backfills older commits.
 * `allHistory` ignores the floor entirely and selects everything unpublished
 * and uncapped in the (unlimited) window, oldest first, bounded by `limit`
 * only when the caller gives one explicitly.
 */
export async function selectBuildShas(options: SelectBuildShasOptions): Promise<BuildSelection> {
	const git = options.git ?? runGit;
	const windowLimit = options.allHistory ? undefined : (options.scan ?? DEFAULT_SCAN_WINDOW);

	// Newest first.
	const windowShas = await listShas(git, options.repo, options.ref, {
		firstParent: true,
		since: options.since,
		until: options.until,
		limit: windowLimit,
	});

	const { ids, cappedSkipped } = selectFromWindow({
		windowIds: windowShas,
		allHistory: options.allHistory,
		limit: options.limit,
		force: options.force,
		publishedIds: options.publishedIds,
		cappedIds: options.cappedIds,
	});
	return { shas: ids, cappedSkipped };
}

export interface ListReachableShasOptions {
	repo: string;
	ref: string;
	git?: GitRunner;
}

/**
 * Lists the first-parent-reachable commit shas from `ref`, for deciding
 * which {@link ChangeSet.id}s are still reachable after a force-push (the
 * `prune` command). Deliberately a single `git rev-list` call, not a full
 * {@link collectChangeSets}: pruning only needs ids, never diffs, so it must
 * not cost one `git show` per historical commit.
 */
export async function listReachableShas(options: ListReachableShasOptions): Promise<Set<string>> {
	const git = options.git ?? runGit;
	const shas = await listShas(git, options.repo, options.ref, { firstParent: true });
	return new Set(shas);
}

export interface CollectForShasOptions {
	repo: string;
	git?: GitRunner;
}

/**
 * Collects {@link ChangeSet}s for exactly the given shas (oldest first in,
 * oldest first out) — metadata and diffs are fetched only for these,
 * never for a scan window or their full ancestry. For a merge commit (more
 * than one parent in its own metadata), the folded branch commits are found
 * with `git rev-list <head>^1..<head>` (commits reachable from the head but
 * not its first parent) rather than walking the whole repo's history.
 */
export async function collectChangeSetsForShas(shas: string[], options: CollectForShasOptions): Promise<ChangeSet[]> {
	const git = options.git ?? runGit;
	const changeSets: ChangeSet[] = [];

	for (const sha of shas) {
		const meta = await fetchCommitMetadata(git, options.repo, sha);
		let folded = [sha];
		const authorNames = [meta.authorName];

		if (meta.parents.length > 1) {
			const branchShas = (await listShas(git, options.repo, `${sha}^1..${sha}`, {})).filter((s) => s !== sha);
			for (const branchSha of branchShas) {
				const branchMeta = await fetchCommitMetadata(git, options.repo, branchSha);
				authorNames.push(branchMeta.authorName);
			}
			folded = [sha, ...branchShas];
		}

		changeSets.push({
			id: sha,
			commits: folded.map((s) => s.slice(0, 12)),
			title: meta.subject,
			body: meta.body,
			authors: Array.from(new Set(authorNames)),
			date: meta.date,
			files: await fetchFileChanges(git, options.repo, sha),
		});
	}

	return changeSets;
}
