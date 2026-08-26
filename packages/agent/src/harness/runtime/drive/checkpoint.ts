import { insertEntry } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type AssistantReadyOperation,
	type CheckpointOperation,
	type MessageEntry,
	type NewEntry,
	operationScopeOf,
	type StartingOperation,
} from "../../session/types.ts";
import { branchTip, deleteValue, pendingEntry, setValue } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import {
	chainEntries,
	committedEntryEvents,
	entryLifecycleEvents,
	readBoundedContext,
	readPendingMessages,
} from "../transcript.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { runCompactionThreshold } from "./structural.ts";
import { operationCleanupWrites, operationResultRecord } from "./terminal.ts";

type FinishContinuation = Extract<CheckpointOperation["continuation"], { kind: "may_finish" }>;

/** Consume before_run and commit the initial checkpoint. */
export async function startRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: StartingOperation,
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
			const nextState: CheckpointOperation = {
				...operationScopeOf(current),
				at: "checkpoint",
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
				events: (commit) => committedEntryEvents(entries, commit, lane.name, drive.operationId),
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

async function applyPendingWrites<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: CheckpointOperation,
): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		checkpoint,
		async (state, current, _meta, reader) => {
			const items = state.inbox.filter((item) => item.kind === "write");
			const ids = items.map((item) => item.entryId);
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
			const inbox = state.inbox.filter((item) => item.kind !== "write");
			const nextState: CheckpointOperation =
				triggerEntryId === undefined
					? current
					: {
							...operationScopeOf(current),
							at: "checkpoint",
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
				lane: { tipId: parentId, inbox },
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) => committedEntryEvents(entries, commit, lane.name, drive.operationId),
			};
		},
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

async function consumeQueuedMessages<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: CheckpointOperation,
	queue: "steer" | "followUp",
): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		checkpoint,
		async (state, current, _meta, reader) => {
			const candidates = state.inbox.filter((item) => item.kind === queue);
			const mode = queue === "steer" ? current.settings.steeringMode : current.settings.followUpMode;
			const selected = mode === "all" ? candidates : candidates.slice(0, 1);
			const ids = selected.map((item) => item.entryId);
			if (ids.length === 0) return { kind: "return", result: { kind: "continue" } as const };
			const messages = (await readPendingMessages(reader, ids, `Queued ${queue} entry`, drive.context)).map(
				({ entryId, message }) => ({ id: entryId, message }),
			);
			const selectedIds = new Set(ids);
			const inbox = state.inbox.filter((item) => !selectedIds.has(item.entryId));
			const remainingIds = (kind: "steer" | "followUp" | "nextRun") =>
				inbox.filter((item) => item.kind === kind).map((item) => item.entryId);
			const [remainingSteer, remainingFollowUp, nextRun] = await Promise.all([
				readPendingMessages(reader, remainingIds("steer"), "Steer entry", drive.context),
				readPendingMessages(reader, remainingIds("followUp"), "Follow-up entry", drive.context),
				readPendingMessages(reader, remainingIds("nextRun"), "Pending next-run entry", drive.context),
			]);
			const entries: NewEntry<MessageEntry>[] = chainEntries(
				state.tipId,
				messages.map(({ id, message }) => ({ id, type: "message" as const, message })),
			);
			const triggerEntryId = messages[messages.length - 1]!.id;
			const nextState: CheckpointOperation = {
				...operationScopeOf(current),
				at: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId,
				skipInboxOnce: true,
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...ids.map((id) => deleteValue(pendingEntry(id))),
					setValue(branchTip(lane.name), triggerEntryId),
				],
				operationState: nextState,
				lane: { tipId: triggerEntryId, inbox },
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) => [
					...committedEntryEvents(entries, commit, lane.name, drive.operationId),
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
	checkpoint: CheckpointOperation,
	continuation: FinishContinuation,
): Promise<ProcedureResult> {
	const context = await readBoundedContext(lane, drive, checkpoint);
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

	const result = await lane.continueOperation<CheckpointOperation, ProcedureResult>(
		checkpoint,
		async (state, current, meta, reader) => {
			if (state.inbox.some((item) => item.kind !== "nextRun")) {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (followUp !== undefined) {
				const nextState: CheckpointOperation = {
					...operationScopeOf(current),
					at: "checkpoint",
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
			if (continuation.includeFinalAssistant && current.latestAssistantEntryId === null) {
				throw new SessionInvariantError("Completed run is missing its final assistant");
			}
			const record = operationResultRecord(meta, "completed", state.tipId);
			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			return {
				kind: "finish",
				writes: cleanup,
				record,
				materialize: () => ({ kind: "settled", outcome: record }) as const,
				events: () => [
					{
						type: "run_end",
						lane: lane.name,
						runId: drive.operationId,
						status: "completed",
						fromTipId: meta.sourceTipId,
						tipId: state.tipId,
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
	run: CheckpointOperation,
): Promise<ProcedureResult> {
	if (run.skipInboxOnce !== true && lane.state.inbox.some((item) => item.kind === "write")) {
		return applyPendingWrites(lane, drive, run);
	}
	if (run.skipInboxOnce !== true && lane.state.inbox.some((item) => item.kind === "steer")) {
		return consumeQueuedMessages(lane, drive, run, "steer");
	}
	if (run.thresholdCheckedTriggerEntryId !== run.triggerEntryId) {
		const result = await runCompactionThreshold(lane, drive, run);
		if (result.kind !== "continue") return result;
		const current = lane.state.operation?.state;
		if (current?.control.status === "cancel_requested" || current?.at !== "checkpoint") return result;
		return runCheckpoint(lane, drive, current);
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
					state.inbox.some((item) => item.kind === "write" || item.kind === "steer")
				) {
					return { kind: "return", result: { kind: "continue" } as const };
				}
				const nextState: AssistantReadyOperation = {
					...operationScopeOf(current),
					at: "assistant.ready",
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
	if (lane.state.inbox.some((item) => item.kind === "followUp")) {
		return consumeQueuedMessages(lane, drive, run, "followUp");
	}
	return finishRun(lane, drive, run, continuation);
}
