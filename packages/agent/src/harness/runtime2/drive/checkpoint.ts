import type { AgentMessage } from "../../../types.ts";
import type { HarnessEvent, TerminalOperationOutcome } from "../../agent-harness.ts";
import { insertEntry } from "../../session/commit.ts";
import { buildSessionContext } from "../../session/context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import type {
	CheckpointPhase,
	Entry,
	LaneLastResult,
	MessageEntry,
	NewEntry,
	RunState,
	SettledAssistantMessage,
} from "../../session/types.ts";
import {
	deleteValue,
	laneLastResult as laneLastResultValue,
	laneLeaf,
	laneState as laneStateValue,
	operationState as operationStateValue,
	pendingEntry,
	setValue,
} from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import type { Drive, LaneCommand, LostOwnership, ProcedureResult } from "../types.ts";
import { operationCleanupWrites } from "./terminal.ts";

type ReadResult<T> = { kind: "value"; value: T } | { kind: "state_changed" } | LostOwnership;

function isSettledAssistant(message: AgentMessage): message is SettledAssistantMessage {
	return message.role === "assistant" && message.stopReason !== "pending";
}

function sameCheckpoint(current: CheckpointPhase, expected: CheckpointPhase): boolean {
	return (
		current.triggerEntryId === expected.triggerEntryId &&
		current.thresholdCheckedTriggerEntryId === expected.thresholdCheckedTriggerEntryId &&
		current.skipInboxOnce === expected.skipInboxOnce &&
		current.continuation.kind === expected.continuation.kind &&
		(current.continuation.kind !== "need_assistant" ||
			(expected.continuation.kind === "need_assistant" &&
				current.continuation.overflowRecoveryUsed === expected.continuation.overflowRecoveryUsed)) &&
		(current.continuation.kind !== "may_finish" ||
			(expected.continuation.kind === "may_finish" &&
				current.continuation.includeFinalAssistant === expected.continuation.includeFinalAssistant))
	);
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
	phase: CheckpointPhase,
): Promise<ReadResult<AgentMessage[]>> {
	const entries = await lane.commandDriveOwned<ReadResult<Entry[]>>(
		drive,
		async (state, reader): Promise<LaneCommand<ReadResult<Entry[]>>> => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Checkpoint context reached a non-run operation");
			}
			if (operation.state.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			if (operation.state.phase.kind !== "checkpoint" || !sameCheckpoint(operation.state.phase, phase)) {
				throw new SessionInvariantError("Checkpoint context lost its durable boundary");
			}
			if (state.leafId === null) throw new SessionInvariantError("Run checkpoint has no branch leaf");
			const path = (
				await reader.scanBranch(
					{ start: state.leafId, stopAtType: "compaction", order: "newestFirst" },
					drive.context,
				)
			).reverse();
			return { kind: "return", result: { kind: "value", value: path } as const };
		},
		drive.context,
	);
	if (entries.kind !== "value") return entries;
	return {
		kind: "value",
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
	run: RunState,
): Promise<ProcedureResult> {
	if (run.phase.kind !== "starting") throw new SessionInvariantError("startRun requires the starting phase");
	const prompt = await lane.commandDriveOwned<ReadResult<AgentMessage[]>>(
		drive,
		async (state, reader): Promise<LaneCommand<ReadResult<AgentMessage[]>>> => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run" || operation.meta.intent.kind !== "run") {
				throw new SessionInvariantError("before_run reached a non-run operation");
			}
			if (operation.state.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			if (operation.state.phase.kind !== "starting") {
				throw new SessionInvariantError("before_run lost the starting boundary");
			}
			const entries = await reader.getEntries(operation.meta.intent.promptEntryIds, drive.context);
			const messages = operation.meta.intent.promptEntryIds.map((id) => {
				const entry = entries.get(id);
				if (entry?.type !== "message") {
					throw new SessionInvariantError(`Run prompt entry ${id} is missing its message`);
				}
				return entry.message;
			});
			return { kind: "return", result: { kind: "value", value: messages } as const };
		},
		drive.context,
	);
	if (prompt.kind === "lost_ownership") return prompt;
	if (prompt.kind === "state_changed") return { kind: "continue" };

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

	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("before_run settlement reached a non-run operation");
			}
			if (operation.state.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (operation.state.phase.kind !== "starting") {
				throw new SessionInvariantError("before_run settlement lost the starting boundary");
			}
			let parentId = state.leafId;
			const entries = reserved.map(({ id, message }) => {
				const entry: NewEntry<MessageEntry> = { id, parentId, type: "message", message };
				parentId = id;
				return entry;
			});
			const triggerEntryId = parentId;
			if (triggerEntryId === null) throw new SessionInvariantError("Run start has no trigger entry");
			const nextState: RunState = {
				...operation.state,
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId,
				},
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...(entries.length === 0 ? [] : [setValue(laneLeaf(lane.name), triggerEntryId)]),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: {
					...state,
					leafId: triggerEntryId,
					operation: { meta: operation.meta, state: nextState },
				},
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
}

async function applyPendingWrites<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	phase: CheckpointPhase,
): Promise<ProcedureResult> {
	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		async (state, reader) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Pending-write drain reached a non-run operation");
			}
			const current = operation.state;
			if (current.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (current.phase.kind !== "checkpoint" || !sameCheckpoint(current.phase, phase)) {
				throw new SessionInvariantError("Pending-write drain lost its checkpoint boundary");
			}
			const ids = current.inbox.writes;
			if (ids.length === 0) return { kind: "return", result: { kind: "continue" } as const };
			const pending = await Promise.all(
				ids.map(async (id) => {
					const value = await reader.getValue(pendingEntry(id), drive.context);
					if (value === undefined) throw new SessionInvariantError(`Pending write ${id} is missing its payload`);
					return { id, pending: value.value };
				}),
			);
			let parentId = state.leafId;
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
			const nextPhase: CheckpointPhase =
				triggerEntryId === undefined
					? current.phase
					: {
							kind: "checkpoint",
							continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
							triggerEntryId,
							skipInboxOnce: true,
						};
			const nextState: RunState = {
				...current,
				phase: nextPhase,
				inbox: { ...current.inbox, writes: [] },
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...ids.map((id) => deleteValue(pendingEntry(id))),
					setValue(laneLeaf(lane.name), parentId),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: { ...state, leafId: parentId, operation: { meta: operation.meta, state: nextState } },
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
}

async function consumeQueuedMessages<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	phase: CheckpointPhase,
	queue: "steer" | "followUp",
): Promise<ProcedureResult> {
	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		async (state, reader) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Queue drain reached a non-run operation");
			}
			const current = operation.state;
			if (current.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (current.phase.kind !== "checkpoint" || !sameCheckpoint(current.phase, phase)) {
				throw new SessionInvariantError("Queue drain lost its checkpoint boundary");
			}
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
			let parentId = state.leafId;
			const entries = messages.map(({ id, message }) => {
				const entry: NewEntry<MessageEntry> = { id, parentId, type: "message", message };
				parentId = id;
				return entry;
			});
			const triggerEntryId = entries.at(-1)?.id;
			if (triggerEntryId === undefined) throw new SessionInvariantError("Queue drain produced no trigger entry");
			const nextState: RunState = {
				...current,
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId,
					skipInboxOnce: true,
				},
				inbox: { ...current.inbox, [queue]: allIds.slice(ids.length) },
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...ids.map((id) => deleteValue(pendingEntry(id))),
					setValue(laneLeaf(lane.name), triggerEntryId),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: {
					...state,
					leafId: triggerEntryId,
					operation: { meta: operation.meta, state: nextState },
				},
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
}

async function finishRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	phase: CheckpointPhase,
): Promise<ProcedureResult> {
	const context = await readRunContext(lane, drive, phase);
	if (context.kind === "lost_ownership") return context;
	if (context.kind === "state_changed") return { kind: "continue" };
	const hook = await lane.hooks.runWithGate(
		"before_run_end",
		{ lane: lane.name, runId: drive.operationId, messages: context.value },
		drive.gate,
		drive.context,
	);
	const followUp = hook?.followUp;
	const followUpId = followUp === undefined ? undefined : lane.session.idGenerator.next();
	const followUpMessage: AgentMessage | undefined =
		followUp === undefined ? undefined : { role: "user", content: followUp, timestamp: Date.now() };

	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		async (state, reader) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Run finish reached a non-run operation");
			}
			const current = operation.state;
			if (current.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (current.phase.kind !== "checkpoint" || !sameCheckpoint(current.phase, phase)) {
				throw new SessionInvariantError("Run finish lost its checkpoint boundary");
			}
			if (
				current.phase.continuation.kind !== "may_finish" ||
				current.inbox.steer.length !== 0 ||
				current.inbox.followUp.length !== 0 ||
				current.inbox.writes.length !== 0
			) {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (followUpId !== undefined && followUpMessage !== undefined) {
				const nextState: RunState = {
					...current,
					phase: {
						kind: "checkpoint",
						continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
						triggerEntryId: followUpId,
					},
				};
				const entry: NewEntry<MessageEntry> = {
					id: followUpId,
					parentId: state.leafId,
					type: "message",
					message: followUpMessage,
				};
				return {
					kind: "commit",
					writes: [
						insertEntry(entry),
						setValue(laneLeaf(lane.name), followUpId),
						setValue(operationStateValue(drive.operationId), nextState),
					],
					next: {
						...state,
						leafId: followUpId,
						operation: { meta: operation.meta, state: nextState },
					},
					materialize: () => ({ kind: "continue" }) as const,
					events: (commit) =>
						lifecycleEvents(
							{ ...entry, seq: commit.seqs[0]!, timestamp: commit.timestamp },
							lane.name,
							drive.operationId,
						),
				};
			}

			if (state.leafId === null) throw new SessionInvariantError("Completed run has no leaf");
			const finalId = current.phase.continuation.includeFinalAssistant ? current.latestAssistantEntryId : null;
			if (current.phase.continuation.includeFinalAssistant && finalId === null) {
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
				leafId: state.leafId,
				...final,
			};
			const lastResult: LaneLastResult = {
				operationId: drive.operationId,
				kind: "run",
				outcome: "completed",
				leafId: state.leafId,
				runCompletion: finalId === null ? "terminated_tools" : "assistant",
				...(finalId === null ? {} : { finalAssistantEntryId: finalId }),
			};
			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			return {
				kind: "commit",
				writes: [
					...cleanup,
					setValue(laneLastResultValue(lane.name), lastResult),
					setValue(laneStateValue(lane.name), {
						currentOperationId: null,
						pendingNextRun: state.pendingNextRun,
					}),
				],
				next: { ...state, lastResult, operation: null },
				materialize: () => ({ kind: "settled", outcome }) as const,
				events: () => [
					{
						type: "run_end",
						lane: lane.name,
						runId: drive.operationId,
						leafId: state.leafId,
						outcome: "completed",
						...final,
					},
				],
			};
		},
		drive.context,
	);
}

/** Advance one durable run checkpoint by one visible transition. */
export async function runCheckpoint<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	phase: CheckpointPhase,
): Promise<ProcedureResult> {
	if (run.phase.kind !== "checkpoint" || !sameCheckpoint(run.phase, phase)) {
		throw new SessionInvariantError("runCheckpoint requires its current checkpoint phase");
	}
	if (run.control.status === "cancel_requested") return { kind: "continue" };
	if (phase.skipInboxOnce !== true && run.inbox.writes.length !== 0) {
		return applyPendingWrites(lane, drive, phase);
	}
	if (phase.skipInboxOnce !== true && run.inbox.steer.length !== 0) {
		return consumeQueuedMessages(lane, drive, phase, "steer");
	}
	if (phase.continuation.kind === "need_assistant") {
		const config = lane.readConfig();
		const retryPolicy = config.retryPolicy.enabled
			? { maxAttempts: config.retryPolicy.maxRetries + 1, baseDelayMs: config.retryPolicy.baseDelayMs }
			: { maxAttempts: 1, baseDelayMs: config.retryPolicy.baseDelayMs };
		const stepId = lane.session.idGenerator.next();
		return lane.commandDriveOwned<ProcedureResult>(
			drive,
			(state) => {
				const operation = state.operation;
				if (operation === null || operation.state.kind !== "run") {
					throw new SessionInvariantError("Generation start reached a non-run operation");
				}
				const current = operation.state;
				if (current.control.status === "cancel_requested") {
					return { kind: "return", result: { kind: "continue" } as const };
				}
				if (
					current.phase.kind !== "checkpoint" ||
					!sameCheckpoint(current.phase, phase) ||
					current.phase.continuation.kind !== "need_assistant"
				) {
					throw new SessionInvariantError("Generation start lost its checkpoint boundary");
				}
				if (
					current.phase.skipInboxOnce !== true &&
					(current.inbox.writes.length !== 0 || current.inbox.steer.length !== 0)
				) {
					return { kind: "return", result: { kind: "continue" } as const };
				}
				const nextState: RunState = {
					...current,
					phase: {
						kind: "assistant",
						generation: {
							status: "ready",
							context: {
								stepId,
								triggerEntryId: current.phase.triggerEntryId,
								configuration: state.configuration,
								streamOptions: config.streamOptions,
								retryPolicy,
								overflowRecoveryUsed: current.phase.continuation.overflowRecoveryUsed,
							},
							nextAttempt: 1,
						},
					},
				};
				return {
					kind: "commit",
					writes: [setValue(operationStateValue(drive.operationId), nextState)],
					next: { ...state, operation: { meta: operation.meta, state: nextState } },
					materialize: () => ({ kind: "continue" }) as const,
				};
			},
			drive.context,
		);
	}
	if (run.inbox.followUp.length !== 0) {
		return consumeQueuedMessages(lane, drive, phase, "followUp");
	}
	return finishRun(lane, drive, phase);
}
