/**
 * Checkpoints builtin (Phase 41) — wires working-tree capture into the session
 * lifecycle. Always loaded via `CORE_BUILTIN_EXTENSIONS`, so `/rewind` can rely
 * on snapshots existing without any opt-in.
 *
 * Capture is keyed to the session entry that initiated the turn:
 * - turn 0's `turn_start` fires before the user message is persisted, so the
 *   first snapshot is taken on the assistant's `message_start` instead, when
 *   the leaf is the user message that started the turn;
 * - later turns capture on `turn_start` against the current leaf.
 * Duplicate captures across both seams collapse via the manager's tree-hash dedup.
 *
 * Phase 42 adds the `/tree` and `/fork` restore offers (R42-RWD.7), hung off the
 * existing `session_before_tree` / `session_before_fork` seams. The offer is
 * asked on the `*_before_*` seam but, for `/tree`, applied on `session_tree` —
 * see `acceptedTreeRestore`.
 */

import { propagateCheckpointSidecar } from "../checkpoints/checkpoint-manager.ts";
import { describeRestore, describeSnapshotRecovery, isRewindInProgress } from "../checkpoints/rewind.ts";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.ts";

/** Which navigation the restore offer is attached to; only the wording differs. */
type RestoreFlow = "tree" | "fork";

/**
 * What the offer promises about getting the current files back.
 *
 * `/tree` keys the safety snapshot to the leaf it is navigating away from, and
 * that entry stays in the same session's tree, so `/rewind` in this session
 * really can return to it. `/fork` lands the user in a *different* session,
 * whose sidecar only carries records for entries the fork preserved — the
 * safety record is keyed to a leaf the fork drops, so it is not reachable from
 * there. That flow must not promise an undo it cannot deliver: it names the
 * snapshot ref and where the undo actually lives once the restore is done.
 */
const UNDO_PROMISE: Record<RestoreFlow, string> = {
	tree: "Your current files are snapshotted first, so /rewind can bring them back.",
	fork: "Your current files are snapshotted first, but the forked session cannot /rewind to that snapshot - where it can be reached from is printed once the restore is done.",
};

/** A restore offer the user accepted, resolved but not necessarily applied yet. */
interface AcceptedRestore {
	targetEntryId: string;
	/** Leaf the offer was made from; the safety snapshot is keyed to it. */
	currentEntryId: string;
}

export default function checkpointsBuiltin(pi: ExtensionAPI) {
	let noticeShown = false;

	/**
	 * A `/tree` restore the user accepted on `session_before_tree`, held until
	 * `session_tree` reports the navigation actually committed (R42-RWD.5).
	 *
	 * `session_before_tree` is cancelable and runs before the leaf moves: a
	 * later handler can still veto it, branch summarization can be aborted, and
	 * the navigation can throw. Restoring from that seam would leave the working
	 * tree rewound while the conversation stayed where it was.
	 */
	let acceptedTreeRestore: AcceptedRestore | undefined;

	async function capture(entryId: string, ctx: ExtensionContext): Promise<void> {
		const result = await pi.checkpoints.capture(entryId);
		if (result.status === "disabled" && !noticeShown) {
			noticeShown = true;
			ctx.ui.notify(
				`Checkpoints are off: ${ctx.cwd} is not inside a git repository. /rewind will restore the conversation only.`,
				"warning",
			);
		}
	}

	/**
	 * Ask whether to restore the working tree alongside a conversation move
	 * (R42-RWD.7). Declining restores nothing — not even a safety snapshot —
	 * and the navigation or fork continues either way, because this handler
	 * never returns `cancel`.
	 *
	 * Returns the accepted restore; `undefined` means "do not restore".
	 */
	async function confirmRestore(
		targetEntryId: string,
		ctx: ExtensionContext,
		flow: RestoreFlow,
	): Promise<AcceptedRestore | undefined> {
		// `/rewind` already asked for a scope and moves the leaf through
		// navigateTree; without this it would be asked a second time here.
		// Read the session id AT CALL TIME, and scope the question to it: the
		// gate must survive session replacement, and one process can host
		// several sessions, only one of which may be rewinding (R35-ALWAYS.5).
		if (isRewindInProgress(ctx.sessionManager.getSessionId())) return undefined;
		// Nothing to ask with, and files are never restored unprompted.
		if (!ctx.hasUI) return undefined;

		const record = pi.checkpoints.get(targetEntryId);
		if (!record) return undefined;

		const currentEntryId = ctx.sessionManager.getLeafId();
		if (!currentEntryId || currentEntryId === targetEntryId) return undefined;

		// Rewriting the working tree while the agent is still writing to it
		// would race those writes and poison the safety snapshot, which is
		// taken from that same moving tree. Refuse instead: a refusal the user
		// can retry is recoverable, a half-overwritten tree is not.
		if (!ctx.isIdle()) {
			ctx.ui.notify(
				"Files not restored: the agent is still running. Stop it first (Esc), then restore the working tree with /rewind.",
				"warning",
			);
			return undefined;
		}

		const files = record.dirtyFileCount === 1 ? "1 file" : `${record.dirtyFileCount} files`;
		const accepted = await ctx.ui.confirm(
			"Restore files?",
			`This point has a checkpoint from ${record.timestamp} (${files} changed). Restore the working tree to it? ${UNDO_PROMISE[flow]}`,
		);
		if (!accepted) return undefined;
		return { targetEntryId, currentEntryId };
	}

	/** Apply an accepted restore offer and report what happened. */
	async function applyRestore(accepted: AcceptedRestore, ctx: ExtensionContext, flow: RestoreFlow): Promise<void> {
		const result = await pi.checkpoints.restore(accepted);
		const ok = result.status === "restored" || result.status === "unchanged";
		let message = describeRestore(result);
		// `/fork` cannot offer the forked session's /rewind as the undo (see
		// UNDO_PROMISE), so this has to say where the undo really is, or the
		// offer promised something that does not exist. The session being
		// forked from keeps the safety record in its own sidecar, keyed to the
		// leaf it was taken at, so /rewind there is still the exact undo.
		if (result.status === "restored" && flow === "fork" && result.safety) {
			message += `. Your files from before the restore are kept at ${result.safety.ref}: resume the session you forked from and /rewind to its current point with scope "Files only", or write the contents back with ${describeSnapshotRecovery(result.safety.ref)} from the repository root`;
		}
		ctx.ui.notify(message, ok ? "info" : "error");
	}

	pi.on("turn_start", async (event, ctx) => {
		// Turn 0 fires before the initiating user message is persisted, so the
		// leaf would be stale or missing; message_start covers that turn.
		if (event.turnIndex === 0) return;
		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;
		await capture(leafId, ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf || leaf.type !== "message" || leaf.message.role !== "user") return;
		await capture(leaf.id, ctx);
	});

	pi.on("session_before_tree", async (event, ctx) => {
		// Cleared unconditionally, ahead of every early return in
		// `confirmRestore`: a decision that never reached `session_tree`
		// (cancelled navigation, aborted summary) must not be applied to some
		// later, unrelated navigation.
		acceptedTreeRestore = undefined;
		acceptedTreeRestore = await confirmRestore(event.preparation.targetId, ctx, "tree");
	});

	pi.on("session_tree", async (_event, ctx) => {
		const accepted = acceptedTreeRestore;
		acceptedTreeRestore = undefined;
		if (!accepted || !ctx.hasUI) return;
		// The leaf has moved by now, so the conversation cannot end up ahead of
		// or behind the files: either both moved or neither did.
		await applyRestore(accepted, ctx, "tree");
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const accepted = await confirmRestore(event.entryId, ctx, "fork");
		if (!accepted) return;
		await applyRestore(accepted, ctx, "fork");
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "fork" || !event.previousSessionFile) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile || sessionFile === event.previousSessionFile) return;

		// /fork drops descendants of the branch point; /clone keeps everything.
		// Either way the surviving entry ids decide which records carry over.
		const preserved = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
		propagateCheckpointSidecar(event.previousSessionFile, sessionFile, preserved);
	});
}
