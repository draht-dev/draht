import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeIsolator } from "../../src/core/multi-agent/worktree.ts";
import { createTempGitRepo, type TempGitRepo } from "../test-utils/git-repo.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

describe("WorktreeIsolator", () => {
	let repo: TempGitRepo;
	let isolator: WorktreeIsolator;

	beforeEach(() => {
		repo = createTempGitRepo();
		isolator = new WorktreeIsolator();
	});

	afterEach(() => {
		repo.cleanup();
	});

	it("creates a worktree for an agent task at the expected path", () => {
		const worktreePath = isolator.create(repo.repoPath, "task-1");

		expect(worktreePath).toBe(join(repo.repoPath, ".draht-worktrees", "task-1"));
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
	});

	it("lets an agent write files in the worktree without affecting main", () => {
		const worktreePath = isolator.create(repo.repoPath, "task-2");

		writeFileSync(join(worktreePath, "feature.txt"), "hello from agent\n", "utf-8");

		expect(existsSync(join(worktreePath, "feature.txt"))).toBe(true);
		expect(existsSync(join(repo.repoPath, "feature.txt"))).toBe(false);
	});

	it("merges the worktree back into the source branch", () => {
		const worktreePath = isolator.create(repo.repoPath, "task-3");
		writeFileSync(join(worktreePath, "feature.txt"), "hello from agent\n", "utf-8");

		const result = isolator.merge("task-3");

		expect(result.success).toBe(true);
		expect(existsSync(join(repo.repoPath, "feature.txt"))).toBe(true);
		expect(readFileSync(join(repo.repoPath, "feature.txt"), "utf-8")).toBe("hello from agent\n");
	});

	it("detects conflicts on merge instead of force-resolving", () => {
		const worktreePath = isolator.create(repo.repoPath, "task-4");

		// Diverge the base branch after the worktree was created.
		writeFileSync(join(repo.repoPath, "README.md"), "main change\n", "utf-8");
		git(repo.repoPath, ["add", "README.md"]);
		git(repo.repoPath, ["commit", "-m", "main: change readme"]);

		// Diverge the worktree with a conflicting edit to the same file.
		writeFileSync(join(worktreePath, "README.md"), "worktree change\n", "utf-8");

		const result = isolator.merge("task-4");

		expect(result.success).toBe(false);
		expect(result.conflicts).toContain("README.md");

		// The merge attempt must be aborted, leaving the base branch clean.
		const status = git(repo.repoPath, ["status", "--porcelain"]).trim();
		expect(status).toBe("");
		expect(readFileSync(join(repo.repoPath, "README.md"), "utf-8")).toBe("main change\n");
	});

	it("removes the worktree directory and git worktree entry on cleanup", () => {
		const worktreePath = isolator.create(repo.repoPath, "task-5");

		isolator.cleanup("task-5");

		expect(existsSync(worktreePath)).toBe(false);
		const list = git(repo.repoPath, ["worktree", "list", "--porcelain"]);
		expect(list).not.toContain("task-5");
	});

	it("falls back to cwd, without creating a worktree, outside a git repo", () => {
		const plainDir = mkdtempSync(join(tmpdir(), "worktree-isolator-non-git-"));
		try {
			expect(isolator.isGitRepo(plainDir)).toBe(false);

			const result = isolator.create(plainDir, "task-6");

			expect(result).toBe(plainDir);
			expect(existsSync(join(plainDir, ".draht-worktrees"))).toBe(false);
		} finally {
			rmSync(plainDir, { recursive: true, force: true });
		}
	});
});
