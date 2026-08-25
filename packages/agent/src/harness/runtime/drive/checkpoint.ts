import type { AgentMessage } from "../../../types.ts";
import type { HarnessEvent, TerminalOperationOutcome } from "../../agent-harness.ts";
import { insertEntry } from "../../session/commit.ts";
import { buildSessionContext } from "../../session/context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	checkpointDataOf,
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
import type { Drive, ProcedureResult } from "../types.ts";
import { operationCleanupWrites } from "./terminal.ts";

function isSettledAssistant(message: AgentMessage): message is SettledAssistantMessage {
	return message.role === "assistant" && message.stopReason !== "pending";
}

function lifecycleEvents(entry: Entry, lane: string, runId: string): HarnessEvent[] {
	return entry.type === "message"
		? [
				{ type: "message_start", lane, runId, message: entry.message },
				{ type: "message_end", lane, runId, message: entry.message, entryId: entry.id },
				{ type: "entry_added", lane, entry },
			]
		: [{ type: "entry_added", lane, entry }];
}

async function readRunContext<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
): Promise<AgentMessage[] | undefined> {
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
	return entries === undefined
		? undefined
		: buildSessionContext(entries, { entryProjectors: lane.readConfig().entryProjectors }, drive.context);
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
	if (prompt === undefined) return { kind: "continue" };

	const hook = await lane.hooks.runWithGate(
		"before_run",
		{ lane: lane.name, runId: drive.operationId, prompt, resources: lane.readConfig().resources },
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
			let parentId = state.tipId;
			const entries = reserved.map(({ id, message }) => {
				const entry: NewEntry<MessageEntry> = { id, parentId, type: "message", message };
				parentId = id;
				return entry;
			});
			const triggerEntryId = parentId;
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
						lifecycleEvents(
							{ ...entry, seq: commit.seqs[index]!, timestamp: commit.timestamp },
							lane.name,
							drive.operationId,
						),
					),
			};
		},
		drive.context,
	);
	return result ?? { kind: "continue" };
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
			const scope = { ...runScopeOf(current), inbox: { ...current.inbox, writes: [] } };
			const nextState: RunCheckpointOperation =
				triggerEntryId === undefined
					? { ...scope, at: "run.checkpoint", ...checkpointDataOf(current) }
					: {
							...scope,
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
						lifecycleEvents(
							{ ...entry, seq: commit.seqs[index]!, timestamp: commit.timestamp } as Entry,
							lane.name,
							drive.operationId,
						),
					),
			};
		},
		drive.context,
	);
	return result ?? { kind: "continue" };
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
			const readMessages = (queuedIds: readonly string[], description: string) =>
				Promise.all(
					queuedIds.map(async (id) => {
						const value = await reader.getValue(pendingEntry(id), drive.context);
						if (value?.value.type !== "message") {
							throw new SessionInvariantError(`${description} ${id} is missing its message payload`);
						}
						return { entryId: id, message: value.value.payload };
					}),
				);
			const messages = (await readMessages(ids, `Queued ${queue} entry`)).map(({ entryId, message }) => ({
				id: entryId,
				message,
			}));
			const remainingSteerIds = queue === "steer" ? allIds.slice(ids.length) : current.inbox.steer;
			const remainingFollowUpIds = queue === "followUp" ? allIds.slice(ids.length) : current.inbox.followUp;
			const [remainingSteer, remainingFollowUp, nextRun] = await Promise.all([
				readMessages(remainingSteerIds, "Steer entry"),
				readMessages(remainingFollowUpIds, "Follow-up entry"),
				readMessages(state.pendingNextRun, "Pending next-run entry"),
			]);
			let parentId = state.tipId;
			const entries = messages.map(({ id, message }) => {
				const entry: NewEntry<MessageEntry> = { id, parentId, type: "message", message };
				parentId = id;
				return entry;
			});
			const triggerEntryId = entries.at(-1)?.id;
			if (triggerEntryId === undefined) throw new SessionInvariantError("Queue drain produced no trigger entry");
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
						lifecycleEvents(
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
	return result ?? { kind: "continue" };
}

async function finishRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
): Promise<ProcedureResult> {
	const context = await readRunContext(lane, drive, checkpoint);
	if (context === undefined) return { kind: "continue" };
	const hook = await lane.hooks.runWithGate(
		"before_run_end",
		{ lane: lane.name, runId: drive.operationId, messages: context },
		drive.gate,
		drive.context,
	);
	const followUp = hook?.followUp;
	const followUpId = followUp === undefined ? undefined : lane.session.idGenerator.next();
	const followUpMessage: AgentMessage | undefined =
		followUp === undefined ? undefined : { role: "user", content: followUp, timestamp: Date.now() };

	const result = await lane.continueOperation<RunCheckpointOperation, ProcedureResult>(
		checkpoint,
		async (state, current, _meta, reader) => {
			if (
				current.continuation.kind !== "may_finish" ||
				current.inbox.steer.length !== 0 ||
				current.inbox.followUp.length !== 0 ||
				current.inbox.writes.length !== 0
			) {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (followUpId !== undefined && followUpMessage !== undefined) {
				const nextState: RunCheckpointOperation = {
					...runScopeOf(current),
					at: "run.checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: followUpId,
				};
				const entry: NewEntry<MessageEntry> = {
					id: followUpId,
					parentId: state.tipId,
					type: "message",
					message: followUpMessage,
				};
				return {
					kind: "commit",
					writes: [insertEntry(entry), setValue(branchTip(lane.name), followUpId)],
					operationState: nextState,
					lane: { tipId: followUpId },
					materialize: () => ({ kind: "continue" }) as const,
					events: (commit) =>
						lifecycleEvents(
							{ ...entry, seq: commit.seqs[0]!, timestamp: commit.timestamp },
							lane.name,
							drive.operationId,
						),
				};
			}

			if (state.tipId === null) throw new SessionInvariantError("Completed run has no tip");
			const finalId = current.continuation.includeFinalAssistant ? current.latestAssistantEntryId : null;
			if (current.continuation.includeFinalAssistant && finalId === null) {
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
	return result ?? { kind: "continue" };
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
	if (run.continuation.kind === "need_assistant") {
		const overflowRecoveryUsed = run.continuation.overflowRecoveryUsed;
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
		return result ?? { kind: "continue" };
	}
	if (run.inbox.followUp.length !== 0) {
		return consumeQueuedMessages(lane, drive, run, "followUp");
	}
	return finishRun(lane, drive, run);
}
