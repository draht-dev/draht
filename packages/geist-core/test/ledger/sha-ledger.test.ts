import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShaLedger, ShaLedgerError, worktreeReviewState } from "../../src/ledger/sha-ledger.js";

/** Runs `git <args>` in `cwd` for test setup, failing loudly on any non-zero exit. */
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/** Initializes a real git repo in a fresh temp dir, with local identity config so commits succeed in CI. */
function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sha-ledger-test-"));
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "sha-ledger-test@example.com"]);
	git(dir, ["config", "user.name", "sha-ledger-test"]);
	return dir;
}

/** Writes `file` with `contents` and creates a commit, returning the new commit's sha. */
function commitFile(repo: string, file: string, contents: string, message: string): string {
	writeFileSync(join(repo, file), contents);
	git(repo, ["add", file]);
	git(repo, ["commit", "-m", message]);
	return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * A directory containing a `git` that NEVER ANSWERS and IGNORES SIGTERM.
 *
 * Both halves are load-bearing. `sleep`ing is what a real wedged git does (an
 * NFS mount, a repository somebody else holds an `index.lock` on); ignoring
 * TERM is what makes `killSignal: "SIGKILL"` a requirement rather than a taste
 * — `spawnSync`'s default TERM is simply discarded by this shell, measured at
 * 5 s against a 500 ms bound.
 *
 * The `sleep` is backgrounded with its stdio on /dev/null so that when the
 * shell is killed nothing is left holding the stdout pipe open: the deadline
 * under test is the wrapper's, not an artifact of a grandchild keeping the
 * pipe alive.
 */
function makeHangingGitShim(): string {
	const dir = mkdtempSync(join(tmpdir(), "sha-ledger-shim-"));
	const path = join(dir, "git");
	writeFileSync(path, "#!/bin/sh\ntrap '' TERM\nsleep 5 >/dev/null 2>&1 &\nwait\n", "utf8");
	chmodSync(path, 0o755);
	return dir;
}

/** Runs `body` with `dir` at the front of PATH, restoring PATH no matter what. */
function withShimOnPath<T>(dir: string, body: () => T): T {
	const original = process.env.PATH;
	process.env.PATH = `${dir}:${original ?? ""}`;
	try {
		return body();
	} finally {
		process.env.PATH = original;
	}
}

let repo: string;

beforeEach(() => {
	repo = initRepo();
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("ShaLedger.record", () => {
	test("captures the worktree's current HEAD sha as baseSha", () => {
		const commitSha = commitFile(repo, "file.txt", "v1", "initial commit");

		const ledger = new ShaLedger();
		const result = ledger.record(repo);

		expect(result.baseSha).toBe(commitSha);
		expect(ledger.get(repo)).toEqual({ baseSha: commitSha });
	});

	test("re-recording the same worktree resets bookkeeping to the new HEAD, clearing lastApprovedSha", () => {
		const first = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);
		ledger.approve(repo);
		expect(ledger.get(repo)?.lastApprovedSha).toBe(first);

		const second = commitFile(repo, "file.txt", "v2", "second commit");
		const result = ledger.record(repo);

		expect(result.baseSha).toBe(second);
		expect(ledger.get(repo)).toEqual({ baseSha: second });
	});
});

describe("ShaLedger.approve", () => {
	test("throws when the worktree was never record()ed", () => {
		const ledger = new ShaLedger();
		expect(() => ledger.approve(repo)).toThrow(ShaLedgerError);
	});

	test("defaults to the current HEAD sha when no sha is given", () => {
		commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);

		const second = commitFile(repo, "file.txt", "v2", "second commit");
		const result = ledger.approve(repo);

		expect(result.lastApprovedSha).toBe(second);
		expect(ledger.get(repo)?.lastApprovedSha).toBe(second);
	});

	test("accepts an explicit sha, distinct from the current HEAD", () => {
		const first = commitFile(repo, "file.txt", "v1", "initial commit");
		commitFile(repo, "file.txt", "v2", "second commit");

		const ledger = new ShaLedger();
		ledger.record(repo);
		const result = ledger.approve(repo, first);

		expect(result.lastApprovedSha).toBe(first);
		expect(ledger.get(repo)?.lastApprovedSha).toBe(first);
	});
});

describe("ShaLedger.undo", () => {
	test("throws when the worktree was never record()ed", () => {
		const ledger = new ShaLedger();
		expect(() => ledger.undo(repo)).toThrow(ShaLedgerError);
	});

	test("with no approve(), reset --hard's the worktree back to baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);

		commitFile(repo, "file.txt", "v2", "second commit");
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v2");

		const result = ledger.undo(repo);

		expect(result.resetTo).toBe(baseSha);
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(baseSha);
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v1");
	});

	test("with an approve(), reset --hard's the worktree to lastApprovedSha instead of baseSha", () => {
		commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);

		const approvedSha = commitFile(repo, "file.txt", "v2", "second commit");
		ledger.approve(repo);

		commitFile(repo, "file.txt", "v3", "third commit, never approved");
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v3");

		const result = ledger.undo(repo);

		expect(result.resetTo).toBe(approvedSha);
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(approvedSha);
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v2");
	});

	test("discards uncommitted changes too (real reset --hard, not just a HEAD move)", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);

		// Dirty the tree without committing.
		writeFileSync(join(repo, "file.txt"), "uncommitted edit");
		expect(git(repo, ["status", "--porcelain"])).not.toBe("");

		ledger.undo(repo);

		expect(git(repo, ["rev-parse", "HEAD"])).toBe(baseSha);
		expect(git(repo, ["status", "--porcelain"])).toBe("");
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("v1");
	});
});

describe("ShaLedger.get", () => {
	test("returns undefined for a worktree that was never record()ed", () => {
		const ledger = new ShaLedger();
		expect(ledger.get(repo)).toBeUndefined();
	});

	test("tracks independent state per worktree path", () => {
		commitFile(repo, "file.txt", "v1", "repo one commit");
		const otherRepo = initRepo();
		const otherSha = commitFile(otherRepo, "other.txt", "other-v1", "repo two commit");

		try {
			const ledger = new ShaLedger();
			ledger.record(repo);
			ledger.record(otherRepo);
			ledger.approve(otherRepo);

			expect(ledger.get(repo)?.lastApprovedSha).toBeUndefined();
			expect(ledger.get(otherRepo)?.lastApprovedSha).toBe(otherSha);
		} finally {
			rmSync(otherRepo, { recursive: true, force: true });
		}
	});
});

describe("worktreeReviewState", () => {
	test("clean for a clean worktree exactly at baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");

		expect(worktreeReviewState(repo, baseSha)).toBe("clean");
	});

	test("dirty when the working tree has uncommitted changes, even at baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		writeFileSync(join(repo, "file.txt"), "dirty edit");

		expect(worktreeReviewState(repo, baseSha)).toBe("dirty");
	});

	test("dirty when clean but HEAD has moved past baseSha via new commits (ahead)", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		commitFile(repo, "file.txt", "v2", "second commit");

		expect(worktreeReviewState(repo, baseSha)).toBe("dirty");
	});

	test("dirty when both dirty AND ahead", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		commitFile(repo, "file.txt", "v2", "second commit");
		writeFileSync(join(repo, "file.txt"), "dirty edit on top");

		expect(worktreeReviewState(repo, baseSha)).toBe("dirty");
	});

	test("clean again after undo() resets a dirty+ahead worktree back to baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);

		commitFile(repo, "file.txt", "v2", "second commit");
		writeFileSync(join(repo, "file.txt"), "dirty edit");
		expect(worktreeReviewState(repo, baseSha)).toBe("dirty");

		ledger.undo(repo);

		expect(worktreeReviewState(repo, baseSha)).toBe("clean");
	});

	test("is also exposed as an instance method on ShaLedger, with the same behavior", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();

		expect(ledger.reviewState(repo, baseSha)).toBe("clean");

		commitFile(repo, "file.txt", "v2", "second commit");
		expect(ledger.reviewState(repo, baseSha)).toBe("dirty");
	});
});

describe("the git deadline (a wrapper with no bound is a turn that never ends)", () => {
	/**
	 * Generous on purpose: this test must FAIL on an assertion when the deadline
	 * is gone, not be cut short by the runner while `spawnSync` still has the
	 * thread. An unbounded call sits here for 5 s per git invocation.
	 */
	const SHIM_TEST_TIMEOUT_MS = 30_000;
	/** The bound in `sha-ledger.ts` is 500 ms; this leaves room for spawn overhead. */
	const DEADLINE_CEILING_MS = 2_000;

	let shimDir: string;

	beforeEach(() => {
		shimDir = makeHangingGitShim();
	});

	afterEach(() => {
		rmSync(shimDir, { recursive: true, force: true });
	});

	test(
		"runGit gives up on a git that never answers, instead of blocking the turn forever",
		() => {
			commitFile(repo, "file.txt", "v1", "initial commit");
			const ledger = new ShaLedger();

			const startedAt = Date.now();
			let thrown: unknown;
			withShimOnPath(shimDir, () => {
				try {
					ledger.record(repo);
				} catch (error) {
					thrown = error;
				}
			});
			const elapsed = Date.now() - startedAt;

			// It came back AT ALL, and it came back in half a second-ish rather than
			// whenever the shim felt like it. Without `timeout`, or with a
			// `killSignal` this shim ignores, this is the assertion that dies.
			expect(elapsed).toBeLessThan(DEADLINE_CEILING_MS);
			// And it came back as a FAILURE. A wrapper that dropped the deadline
			// would eventually return the shim's empty stdout as a baseSha.
			expect(thrown).toBeInstanceOf(ShaLedgerError);
			expect((thrown as Error).message).toContain("rev-parse");
			expect(ledger.get(repo)).toBeUndefined();
		},
		SHIM_TEST_TIMEOUT_MS,
	);

	test(
		"worktreeReviewState answers `unknown` inside the deadline — never `clean`, never never",
		() => {
			const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");

			const startedAt = Date.now();
			const state = withShimOnPath(shimDir, () => worktreeReviewState(repo, baseSha));
			const elapsed = Date.now() - startedAt;

			expect(elapsed).toBeLessThan(DEADLINE_CEILING_MS);
			// The tree really is clean, and that is exactly why this matters: the
			// honest answer to "git did not answer" is `unknown`, and an unbounded
			// wrapper eventually reports the true-by-accident `clean` instead.
			expect(state).toBe("unknown");
		},
		SHIM_TEST_TIMEOUT_MS,
	);
});
