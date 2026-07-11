import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDirtyOrAhead, ShaLedger, ShaLedgerError } from "../../src/ledger/sha-ledger.js";

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

describe("isDirtyOrAhead", () => {
	test("false for a clean worktree exactly at baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");

		expect(isDirtyOrAhead(repo, baseSha)).toBe(false);
	});

	test("true when the working tree has uncommitted changes, even at baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		writeFileSync(join(repo, "file.txt"), "dirty edit");

		expect(isDirtyOrAhead(repo, baseSha)).toBe(true);
	});

	test("true when clean but HEAD has moved past baseSha via new commits (ahead)", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		commitFile(repo, "file.txt", "v2", "second commit");

		expect(isDirtyOrAhead(repo, baseSha)).toBe(true);
	});

	test("true when both dirty AND ahead", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		commitFile(repo, "file.txt", "v2", "second commit");
		writeFileSync(join(repo, "file.txt"), "dirty edit on top");

		expect(isDirtyOrAhead(repo, baseSha)).toBe(true);
	});

	test("false again after undo() resets a dirty+ahead worktree back to baseSha", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();
		ledger.record(repo);

		commitFile(repo, "file.txt", "v2", "second commit");
		writeFileSync(join(repo, "file.txt"), "dirty edit");
		expect(isDirtyOrAhead(repo, baseSha)).toBe(true);

		ledger.undo(repo);

		expect(isDirtyOrAhead(repo, baseSha)).toBe(false);
	});

	test("is also exposed as an instance method on ShaLedger, with the same behavior", () => {
		const baseSha = commitFile(repo, "file.txt", "v1", "initial commit");
		const ledger = new ShaLedger();

		expect(ledger.isDirtyOrAhead(repo, baseSha)).toBe(false);

		commitFile(repo, "file.txt", "v2", "second commit");
		expect(ledger.isDirtyOrAhead(repo, baseSha)).toBe(true);
	});
});
