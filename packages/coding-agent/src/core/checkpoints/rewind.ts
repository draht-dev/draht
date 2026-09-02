/**
 * Rewind coordination (Phase 42) — the scope semantics behind `/rewind`.
 *
 * `CheckpointManager` owns the git side (safety snapshot, diff-driven restore,
 * rollback). This module owns the user-visible half: which entries can be
 * rewound to, what the three restore scopes mean, and the guarantee that each
 * scope touches exactly its own half of the state (R42-RWD.2), with the
 * conversation leaf never moving ahead of the working tree (R42-RWD.5).
 */

import type { SessionBeforeRewindEvent, SessionBeforeRewindResult } from "../extensions/types.ts";
import type { CheckpointManager, CheckpointRecord, CheckpointRestoreResult } from "./checkpoint-manager.ts";

/** Which half (or halves) of the session state a rewind restores. */
export type RewindScope = "conversation-and-files" | "conversation-only" | "files-only";

export interface RewindScopeChoice {
	scope: RewindScope;
	/** Menu label; also what `rewindScopeForLabel` maps back to a scope. */
	label: string;
}

/** Scope menu (R42-RWD.2). First entry is the default. */
export const REWIND_SCOPE_CHOICES: readonly RewindScopeChoice[] = [
	{ scope: "conversation-and-files", label: "Conversation + files" },
	{ scope: "conversation-only", label: "Conversation only" },
	{ scope: "files-only", label: "Files only" },
] as const;

export const DEFAULT_REWIND_SCOPE: RewindScope = REWIND_SCOPE_CHOICES[0].scope;

/** Map a menu label back to its scope; `undefined` for anything unrecognised. */
export function rewindScopeForLabel(label: string): RewindScope | undefined {
	return REWIND_SCOPE_CHOICES.find((choice) => choice.label === label)?.scope;
}

/** A session entry the user can rewind to, with its checkpoint annotation. */
export interface RewindTarget {
	entryId: string;
	/** ISO-8601 capture time of the checkpoint. */
	timestamp: string;
	/** Files differing from HEAD when the checkpoint was captured. */
	dirtyFileCount: number;
}

/**
 * The rewindable entries for a session, newest record per entry id, in capture
 * order (R42-RWD.1).
 *
 * Captures are keyed to the user message that started a turn, so this is the
 * "checkpointed user messages" set — plus the abandoned leaves that pre-rewind
 * safety snapshots are keyed to, which is exactly what makes rewind-forward
 * reachable from the selector (R42-RWD.6).
 */
export function listRewindTargets(records: readonly CheckpointRecord[]): RewindTarget[] {
	const byEntry = new Map<string, RewindTarget>();
	for (const record of records) {
		// Later records win, matching `CheckpointManager.get()`.
		byEntry.set(record.entryId, {
			entryId: record.entryId,
			timestamp: record.timestamp,
			dirtyFileCount: record.dirtyFileCount,
		});
	}
	return [...byEntry.values()];
}

/**
 * The extension-runner slice `performRewind` needs to dispatch the cancelable
 * `session_before_rewind` event (R42-RWD.8). `ExtensionRunner` satisfies it
 * structurally; typing the seam this narrowly keeps the checkpoint layer free
 * of a dependency on the runner implementation.
 */
export interface RewindEventEmitter {
	hasHandlers(eventType: string): boolean;
	emit(event: SessionBeforeRewindEvent): Promise<SessionBeforeRewindResult | undefined>;
}

/**
 * In-flight rewinds per session id (R35-ALWAYS.5).
 *
 * A depth counter rather than a boolean so nesting can never clear the flag
 * early; keyed by session id rather than process-global because one process can
 * host more than one session — the SDK builds them directly, and under
 * default-on socket registration each is separately attachable. A process-wide
 * counter let session A's rewind suppress session B's restore offer, and
 * `confirmRestore` reports that suppression as `undefined`, which is
 * indistinguishable from "the user declined".
 *
 * `performRewind` is the only writer, always restores the count in a `finally`,
 * and DELETES the key at zero so a long-lived process cannot accumulate one
 * entry per session replacement.
 */
const activeRewinds = new Map<string, number>();

/**
 * True while a `performRewind` call for `sessionId` is in flight.
 *
 * `/rewind` moves the conversation leaf through `navigateTree`, which fires
 * `session_before_tree` — the same seam the checkpoints builtin uses to offer a
 * file restore on plain `/tree` navigation (R42-RWD.7). Without this guard the
 * user would be asked to restore files again in the middle of a rewind whose
 * scope they already chose.
 *
 * `sessionId` is REQUIRED on purpose: an optional parameter would silently keep
 * answering the old process-wide question at any call site a migration missed,
 * which is the exact defect this is removing.
 */
export function isRewindInProgress(sessionId: string): boolean {
	return (activeRewinds.get(sessionId) ?? 0) > 0;
}

export interface PerformRewindOptions {
	scope: RewindScope;
	/**
	 * Session this rewind belongs to. Scopes {@link isRewindInProgress} so a
	 * rewind in one session cannot suppress another session's restore offer
	 * (R35-ALWAYS.5). Required — see the note on `isRewindInProgress`.
	 */
	sessionId: string;
	/** Entry to rewind to. */
	targetEntryId: string;
	/** Current conversation leaf; the safety snapshot is keyed to it. */
	currentEntryId: string;
	/**
	 * Checkpoint manager for the session. Absent when checkpoints could not be
	 * set up at all (no session file); scopes that need files degrade to
	 * conversation-only.
	 */
	manager?: CheckpointManager;
	/** Moves the conversation leaf. Never called for `files-only`. */
	navigate: () => void | Promise<void>;
	/** Per-path progress seam, forwarded to the restore. */
	onPathRestored?: (path: string) => void | Promise<void>;
	/**
	 * Dispatches the cancelable `session_before_rewind` event before anything
	 * is captured, restored, or navigated. Omit it to skip the event entirely.
	 */
	runner?: RewindEventEmitter;
}

export interface PerformRewindResult {
	scope: RewindScope;
	/** Whether the file half did what the scope asked. */
	ok: boolean;
	/** Whether the conversation leaf moved. Always false for `files-only`. */
	navigated: boolean;
	/** Absent for `conversation-only` — that scope never touches the git side. */
	restore?: CheckpointRestoreResult;
	/** Set when `navigate()` itself threw. */
	navigateReason?: string;
	/** True when an extension vetoed the rewind via `session_before_rewind`. */
	cancelled?: boolean;
	/** One-line summary for the status area. */
	message: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fileCountLabel(count: number): string {
	return count === 1 ? "1 file" : `${count} files`;
}

/**
 * The exact command that writes a snapshot ref back over the working tree.
 *
 * `git restore --worktree` writes file contents and nothing else, keeping the
 * promise the capture side makes: the user's index, `HEAD`, stash and reflog
 * are never touched. Run from the repository root, because snapshot paths are
 * repository-relative.
 *
 * It restores every path the snapshot *contains*; paths added since are left
 * alone, so callers pair it with the caveat below rather than presenting it as
 * an exact tree swap. The exact swap is `/rewind` itself.
 */
export function describeSnapshotRecovery(ref: string): string {
	return `git restore --source=${ref} --worktree -- .`;
}

/** The half of the story `git restore` cannot do; always shown next to the command. */
const RECOVERY_CAVEAT = "then delete anything `git status` shows that the snapshot did not contain";

/**
 * Explain an `unrecoverable` restore (R42-RWD.3): the working tree is stranded
 * between two snapshots and the user needs the exact ref and command to get
 * back, not just an acknowledgement that something went wrong.
 */
function describeUnrecoverable(restore: CheckpointRestoreResult): string {
	const why = `${restore.reason ?? "unknown error"}; the rollback then failed too: ${restore.rollbackReason ?? "unknown error"}`;
	const head = `Restore and rollback both failed (${why}). Your working tree is between two snapshots and nothing was lost.`;
	const recover = restore.safety
		? `Fix the cause above, then get the files you had before the rewind back by running this from the repository root: ${describeSnapshotRecovery(restore.safety.ref)} (${RECOVERY_CAVEAT}).`
		: "No pre-rewind snapshot was captured, so the working tree is the one you started with.";
	const target = restore.target
		? ` The point you were rewinding to is kept at ${restore.target.ref} - same command with that ref.`
		: "";
	return `${head} ${recover}${target}`;
}

/** Human-readable outcome of the file half. */
export function describeRestore(restore: CheckpointRestoreResult): string {
	switch (restore.status) {
		case "restored":
			return `Restored ${fileCountLabel(restore.restored.length + restore.deleted.length)}`;
		case "unchanged":
			return "Files already matched this checkpoint";
		case "rolled-back":
			return `Restore failed, working tree rolled back: ${restore.reason ?? "unknown error"}`;
		case "unrecoverable":
			return describeUnrecoverable(restore);
		case "disabled":
			return "Files not restored (not a git repository)";
		default:
			return `Files not restored: ${restore.reason ?? "unknown error"}`;
	}
}

async function runNavigate(navigate: () => void | Promise<void>): Promise<string | undefined> {
	try {
		await navigate();
		return undefined;
	} catch (error) {
		return describeError(error);
	}
}

/**
 * Execute a rewind under one scope (R42-RWD.2).
 *
 * - `conversation-only` never calls the manager, so no snapshot is captured and
 *   no file is written or deleted.
 * - `files-only` never calls `navigate`, so the conversation leaf stays put.
 * - `conversation-and-files` goes through `CheckpointManager.rewind`, which
 *   moves the leaf only after the file restore succeeded (R42-RWD.5); a failed
 *   restore leaves the leaf where it was.
 *
 * Extensions get one veto through the cancelable `session_before_rewind` event
 * (R42-RWD.8), dispatched before the safety snapshot so a cancel leaves both
 * the working tree and the conversation exactly as they were.
 *
 * Never throws: failures are reported on the result.
 */
export async function performRewind(options: PerformRewindOptions): Promise<PerformRewindResult> {
	const { sessionId } = options;
	activeRewinds.set(sessionId, (activeRewinds.get(sessionId) ?? 0) + 1);
	try {
		return await runRewind(options);
	} finally {
		const remaining = (activeRewinds.get(sessionId) ?? 1) - 1;
		if (remaining > 0) activeRewinds.set(sessionId, remaining);
		else activeRewinds.delete(sessionId);
	}
}

async function runRewind(options: PerformRewindOptions): Promise<PerformRewindResult> {
	const { scope, manager, navigate, targetEntryId, currentEntryId, onPathRestored, runner } = options;

	if (runner?.hasHandlers("session_before_rewind")) {
		const result = await runner.emit({ type: "session_before_rewind", targetEntryId, currentEntryId, scope });
		if (result?.cancel) {
			return { scope, ok: false, navigated: false, cancelled: true, message: "Rewind cancelled by an extension" };
		}
	}

	if (scope === "conversation-only") {
		const navigateReason = await runNavigate(navigate);
		return {
			scope,
			ok: navigateReason === undefined,
			navigated: navigateReason === undefined,
			navigateReason,
			message: navigateReason ? `Rewind failed: ${navigateReason}` : "Rewound conversation (files untouched)",
		};
	}

	if (scope === "files-only") {
		if (!manager) {
			return { scope, ok: false, navigated: false, message: "Files not restored (checkpoints unavailable)" };
		}
		const restore = await manager.restore({ targetEntryId, currentEntryId, onPathRestored });
		const ok = restore.status === "restored" || restore.status === "unchanged";
		return {
			scope,
			ok,
			navigated: false,
			restore,
			message: `${describeRestore(restore)} (conversation untouched)`,
		};
	}

	if (!manager) {
		// No checkpoints at all: degrade to conversation-only rather than refusing.
		const navigateReason = await runNavigate(navigate);
		return {
			scope,
			ok: false,
			navigated: navigateReason === undefined,
			navigateReason,
			message: navigateReason
				? `Rewind failed: ${navigateReason}`
				: "Rewound conversation; files not restored (checkpoints unavailable)",
		};
	}

	const { restore, navigated, navigateReason } = await manager.rewind({
		targetEntryId,
		currentEntryId,
		onPathRestored,
		navigate,
	});

	if (restore.status === "disabled") {
		// Non-git cwd: the conversation still rewinds, with a clear notice.
		const reason = await runNavigate(navigate);
		return {
			scope,
			ok: false,
			navigated: reason === undefined,
			restore,
			navigateReason: reason,
			message: reason ? `Rewind failed: ${reason}` : `Rewound conversation. ${describeRestore(restore)}`,
		};
	}

	const restoreMessage = describeRestore(restore);
	return {
		scope,
		ok: navigated,
		navigated,
		restore,
		navigateReason,
		message: navigated
			? `Rewound conversation and files. ${restoreMessage}`
			: navigateReason
				? `${restoreMessage}, but the conversation did not move: ${navigateReason}`
				: `${restoreMessage}. Conversation left where it was`,
	};
}
