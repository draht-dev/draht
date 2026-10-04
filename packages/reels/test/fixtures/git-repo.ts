/**
 * A real temporary git repo builder for mainline/story tests. Every helper
 * shells out to real `git`, mirroring the pattern in `test/collect.test.ts`,
 * but packages the repeated setup (deterministic identities and dates,
 * feature branches, sync merges, back-merges, oversized merges, tags) so
 * `mainline.test.ts` and friends can build real history instead of mocking
 * `git` output.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitAuthor {
	name: string;
	email: string;
}

export const DEFAULT_AUTHOR: GitAuthor = { name: "Test", email: "test@example.com" };
export const FOREIGN_AUTHOR: GitAuthor = { name: "Upstream Bot", email: "upstream-bot@example.com" };

/**
 * Some sandboxed `/tmp` filesystems lag between one process's write and the
 * next process's read, so a `git commit` that immediately follows the
 * previous one's parent write can transiently fail with "unable to read
 * <sha>" even though nothing is actually wrong with the repo. Retrying is
 * safe here (never masks a real, reproducible git error) because fixture
 * builders never run concurrently against the same repo.
 */
const TRANSIENT_READ_ERROR = /unable to read [0-9a-f]{40}/;
const MAX_GIT_RETRIES = 4;

function runGit(cwd: string, args: string[], env?: Record<string, string | undefined>): string {
	let lastError = "";
	for (let attempt = 0; attempt <= MAX_GIT_RETRIES; attempt++) {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			env: env ? { ...process.env, ...env } : undefined,
		});
		if (result.status === 0) return result.stdout.trim();
		lastError = result.stderr;
		if (!TRANSIENT_READ_ERROR.test(lastError)) break;
		Bun.sleepSync(10 * (attempt + 1));
	}
	throw new Error(`git ${args.join(" ")} failed: ${lastError}`);
}

/** Monotonically increasing author dates, one minute apart, so fixture history is reproducible and never backdated relative to itself. */
let clockMs = Date.UTC(2024, 0, 1, 0, 0, 0);
function nextDate(): string {
	clockMs += 60_000;
	return new Date(clockMs).toISOString();
}

export class GitRepo {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	git(args: string[], env?: Record<string, string | undefined>): string {
		return runGit(this.dir, args, env);
	}

	writeFile(path: string, content: string, opts: { append?: boolean } = {}): void {
		const fullPath = join(this.dir, path);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content, opts.append ? { flag: "a" } : undefined);
	}

	/** Writes `path` (default content derived from `message`) and commits it. Returns the new commit's sha. */
	commit(message: string, opts: { path?: string; content?: string; author?: GitAuthor; date?: string } = {}): string {
		const path = opts.path ?? "file.txt";
		const content = opts.content ?? `${message}\n`;
		this.writeFile(path, content, { append: true });
		this.git(["add", path]);
		const author = opts.author ?? DEFAULT_AUTHOR;
		const date = opts.date ?? nextDate();
		this.git([
			"-c",
			`user.name=${author.name}`,
			"-c",
			`user.email=${author.email}`,
			"commit",
			"--date",
			date,
			"-m",
			message,
		]);
		return this.sha("HEAD");
	}

	/**
	 * `count` sequential commits onto whatever ref is checked out, built with
	 * `git commit-tree` (same tree each time: only the branch-commit *count*
	 * matters to oversized-merge classification, never their content) instead
	 * of `count` working-tree writes plus `git add` plus `git commit`. Faster,
	 * and avoids the write/read races a large burst of real working-tree
	 * commits can hit on a sandboxed filesystem. Returns the tip sha; the
	 * checked-out ref is fast-forwarded to it.
	 */
	commitChain(count: number, opts: { messagePrefix?: string; author?: GitAuthor } = {}): string {
		const prefix = opts.messagePrefix ?? "chain commit";
		const author = opts.author ?? DEFAULT_AUTHOR;
		const treeSha = this.git(["rev-parse", "HEAD^{tree}"]);
		let tip = this.sha("HEAD");
		for (let i = 1; i <= count; i++) {
			const date = nextDate();
			tip = this.git(["commit-tree", treeSha, "-p", tip, "-m", `${prefix} ${i}`], {
				GIT_AUTHOR_NAME: author.name,
				GIT_AUTHOR_EMAIL: author.email,
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_NAME: author.name,
				GIT_COMMITTER_EMAIL: author.email,
				GIT_COMMITTER_DATE: date,
			});
		}
		this.git(["update-ref", "HEAD", tip]);
		return tip;
	}

	checkoutNewBranch(name: string, from?: string): void {
		const args = ["checkout", "-q", "-b", name];
		if (from) args.push(from);
		this.git(args);
	}

	checkout(ref: string): void {
		this.git(["checkout", "-q", ref]);
	}

	currentBranch(): string {
		return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
	}

	/**
	 * `git rev-parse` is a plumbing option-parsing helper, not a revision
	 * walker: it does not recognize `--end-of-options` and echoes it back as
	 * literal output instead of consuming it, so (unlike every other call in
	 * this fixture) `ref` is passed without it. Fixture refs are never
	 * attacker-controlled.
	 */
	sha(ref: string): string {
		return this.git(["rev-parse", ref]);
	}

	/** `git merge --no-ff`: the checked-out branch becomes the merge's first parent, `branch` the second. Returns the merge sha. */
	mergeNoFF(branch: string, message: string, opts: { author?: GitAuthor } = {}): string {
		const author = opts.author ?? DEFAULT_AUTHOR;
		this.git([
			"-c",
			`user.name=${author.name}`,
			"-c",
			`user.email=${author.email}`,
			"merge",
			"--no-ff",
			"-m",
			message,
			branch,
		]);
		return this.sha("HEAD");
	}

	tag(name: string, opts: { ref?: string; annotated?: boolean } = {}): void {
		const args = ["tag"];
		if (opts.annotated) args.push("-a", "-m", name);
		args.push(name);
		if (opts.ref) args.push(opts.ref);
		this.git(args);
	}
}

/** Creates a fresh repo with a single `init` commit on its default branch. */
export function initGitRepo(prefix = "reels-fixture-"): GitRepo {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const repo = new GitRepo(dir);
	repo.git(["init", "-q"]);
	repo.git([
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--allow-empty",
		"--date",
		nextDate(),
		"-m",
		"init",
	]);
	return repo;
}

export function cleanupGitRepo(repo: GitRepo): void {
	rmSync(repo.dir, { recursive: true, force: true });
}

/**
 * Builds a `--no-ff` feature branch (a `feat:` commit, a `red:`/`green:`
 * pair, and a long-bodied commit) off the checked-out ref, merges it back,
 * and leaves the repo on the branch that was checked out. Returns the merge
 * sha.
 */
export function addFeatureBranchMerge(repo: GitRepo, opts: { branchName?: string; subject?: string } = {}): string {
	const base = repo.currentBranch();
	const branchName = opts.branchName ?? `feature-${Math.random().toString(36).slice(2, 8)}`;
	repo.checkoutNewBranch(branchName);
	repo.commit("feat: add the new thing", {
		path: "feature.txt",
		content: `feat: add the new thing\n\n${"why this was needed, in detail. ".repeat(40)}\n`,
	});
	repo.commit("red: failing test for the new thing", { path: "feature.txt" });
	repo.commit("green: make the failing test pass", { path: "feature.txt" });
	repo.checkout(base);
	return repo.mergeNoFF(branchName, opts.subject ?? "Merge feature");
}

/**
 * Builds a sync merge: a branch with `foreignAuthorCount` commits by
 * {@link FOREIGN_AUTHOR} (foreign-author detection) that also touches
 * `.upstream-sync` (marker-path detection), with a subject matching the
 * default `upstream.subjectPatterns` (subject detection). Each detection
 * signal is independently reproducible by the caller via `opts`.
 */
export function addSyncMerge(
	repo: GitRepo,
	opts: {
		branchName?: string;
		subject?: string;
		foreignAuthorCount?: number;
		touchMarker?: boolean;
	} = {},
): string {
	const base = repo.currentBranch();
	const branchName = opts.branchName ?? `sync-${Math.random().toString(36).slice(2, 8)}`;
	const foreignAuthorCount = opts.foreignAuthorCount ?? 25;
	repo.checkoutNewBranch(branchName);
	for (let i = 1; i <= foreignAuthorCount; i++) {
		repo.commit(`upstream commit ${i}`, { path: "upstream.txt", author: FOREIGN_AUTHOR });
	}
	const touchMarker = opts.touchMarker ?? true;
	if (touchMarker) {
		repo.commit("mark sync", { path: ".upstream-sync", content: "synced\n" });
	}
	// `git merge --no-ff` fast-forwards (creating no merge commit at all) when
	// the branch has nothing new, so an isolated-signal test still needs one
	// commit on the branch even when neither other signal is exercised.
	if (foreignAuthorCount === 0 && !touchMarker) {
		repo.commit("branch-only commit", { path: "branch-only.txt" });
	}
	repo.checkout(base);
	return repo.mergeNoFF(branchName, opts.subject ?? "sync upstream through v9.9.9");
}

/**
 * Builds an oversized (non-sync) merge: `branchCommitCount` plain commits by
 * the default (local) author, with a subject that does not match any sync
 * pattern.
 */
export function addOversizedMerge(
	repo: GitRepo,
	opts: { branchName?: string; subject?: string; branchCommitCount?: number } = {},
): string {
	const base = repo.currentBranch();
	const branchName = opts.branchName ?? `big-${Math.random().toString(36).slice(2, 8)}`;
	const branchCommitCount = opts.branchCommitCount ?? 151;
	repo.checkoutNewBranch(branchName);
	repo.commitChain(branchCommitCount, { messagePrefix: "big branch commit" });
	repo.checkout(base);
	return repo.mergeNoFF(branchName, opts.subject ?? "Merge pull request #1 from draht-dev/dev");
}

export interface BackMergeFixture {
	/** The back-merge commit itself: first parent is the sync/side line, second parent is the real mainline. */
	mergeSha: string;
	/** A commit on the real-mainline (second-parent) side, carrying a release tag. */
	mainlineTaggedSha: string;
	tagName: string;
}

/**
 * Lays out a back-merge like draht-mono's `0c354b3a4`: starting from the
 * checked-out ref, forks a "real mainline" branch that gets a `feat:` commit
 * and a release tag matching `tagName`, while the checked-out branch itself
 * (no tag) gets foreign-author sync commits. It then merges the mainline
 * branch INTO the checked-out branch, so the sync line is the first parent
 * and the tagged mainline is the second parent — the shape that makes a
 * plain first-parent walk miss the tag and the feature commit.
 */
export function addBackMerge(
	repo: GitRepo,
	opts: { mainlineBranchName?: string; sideBranchCommits?: number; tagName?: string; subject?: string } = {},
): BackMergeFixture {
	const base = repo.currentBranch();
	const mainlineBranchName = opts.mainlineBranchName ?? `mainline-${Math.random().toString(36).slice(2, 8)}`;
	const tagName = opts.tagName ?? "v1.0.0";

	repo.checkoutNewBranch(mainlineBranchName);
	const mainlineTaggedSha = repo.commit("feat: a real feature only reachable via the swapped parent", {
		path: "mainline-feature.txt",
	});
	repo.tag(tagName, { ref: mainlineTaggedSha });

	repo.checkout(base);
	for (let i = 1; i <= (opts.sideBranchCommits ?? 2); i++) {
		repo.commit(`upstream sync commit ${i}`, { path: "side.txt", author: FOREIGN_AUTHOR });
	}

	const mergeSha = repo.mergeNoFF(mainlineBranchName, opts.subject ?? "bring GitHub main into the sync (back-merge)");
	return { mergeSha, mainlineTaggedSha, tagName };
}
