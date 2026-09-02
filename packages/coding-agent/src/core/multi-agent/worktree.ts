/**
 * Worktree isolator for multi-agent coordination.
 *
 * Gives each agent task its own `git worktree` so parallel agents can edit
 * files without stepping on the shared working directory or each other.
 * Worktrees live under `<cwd>/.draht-worktrees/<taskId>` on a dedicated
 * `agent/<taskId>` branch, and are merged back into the branch that was
 * checked out in `cwd` at creation time.
 *
 * Falls back to returning `cwd` unchanged (no isolation) when `cwd` is not
 * inside a git repository, so callers can use the isolator unconditionally
 * and degrade gracefully outside of git.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Name of the directory (relative to the repo working directory) worktrees are created under. */
export const WORKTREE_DIR_NAME = ".draht-worktrees";

/** Result of attempting to merge a task's worktree branch back into its base branch. */
export interface MergeResult {
	success: boolean;
	/** The `agent/<taskId>` branch the task's work is committed on. Absent for an unknown `taskId`. */
	branch?: string;
	/** Paths with unresolved conflicts. Present (possibly empty) only when `success` is false. */
	conflicts?: string[];
}

interface WorktreeRecord {
	/** Directory the isolator was created against (where the base branch is checked out). */
	cwd: string;
	/** Absolute path to the worktree's working directory. */
	worktreePath: string;
	/** Branch created for the task inside the worktree. */
	branch: string;
	/** Branch the task branch was created from, and merges back into. */
	baseBranch: string;
}

/**
 * Creates, merges, and tears down per-task git worktrees so agents can work
 * in isolated working directories instead of the shared project checkout.
 */
export class WorktreeIsolator {
	private readonly worktrees = new Map<string, WorktreeRecord>();

	/** True when `cwd` exists and is inside a git working tree. */
	isGitRepo(cwd: string): boolean {
		if (!existsSync(cwd)) return false;
		try {
			return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
		} catch {
			return false;
		}
	}

	/**
	 * Create an isolated worktree for `taskId`, branched off `baseBranch`
	 * (defaults to whatever branch is currently checked out in `cwd`).
	 * Returns the worktree's absolute path. When `cwd` is not a git
	 * repository, isolation is skipped and `cwd` is returned unchanged.
	 * Calling this again for a `taskId` that already has a worktree returns
	 * the existing path without recreating it.
	 */
	create(cwd: string, taskId: string, baseBranch?: string): string {
		if (!this.isGitRepo(cwd)) {
			return cwd;
		}

		const existing = this.worktrees.get(taskId);
		if (existing) {
			return existing.worktreePath;
		}

		const worktreeRoot = join(cwd, WORKTREE_DIR_NAME);
		mkdirSync(worktreeRoot, { recursive: true });
		excludeFromStatus(cwd, `${WORKTREE_DIR_NAME}/`);

		const worktreePath = join(worktreeRoot, taskId);
		const branch = `agent/${taskId}`;
		const baseline = baseBranch ?? git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

		git(cwd, ["worktree", "add", "-b", branch, worktreePath, baseline]);

		this.worktrees.set(taskId, { cwd, worktreePath, branch, baseBranch: baseline });
		return worktreePath;
	}

	/**
	 * Merge a task's branch back into its base branch. Any pending changes
	 * left uncommitted in the worktree are committed first. On conflict, the
	 * merge is aborted (the base branch is left exactly as it was before the
	 * call) and the conflicting paths are reported instead of force-resolving.
	 * Returns `{ success: false, conflicts: [] }` for an unknown `taskId`.
	 */
	merge(taskId: string): MergeResult {
		const record = this.worktrees.get(taskId);
		if (!record) {
			return { success: false, conflicts: [] };
		}

		commitPendingChanges(record.worktreePath, `agent: complete task ${taskId}`);

		try {
			git(record.cwd, ["merge", "--no-ff", "-m", `Merge agent task ${taskId}`, record.branch]);
			return { success: true, branch: record.branch };
		} catch {
			const conflicts = git(record.cwd, ["diff", "--name-only", "--diff-filter=U"])
				.trim()
				.split("\n")
				.filter(Boolean);
			try {
				git(record.cwd, ["merge", "--abort"]);
			} catch {
				// nothing to abort, or already clean — leave repo state as-is
			}
			return { success: false, branch: record.branch, conflicts };
		}
	}

	/** Remove a task's worktree directory and its git worktree registration, if any. */
	cleanup(taskId: string): void {
		const record = this.worktrees.get(taskId);
		if (!record) return;

		try {
			git(record.cwd, ["worktree", "remove", record.worktreePath, "--force"]);
		} catch {
			if (existsSync(record.worktreePath)) {
				rmSync(record.worktreePath, { recursive: true, force: true });
			}
			try {
				git(record.cwd, ["worktree", "prune"]);
			} catch {
				// best effort
			}
		}

		this.worktrees.delete(taskId);
	}
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Stage and commit any pending changes in `worktreePath`. No-op when the tree is clean. */
function commitPendingChanges(worktreePath: string, message: string): void {
	git(worktreePath, ["add", "-A"]);
	const status = git(worktreePath, ["status", "--porcelain"]).trim();
	if (status.length === 0) return;
	git(worktreePath, ["commit", "-m", message]);
}

/**
 * Add `pattern` to the repository's shared `info/exclude` so the worktree
 * directory doesn't show up as untracked in `git status` for the base branch.
 * Best-effort: failures are swallowed since this is a status-hygiene nicety,
 * not required for isolation or merging to work.
 */
function excludeFromStatus(cwd: string, pattern: string): void {
	try {
		const gitDir = git(cwd, ["rev-parse", "--git-common-dir"]).trim();
		const excludePath = join(gitDir.startsWith("/") ? gitDir : join(cwd, gitDir), "info", "exclude");
		const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
		if (current.split("\n").includes(pattern)) return;
		const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
		writeFileSync(excludePath, `${current}${separator}${pattern}\n`, "utf-8");
	} catch {
		// best effort
	}
}
