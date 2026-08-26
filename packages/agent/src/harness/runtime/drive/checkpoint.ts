import type { AgentMessage } from "../../../types.ts";
import type { TerminalOperationOutcome } from "../../agent-harness.ts";
import { insertEntry } from "../../session/commit.ts";
import { buildSessionContext } from "../../session/context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type Entry,
	type LaneLastResult,
	type MessageEntry,
	type NewEntry,
	type RunAssistantReadyOperation,
	type RunCheckpointOperation,
	type RunStartingOperation,
	runScopeOf,
	type SettledAssistantMessage,
} from "../../session/types.ts";
import { branchTip, deleteValue, pendingEntry, setValue } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import { chainEntries, entryLifecycleEvents, readPendingMessages } from "../transcript.ts";
import type { ContinueOperationResult, Drive, ProcedureResult } from "../types.ts";
import { operationCleanupWrites } from "./terminal.ts";

type FinishContinuation = Extract<RunCheckpointOperation["continuation"], { kind: "may_finish" }>;

function isSettledAssistant(message: AgentMessage): message is SettledAssistantMessage {
	return message.role === "assistant" && message.stopReason !== "pending";
}

async function readRunContext<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
): Promise<ContinueOperationResult<AgentMessage[]>> {
	const entries = await lane.continueOperation(
		checkpoint,
		async (state, _current, _meta, reader) => {
			if (state.tipId === null) throw new SessionInvariantError("Run checkpoint has no Branch tip");
			const path = (
				await reader.scanBranch(
					{ start: state.tipId, stopAtType: "compaction", order: "newestFirst" },
					drive.context,
				)
			).reverse();
			return { kind: "return", result: path };
		},
		drive.context,
	);
	if (entries.kind === "cancel_requested") return entries;
	return {
		kind: "result",
		value: await buildSessionContext(
			entries.value,
			{ entryProjectors: lane.readConfig().entryProjectors },
			drive.context,
		),
	};
}

/** Consume before_run and commit the initial checkpoint. */
export async function startRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunStartingOperation,
): Promise<ProcedureResult> {
	const prompt = await lane.continueOperation(
		run,
		async (_state, _current, meta, reader) => {
			if (meta.intent.kind !== "run") throw new SessionInvariantError("Run operation has non-run intent");
			const entries = await reader.getEntries(meta.intent.promptEntryIds, drive.context);
			const messages = meta.intent.promptEntryIds.map((id) => {
				const entry = entries.get(id);
				if (entry?.type !== "message") {
					throw new SessionInvariantError(`Run prompt entry ${id} is missing its message`);
				}
				return entry.message;
			});
			return { kind: "return", result: messages };
		},
		drive.context,
	);
	if (prompt.kind === "cancel_requested") return { kind: "continue" };

	const hook = await lane.hooks.runWithGate(
		"before_run",
		{ lane: lane.name, runId: drive.operationId, prompt: prompt.value, resources: lane.readConfig().resources },
		drive.gate,
		drive.context,
	);
	const injected = hook?.messages ?? [];
	for (const message of injected) {
		if (message.role === "assistant" && message.stopReason === "pending") {
			throw new SessionInvariantError("before_run returned a pending assistant message");
		}
	}
	const reserved = injected.map((message) => ({ id: lane.session.idGenerator.next(), message }));

	const result = await lane.continueOperation(
		run,
		(state, current) => {
			const entries: NewEntry<MessageEntry>[] = chainEntries(
				state.tipId,
				reserved.map(({ id, message }) => ({ id, type: "message" as const, message })),
			);
			const triggerEntryId = entries.at(-1)?.id ?? state.tipId;
			if (triggerEntryId === null) throw new SessionInvariantError("Run start has no trigger entry");
			const nextState: RunCheckpointOperation = {
				...runScopeOf(current),
				at: "run.checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId,
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...(entries.length === 0 ? [] : [setValue(branchTip(lane.name), triggerEntryId)]),
				],
				operationState: nextState,
				lane: { tipId: triggerEntryId },
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) =>
					entries.flatMap((entry, index) =>
						entryLifecycleEvents(
							{ ...entry, seq: commit.seqs[index]!, timestamp: commit.timestamp },
							lane.name,
							drive.operationId,
						),
					),
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

async function applyPendingWrites<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		checkpoint,
		async (state, current, _meta, reader) => {
			const ids = current.inbox.writes;
			if (ids.length === 0) return { kind: "return", result: { kind: "continue" } as const };
			const pending = await Promise.all(
				ids.map(async (id) => {
					const value = await reader.getValue(pendingEntry(id), drive.context);
					if (value === undefined) throw new SessionInvariantError(`Pending write ${id} is missing its payload`);
					return { id, pending: value.value };
				}),
			);
			let parentId = state.tipId;
			let triggerEntryId: string | undefined;
			const entries: NewEntry[] = pending.map(({ id, pending: item }) => {
				const entry: NewEntry =
					item.type === "message"
						? { id, parentId, type: "message", message: item.payload }
						: {
								id,
								parentId,
								type: "custom",
								customType: item.customType,
								...(item.payload === undefined ? {} : { data: item.payload }),
							};
				parentId = id;
				if (item.type === "message" || lane.readConfig().entryProjectors[item.customType] !== undefined) {
					triggerEntryId = id;
				}
				return entry;
			});
			const inbox = { ...current.inbox, writes: [] };
			const nextState: RunCheckpointOperation =
				triggerEntryId === undefined
					? { ...current, inbox }
					: {
							...runScopeOf(current),
							inbox,
							at: "run.checkpoint",
							continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
							triggerEntryId,
							skipInboxOnce: true,
						};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...ids.map((id) => deleteValue(pendingEntry(id))),
					setValue(branchTip(lane.name), parentId),
				],
				operationState: nextState,
				lane: { tipId: parentId },
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) =>
					entries.flatMap((entry, index) =>
						entryLifecycleEvents(
							{ ...entry, seq: commit.seqs[index]!, timestamp: commit.timestamp } as Entry,
							lane.name,
							drive.operationId,
						),
					),
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

async function consumeQueuedMessages<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
	queue: "steer" | "followUp",
): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		checkpoint,
		async (state, current, _meta, reader) => {
			const allIds = current.inbox[queue];
			const mode = queue === "steer" ? current.settings.steeringMode : current.settings.followUpMode;
			const ids = mode === "all" ? allIds : allIds.slice(0, 1);
			if (ids.length === 0) return { kind: "return", result: { kind: "continue" } as const };
			const messages = (await readPendingMessages(reader, ids, `Queued ${queue} entry`, drive.context)).map(
				({ entryId, message }) => ({ id: entryId, message }),
			);
			const remainingSteerIds = queue === "steer" ? allIds.slice(ids.length) : current.inbox.steer;
			const remainingFollowUpIds = queue === "followUp" ? allIds.slice(ids.length) : current.inbox.followUp;
			const [remainingSteer, remainingFollowUp, nextRun] = await Promise.all([
				readPendingMessages(reader, remainingSteerIds, "Steer entry", drive.context),
				readPendingMessages(reader, remainingFollowUpIds, "Follow-up entry", drive.context),
				readPendingMessages(reader, state.pendingNextRun, "Pending next-run entry", drive.context),
			]);
			const entries: NewEntry<MessageEntry>[] = chainEntries(
				state.tipId,
				messages.map(({ id, message }) => ({ id, type: "message" as const, message })),
			);
			const triggerEntryId = messages[messages.length - 1]!.id;
			const nextState: RunCheckpointOperation = {
				...runScopeOf(current),
				at: "run.checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId,
				skipInboxOnce: true,
				inbox: { ...current.inbox, [queue]: allIds.slice(ids.length) },
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...ids.map((id) => deleteValue(pendingEntry(id))),
					setValue(branchTip(lane.name), triggerEntryId),
				],
				operationState: nextState,
				lane: { tipId: triggerEntryId },
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) => [
					...entries.flatMap((entry, index) =>
						entryLifecycleEvents(
							{ ...entry, seq: commit.seqs[index]!, timestamp: commit.timestamp },
							lane.name,
							drive.operationId,
						),
					),
					{
						type: "queue_update",
						lane: lane.name,
						steer: remainingSteer,
						followUp: remainingFollowUp,
						nextRun,
					},
				],
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

async function finishRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
	continuation: FinishContinuation,
): Promise<ProcedureResult> {
	const context = await readRunContext(lane, drive, checkpoint);
	if (context.kind === "cancel_requested") return { kind: "continue" };
	const hook = await lane.hooks.runWithGate(
		"before_run_end",
		{ lane: lane.name, runId: drive.operationId, messages: context.value },
		drive.gate,
		drive.context,
	);
	const followUp =
		hook?.followUp === undefined
			? undefined
			: {
					id: lane.session.idGenerator.next(),
					message: { role: "user" as const, content: hook.followUp, timestamp: Date.now() },
				};

	const result = await lane.continueOperation<RunCheckpointOperation, ProcedureResult>(
		checkpoint,
		async (state, current, _meta, reader) => {
			if (
				current.inbox.steer.length !== 0 ||
				current.inbox.followUp.length !== 0 ||
				current.inbox.writes.length !== 0
			) {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (followUp !== undefined) {
				const nextState: RunCheckpointOperation = {
					...runScopeOf(current),
					at: "run.checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: followUp.id,
				};
				const entry: NewEntry<MessageEntry> = {
					id: followUp.id,
					parentId: state.tipId,
					type: "message",
					message: followUp.message,
				};
				return {
					kind: "commit",
					writes: [insertEntry(entry), setValue(branchTip(lane.name), followUp.id)],
					operationState: nextState,
					lane: { tipId: followUp.id },
					materialize: () => ({ kind: "continue" }) as const,
					events: (commit) =>
						entryLifecycleEvents(
							{ ...entry, seq: commit.seqs[0]!, timestamp: commit.timestamp },
							lane.name,
							drive.operationId,
						),
				};
			}

			if (state.tipId === null) throw new SessionInvariantError("Completed run has no tip");
			const finalId = continuation.includeFinalAssistant ? current.latestAssistantEntryId : null;
			if (continuation.includeFinalAssistant && finalId === null) {
				throw new SessionInvariantError("Completed run is missing its final assistant");
			}
			let finalEntry: { id: string; message: SettledAssistantMessage } | undefined;
			if (finalId !== null) {
				const entry = (await reader.getEntries([finalId], drive.context)).get(finalId);
				if (entry?.type !== "message") {
					throw new SessionInvariantError(`Run finish references invalid assistant ${finalId}`);
				}
				const message = entry.message;
				if (!isSettledAssistant(message)) {
					throw new SessionInvariantError(`Run finish references invalid assistant ${finalId}`);
				}
				finalEntry = { id: finalId, message };
			}
			const final =
				finalEntry === undefined ? {} : { finalEntryId: finalEntry.id, finalMessage: finalEntry.message };
			const outcome: TerminalOperationOutcome = {
				operation: "run",
				runId: drive.operationId,
				kind: "completed",
				tipId: state.tipId,
				...final,
			};
			const lastResult: LaneLastResult = {
				operationId: drive.operationId,
				kind: "run",
				outcome: "completed",
				tipId: state.tipId,
				runCompletion: finalId === null ? "terminated_tools" : "assistant",
				...(finalId === null ? {} : { finalAssistantEntryId: finalId }),
			};
			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			return {
				kind: "finish",
				writes: cleanup,
				lastResult,
				materialize: () => ({ kind: "settled", outcome }) as const,
				events: () => [
					{
						type: "run_end",
						lane: lane.name,
						runId: drive.operationId,
						tipId: state.tipId,
						outcome: "completed",
						...final,
					},
				],
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

/** Advance one durable run checkpoint by one visible transition. */
export async function runCheckpoint<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunCheckpointOperation,
): Promise<ProcedureResult> {
	if (run.skipInboxOnce !== true && run.inbox.writes.length !== 0) {
		return applyPendingWrites(lane, drive, run);
	}
	if (run.skipInboxOnce !== true && run.inbox.steer.length !== 0) {
		return consumeQueuedMessages(lane, drive, run, "steer");
	}
	const continuation = run.continuation;
	if (continuation.kind === "need_assistant") {
		const overflowRecoveryUsed = continuation.overflowRecoveryUsed;
		const config = lane.readConfig();
		const retryPolicy = config.retryPolicy.enabled
			? { maxAttempts: config.retryPolicy.maxRetries + 1, baseDelayMs: config.retryPolicy.baseDelayMs }
			: { maxAttempts: 1, baseDelayMs: config.retryPolicy.baseDelayMs };
		const stepId = lane.session.idGenerator.next();
		const result = await lane.continueOperation(
			run,
			(state, current) => {
				if (
					current.skipInboxOnce !== true &&
					(current.inbox.writes.length !== 0 || current.inbox.steer.length !== 0)
				) {
					return { kind: "return", result: { kind: "continue" } as const };
				}
				const nextState: RunAssistantReadyOperation = {
					...runScopeOf(current),
					at: "run.assistant.ready",
					generationContext: {
						stepId,
						triggerEntryId: current.triggerEntryId,
						configuration: state.configuration,
						streamOptions: config.streamOptions,
						retryPolicy,
						overflowRecoveryUsed,
					},
					nextAttempt: 1,
				};
				return {
					kind: "commit",
					writes: [],
					operationState: nextState,
					materialize: () => ({ kind: "continue" }) as const,
				};
			},
			drive.context,
		);
		return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
	}
	if (run.inbox.followUp.length !== 0) {
		return consumeQueuedMessages(lane, drive, run, "followUp");
	}
	return finishRun(lane, drive, run, continuation);
}
