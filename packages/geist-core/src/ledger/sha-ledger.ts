import { spawnSync } from "node:child_process";

/**
 * The sha ledger (spec §6 "Sessions & worktrees" row, §12): harness-free git
 * bookkeeping per session worktree. Tracks `baseSha` (the commit a worktree
 * was spawned from) and `lastApprovedSha` (the most recently approved state)
 * and turns them into real git operations — `approve`/`undo via sha ledger`,
 * `undo = reset --hard <ref>` (spec §6, §12).
 *
 * This module shells out to a real `git` binary against a real worktree path
 * — no in-memory git simulation. It has zero ACP dependency and zero
 * `@draht/*` imports ("geist-core never speaks ACP", spec §7); it is pure git
 * subprocess wrapping, safe to reuse from `geist-acp` (or anywhere else in
 * the geist family) once that layer needs the same "is this worktree
 * dirty/ahead of its base?" check spec §12 describes for `awaiting_review`:
 * "git is the truth, not the agent's claim".
 */

/** One worktree's sha bookkeeping. `lastApprovedSha` is unset until the first `approve()`. */
export interface ShaLedgerEntry {
	readonly baseSha: string;
	readonly lastApprovedSha?: string;
}

/** Result of `record()`: the captured base commit. */
export interface ShaLedgerRecordResult {
	readonly baseSha: string;
}

/** Result of `approve()`: the sha that now stands as `lastApprovedSha`. */
export interface ShaLedgerApproveResult {
	readonly lastApprovedSha: string;
}

/** Result of `undo()`: the sha the worktree was hard-reset to. */
export interface ShaLedgerUndoResult {
	readonly resetTo: string;
}

/** Raised for git subprocess failures and for operating on a worktree with no `record()`ed entry. */
export class ShaLedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShaLedgerError";
	}
}

/** Runs `git <args>` in `cwd`, returning trimmed stdout. Throws `ShaLedgerError` on any non-zero exit. */
function runGit(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });

	if (result.error) {
		throw new ShaLedgerError(`failed to run "git ${args.join(" ")}" in ${cwd}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr.trim();
		throw new ShaLedgerError(`"git ${args.join(" ")}" failed in ${cwd} (exit ${result.status}): ${stderr}`);
	}

	return result.stdout.trim();
}

/** The worktree's current `HEAD` commit sha. */
function readHeadSha(worktreePath: string): string {
	return runGit(worktreePath, ["rev-parse", "HEAD"]);
}

/** Whether the worktree has any uncommitted changes (tracked or untracked). */
function isWorkingTreeDirty(worktreePath: string): boolean {
	return runGit(worktreePath, ["status", "--porcelain"]).length > 0;
}

/** Whether `HEAD` has commits beyond `baseSha` (reachable from `HEAD`, not reachable from `baseSha`). */
function isAheadOf(worktreePath: string, baseSha: string): boolean {
	const count = runGit(worktreePath, ["rev-list", "--count", `${baseSha}..HEAD`]);
	return Number.parseInt(count, 10) > 0;
}

/**
 * The concrete mechanism behind spec §12's `awaiting_review` rule: "git is
 * dirty/ahead (git is the truth, not the agent's claim)". Dirty = uncommitted
 * changes in the working tree; ahead = `HEAD` has moved past `baseSha` via
 * new commits. Either one is enough. Reads real git state — no caching, no
 * reliance on ledger bookkeeping — so it's correct even for a worktree this
 * `ShaLedger` instance never `record()`ed.
 *
 * `baseSha` may be `null` for a session whose spawn `cwd` had no resolvable
 * `HEAD` (not a git worktree at capture time); with no base to compare against,
 * only the dirty half applies. This is the single canonical implementation
 * `@draht/geist-acp` consumes for its turn-end review check (spec §12) rather
 * than forking a near-copy.
 *
 * Resilient by design: unlike `record`/`approve`/`undo` — where a git failure
 * is a genuine error worth throwing — a turn-end review probe that cannot read
 * git (e.g. run against a non-git `cwd` under the `null`-base fallback) must not
 * crash the turn. Any {@link ShaLedgerError} from the underlying git calls is
 * treated as "cannot tell → not dirty/ahead" (`false`), preserving the
 * null-safe behavior `geist-acp` previously implemented in its own fork.
 */
export function isDirtyOrAhead(worktreePath: string, baseSha: string | null): boolean {
	try {
		if (isWorkingTreeDirty(worktreePath)) return true;
		return baseSha !== null && isAheadOf(worktreePath, baseSha);
	} catch (error) {
		if (error instanceof ShaLedgerError) return false;
		throw error;
	}
}

/**
 * Harness-free git bookkeeping for session worktrees (spec §6, §12). One
 * `ShaLedger` instance tracks `{ baseSha, lastApprovedSha }` per worktree
 * path in memory; the git operations themselves (`rev-parse`, `status`,
 * `reset --hard`) always hit the real repo on disk, never the in-memory
 * cache — this instance only remembers *which* shas matter for a worktree,
 * not the state of the worktree itself.
 */
export class ShaLedger {
	private readonly entries = new Map<string, ShaLedgerEntry>();

	/**
	 * Captures the worktree's current `HEAD` as `baseSha` — spec §12's spawn
	 * step: "resolve project + harness → worktree + `baseSha`". Called once
	 * when a session starts; a second `record()` for the same path resets its
	 * bookkeeping (fresh `baseSha`, `lastApprovedSha` cleared), matching a
	 * session being respawned on the same worktree path.
	 */
	record(worktreePath: string): ShaLedgerRecordResult {
		const baseSha = readHeadSha(worktreePath);
		this.entries.set(worktreePath, { baseSha });
		return { baseSha };
	}

	/**
	 * Marks a sha as `lastApprovedSha` for a worktree already `record()`ed.
	 * Defaults to the worktree's current `HEAD` when `sha` is omitted (spec:
	 * "approve/undo via sha ledger").
	 */
	approve(worktreePath: string, sha?: string): ShaLedgerApproveResult {
		const entry = this.requireEntry(worktreePath);
		const lastApprovedSha = sha ?? readHeadSha(worktreePath);
		this.entries.set(worktreePath, { ...entry, lastApprovedSha });
		return { lastApprovedSha };
	}

	/**
	 * `undo = reset --hard <ref>` (spec §6, §12): resets the worktree to
	 * `lastApprovedSha` if one has been recorded, else falls back to
	 * `baseSha`. Actually runs `git reset --hard <sha>` against the real
	 * worktree — this discards uncommitted changes and moves `HEAD`.
	 */
	undo(worktreePath: string): ShaLedgerUndoResult {
		const entry = this.requireEntry(worktreePath);
		const resetTo = entry.lastApprovedSha ?? entry.baseSha;
		runGit(worktreePath, ["reset", "--hard", resetTo]);
		return { resetTo };
	}

	/** The concrete mechanism behind `awaiting_review` — see the standalone `isDirtyOrAhead` export. */
	isDirtyOrAhead(worktreePath: string, baseSha: string): boolean {
		return isDirtyOrAhead(worktreePath, baseSha);
	}

	/** Current ledger bookkeeping for a worktree, or `undefined` if it was never `record()`ed. */
	get(worktreePath: string): ShaLedgerEntry | undefined {
		const entry = this.entries.get(worktreePath);
		return entry ? { ...entry } : undefined;
	}

	private requireEntry(worktreePath: string): ShaLedgerEntry {
		const entry = this.entries.get(worktreePath);
		if (!entry) {
			throw new ShaLedgerError(`no ledger entry recorded for worktree: ${worktreePath} (call record() first)`);
		}
		return entry;
	}
}
