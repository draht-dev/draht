import type { AgentMessage } from "../../../types.ts";
import type { TerminalOperationOutcome } from "../../agent-harness.ts";
import type { Context } from "../../context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	LaneLastResult,
	MessageEntry,
	OperationState,
	SessionReader,
	SettledAssistantMessage,
	Write,
} from "../../session/types.ts";
import {
	deleteList,
	deleteValue,
	operationMeta,
	operationPreparationPrefix,
	operationState as operationStateValue,
	operationToolArgsPrefix,
	operationToolMemoPrefix,
	pendingAssistantFrames,
	pendingEntry,
	pendingToolOutputPrefix,
} from "../../session/values.ts";

/** Build the mechanical operation-owned suffix used by an owning procedure's terminal transaction. */
export async function operationCleanupWrites(
	reader: SessionReader,
	operationId: string,
	state: OperationState,
	context: Context,
): Promise<Write[]> {
	const [toolArguments, toolMemos, preparations, toolOutputs] = await Promise.all([
		reader.scanValues(operationToolArgsPrefix(operationId), context),
		reader.scanValues(operationToolMemoPrefix(operationId), context),
		reader.scanValues(operationPreparationPrefix(operationId), context),
		reader.scanValues(pendingToolOutputPrefix(operationId), context),
	]);

	const pendingIds = new Set<string>();
	if (state.kind === "run") {
		for (const id of state.inbox.steer) pendingIds.add(id);
		for (const id of state.inbox.followUp) pendingIds.add(id);
		for (const id of state.inbox.writes) pendingIds.add(id);
		if (state.phase.kind === "tools") {
			for (const call of state.phase.batch.calls) {
				if (call.status === "outcome_ready") pendingIds.add(call.resultEntryId);
			}
		}
	}
	if (state.control.status === "cancel_requested") {
		for (const id of state.control.drainedSteer) pendingIds.add(id);
		for (const id of state.control.drainedFollowUp) pendingIds.add(id);
	}

	let frameDelete: Write | undefined;
	if (state.kind === "run" && state.phase.kind === "assistant") {
		const generation = state.phase.generation;
		if (generation.status === "effect_pending") {
			frameDelete = deleteList(pendingAssistantFrames(operationId, generation.responseEntryId));
		}
	} else if (state.kind === "run" && state.phase.kind === "deferred") {
		const deferred = state.phase.deferred;
		if (deferred.status === "effect_pending") {
			frameDelete = deleteList(pendingAssistantFrames(operationId, deferred.responseEntryId));
		}
	}

	return [
		deleteValue(operationMeta(operationId)),
		deleteValue(operationStateValue(operationId)),
		...toolArguments.map(({ address }) => deleteValue(address)),
		...toolMemos.map(({ address }) => deleteValue(address)),
		...preparations.map(({ address }) => deleteValue(address)),
		...toolOutputs.map(({ address }) => deleteValue(address)),
		...(frameDelete === undefined ? [] : [frameDelete]),
		...[...pendingIds].map((id) => deleteValue(pendingEntry(id))),
	];
}

function isSettledAssistantMessage(message: AgentMessage): message is SettledAssistantMessage {
	return message.role === "assistant" && message.stopReason !== "pending";
}

async function requireMessageEntry(
	reader: SessionReader,
	entryId: string,
	context: Context,
): Promise<MessageEntry & { message: SettledAssistantMessage }> {
	const entry = (await reader.getEntries([entryId], context)).get(entryId);
	if (entry?.type !== "message") {
		throw new SessionInvariantError(`Terminal result references invalid assistant ${entryId}`);
	}
	const message = entry.message;
	if (!isSettledAssistantMessage(message)) {
		throw new SessionInvariantError(`Terminal result references invalid assistant ${entryId}`);
	}
	return { ...entry, message };
}

async function requireCompactionEntry(
	reader: SessionReader,
	entryId: string,
	context: Context,
): Promise<CompactionEntry> {
	const entry = (await reader.getEntries([entryId], context)).get(entryId);
	if (entry?.type !== "compaction") {
		throw new SessionInvariantError(`Terminal result references invalid compaction ${entryId}`);
	}
	return entry;
}

async function requireSummaryEntry(
	reader: SessionReader,
	entryId: string,
	context: Context,
): Promise<BranchSummaryEntry> {
	const entry = (await reader.getEntries([entryId], context)).get(entryId);
	if (entry?.type !== "branch_summary") {
		throw new SessionInvariantError(`Terminal result references invalid branch summary ${entryId}`);
	}
	return entry;
}

/** Hydrate one bounded public terminal outcome from the latest-result value's direct references. */
export async function hydrateTerminalOutcome(
	reader: SessionReader,
	lastResult: LaneLastResult,
	context: Context,
): Promise<TerminalOperationOutcome> {
	if (lastResult.kind === "run") {
		if (lastResult.outcome === "completed") {
			if (lastResult.runCompletion === "terminated_tools") {
				if (lastResult.finalAssistantEntryId !== undefined) {
					throw new SessionInvariantError("Terminated-tools result cannot reference a final assistant");
				}
				return {
					operation: "run",
					runId: lastResult.operationId,
					kind: "completed",
					tipId: lastResult.tipId,
				};
			}
			if (lastResult.finalAssistantEntryId === undefined) {
				throw new SessionInvariantError("Assistant-completed result is missing its final assistant");
			}
			const entry = await requireMessageEntry(reader, lastResult.finalAssistantEntryId, context);
			return {
				operation: "run",
				runId: lastResult.operationId,
				kind: "completed",
				tipId: lastResult.tipId,
				finalEntryId: entry.id,
				finalMessage: entry.message,
			};
		}

		const final =
			lastResult.finalAssistantEntryId === undefined
				? {}
				: await requireMessageEntry(reader, lastResult.finalAssistantEntryId, context).then((entry) => ({
						finalEntryId: entry.id,
						finalMessage: entry.message,
					}));
		return lastResult.outcome === "failed"
			? {
					operation: "run",
					runId: lastResult.operationId,
					kind: "failed",
					tipId: lastResult.tipId,
					error: lastResult.error,
					...final,
				}
			: {
					operation: "run",
					runId: lastResult.operationId,
					kind: "aborted",
					tipId: lastResult.tipId,
					...final,
				};
	}

	if (lastResult.kind === "compaction") {
		if (lastResult.outcome === "completed") {
			const entry = await requireCompactionEntry(reader, lastResult.tipId, context);
			return {
				operation: "compaction",
				runId: lastResult.operationId,
				kind: "completed",
				tipId: lastResult.tipId,
				entry,
			};
		}
		if (lastResult.outcome === "failed") {
			return {
				operation: "compaction",
				runId: lastResult.operationId,
				kind: "failed",
				tipId: lastResult.tipId,
				error: lastResult.error,
			};
		}
		return {
			operation: "compaction",
			runId: lastResult.operationId,
			kind: lastResult.outcome,
			tipId: lastResult.tipId,
		};
	}

	if (lastResult.outcome === "completed") {
		const summaryEntry =
			lastResult.summaryEntryId === undefined
				? undefined
				: await requireSummaryEntry(reader, lastResult.summaryEntryId, context);
		if (
			summaryEntry !== undefined &&
			(summaryEntry.id !== lastResult.tipId || summaryEntry.fromId !== lastResult.oldTipId)
		) {
			throw new SessionInvariantError("Completed navigation summary contradicts its terminal result");
		}
		return {
			operation: "navigation",
			runId: lastResult.operationId,
			kind: "completed",
			oldTipId: lastResult.oldTipId,
			newTipId: lastResult.tipId,
			...(summaryEntry === undefined ? {} : { summaryEntry }),
		};
	}
	if (lastResult.outcome === "failed") {
		return {
			operation: "navigation",
			runId: lastResult.operationId,
			kind: "failed",
			tipId: lastResult.tipId,
			error: lastResult.error,
		};
	}
	return {
		operation: "navigation",
		runId: lastResult.operationId,
		kind: lastResult.outcome,
		tipId: lastResult.tipId,
	};
}
