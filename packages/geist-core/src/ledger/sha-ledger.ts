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

/**
 * What git says about a worktree at turn end. Mirrors the fleet wire's
 * `SessionStatus` (`geist-protocol`'s `wire.ts`) value for value, deliberately:
 * one vocabulary for "what is the state of this working tree", whether it is
 * read by a session for its own status or by the daemon for a phone. The type
 * is declared here rather than imported because `geist-core` owns this
 * question and the protocol package owns how it travels.
 */
export type WorktreeReviewState = "clean" | "dirty" | "no_repo" | "unknown";

/** Raised for git subprocess failures and for operating on a worktree with no `record()`ed entry. */
export class ShaLedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ShaLedgerError";
	}
}

/**
 * How long any one git call here gets.
 *
 * Same 500 ms as the fleet's status probe (`attach/status-probe.ts`), for the
 * same measured reasons. It matters less here — these calls are made by a
 * session's own turn, not by a daemon serving every connected phone — but a git
 * call with NO bound is a turn that never ends, and that was the shape this
 * file had.
 */
const GIT_DEADLINE_MS = 500;

/**
 * Runs `git <args>` in `cwd`, returning trimmed stdout. Throws `ShaLedgerError`
 * on any non-zero exit, on a spawn failure, and on the deadline.
 *
 * `killSignal: "SIGKILL"` is not a preference. `spawnSync`'s default is SIGTERM,
 * a child that traps TERM survives it — measured, still blocked at 15 s against
 * a 500 ms bound — and `timeout` without a signal that lands is decoration. What
 * this CANNOT do is take the child's own children with it: `spawnSync` signals
 * the direct child only. The fleet probe, which is the one an untrusted peer can
 * trigger, spawns detached and kills the whole process group; this path is
 * reached from a session's own turn and is bounded, not hardened.
 */
function runGit(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: GIT_DEADLINE_MS,
		killSignal: "SIGKILL",
		// `isNoRepo` matches git's own wording, and git translates its messages;
		// under a localized shell the ordinary "not a repository" case would be
		// classified as a refusal instead.
		env: { ...process.env, LC_ALL: "C" },
	});

	if (result.error) {
		throw new ShaLedgerError(`failed to run "git ${args.join(" ")}" in ${cwd}: ${result.error.message}`);
	}
	if (result.signal !== null) {
		throw new ShaLedgerError(
			`"git ${args.join(" ")}" in ${cwd} did not answer inside ${GIT_DEADLINE_MS}ms (killed with ${result.signal})`,
		);
	}
	if (result.status !== 0) {
		const stderr = result.stderr.trim();
		throw new ShaLedgerError(`"git ${args.join(" ")}" failed in ${cwd} (exit ${result.status}): ${stderr}`);
	}

	return result.stdout.trim();
}

/** Whether a failure is git saying "this is not a repository" rather than refusing. */
function isNoRepo(error: unknown): boolean {
	return error instanceof ShaLedgerError && /not a git repository/i.test(error.message);
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
 * The review state of a worktree — the concrete mechanism behind spec §12's
 * `awaiting_review` rule, "git is dirty/ahead (git is the truth, not the
 * agent's claim)".
 *
 * FOUR VALUES, AND IT USED TO BE A BOOLEAN. `isDirtyOrAhead()` caught every
 * `ShaLedgerError` and returned `false`, and `false` means "nothing to review".
 * So a worktree git refused to read — dubious ownership (verified: exit 128 on
 * a genuinely dirty tree), a corrupt index, a `cwd` that had been deleted, no
 * git on PATH at all — ended a turn as `running`, silently, forever. That is
 * the fail-open this replaces, and a deadline alone would not have touched it:
 * a deadline bounds the hang, not the lie.
 *
 *   `clean`   a repository at `baseSha` with nothing uncommitted
 *   `dirty`   uncommitted changes, OR `HEAD` ahead of `baseSha`. The two are
 *             one value because they mean the same thing to a reviewer: there
 *             is work here that has not been approved.
 *   `no_repo` `cwd` is not inside a repository. An ordinary answer — geist's
 *             own `null`-base fallback exists for exactly this case — and not
 *             a failure.
 *   `unknown` git refused, could not be run, or did not answer. NEVER `clean`.
 *
 * MUST NOT BE COERCED BACK TO A BOOLEAN at any call site. The whole point of
 * the fourth value is that a caller has to decide what to do about not knowing,
 * and a boolean makes that decision invisibly, in the safest-looking direction.
 *
 * `baseSha` may be `null` for a session whose spawn `cwd` had no resolvable
 * `HEAD`; with no base to compare against, only the dirty half applies.
 *
 * @param worktreePath - The worktree to inspect.
 * @param baseSha - The commit the worktree was spawned from, or null.
 */
export function worktreeReviewState(worktreePath: string, baseSha: string | null): WorktreeReviewState {
	let dirty: boolean;
	try {
		dirty = isWorkingTreeDirty(worktreePath);
	} catch (error) {
		if (isNoRepo(error)) return "no_repo";
		if (error instanceof ShaLedgerError) return "unknown";
		throw error;
	}
	if (dirty) return "dirty";
	if (baseSha === null) return "clean";

	try {
		return isAheadOf(worktreePath, baseSha) ? "dirty" : "clean";
	} catch (error) {
		if (error instanceof ShaLedgerError) {
			// The tree is provably not dirty, but whether it is AHEAD is unreadable.
			// Reporting `clean` here is precisely the old bug: `rev-list` fails on a
			// base sha that no longer exists (a rebased or pruned branch), which is
			// exactly when unapproved commits are most likely to be sitting there.
			return "unknown";
		}
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

	/** The concrete mechanism behind `awaiting_review` — see {@link worktreeReviewState}. */
	reviewState(worktreePath: string, baseSha: string): WorktreeReviewState {
		return worktreeReviewState(worktreePath, baseSha);
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
