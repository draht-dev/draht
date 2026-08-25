import type { AssistantMessage, ToolResultMessage } from "@draht/ai";
import type { AgentToolCall, AgentToolResult } from "../../../types.ts";
import type { HarnessEvent } from "../../agent-harness.ts";
import { AbortRequested } from "../../execution/effect-gate.ts";
import {
	applyBeforeToolDecision,
	type ClearedToolCall,
	createToolResultMessage,
	type ExecutedToolCall,
	executeToolCall,
	finalizeToolCall,
	prepareToolCall,
} from "../../execution/tools.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type JsonValue,
	type MessageEntry,
	type NewEntry,
	type OperationState,
	type RunCheckpointOperation,
	type RunToolsOperation,
	runScopeOf,
	type ToolBatch,
	type ToolCall,
	type UsageRow,
	type Write,
} from "../../session/types.ts";
import {
	branchTip,
	deleteValue,
	laneConfig,
	operationToolArgs,
	operationToolArgsPrefix,
	operationToolMemo,
	operationToolMemoPrefix,
	pendingEntry,
	pendingToolOutput,
	setValue,
} from "../../session/values.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { openToolProgress } from "../progress.ts";
import type { Drive, LaneState, ProcedureResult } from "../types.ts";

type LocalResult = { kind: "committed" } | { kind: "state_changed" };
type PlacementResult = { kind: "none" } | { kind: "committed"; complete: boolean };

type BatchSource = {
	kind: "source";
	assistant: AssistantMessage;
	calls: Map<number, AgentToolCall>;
};

type PlacementItem = {
	call: Extract<ToolCall, { status: "outcome_ready" }>;
	message: ToolResultMessage<unknown>;
};

type PlacementRead = {
	kind: "placement";
	items: PlacementItem[];
	assistant: AssistantMessage;
	turnResults?: ToolResultMessage<unknown>[];
};

const INTERRUPTION_MARKER =
	"[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

class ToolInvocationEnded extends Error {
	constructor() {
		super("Tool invocation no longer owns its durable effect");
		this.name = "ToolInvocationEnded";
	}
}

function currentBatch<TContext extends object | undefined>(
	lane: Lane<TContext>,
): { run: RunToolsOperation; batch: ToolBatch } | undefined {
	const operation = lane.state.operation;
	if (operation?.state.at !== "run.tools") return undefined;
	return { run: operation.state, batch: operation.state.batch };
}

function toolOperation<TContext extends object | undefined>(lane: Lane<TContext>): RunToolsOperation {
	return lane.state.operation!.state as RunToolsOperation;
}

function findCall(batch: ToolBatch, sourceIndex: number, resultEntryId: string): ToolCall | undefined {
	return batch.calls.find((call) => call.sourceIndex === sourceIndex && call.resultEntryId === resultEntryId);
}

function replaceCall(batch: ToolBatch, replacement: ToolCall): ToolBatch {
	return {
		...batch,
		calls: batch.calls.map((call) =>
			call.sourceIndex === replacement.sourceIndex && call.resultEntryId === replacement.resultEntryId
				? replacement
				: call,
		),
	};
}

function withBatch(run: RunToolsOperation, batch: ToolBatch): RunToolsOperation {
	return { ...runScopeOf(run), at: "run.tools", batch };
}

function validateMemoName(name: string): void {
	if (name.length === 0) throw new TypeError("Tool invocation memo name must not be empty");
	if (name.includes(":")) throw new TypeError("Tool invocation memo name must not contain ':'");
}

function isToolResultMessage(value: unknown): value is ToolResultMessage<unknown> {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

function toolCallFor(sources: BatchSource, call: ToolCall): AgentToolCall {
	const source = sources.calls.get(call.sourceIndex);
	if (source === undefined) {
		throw new SessionInvariantError(`Tool call source index ${call.sourceIndex} is invalid`);
	}
	return source;
}

async function readBatchSource<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
): Promise<BatchSource> {
	return lane.command<BatchSource>(async (_state, reader) => {
		const entry = (await reader.getEntries([batch.assistantEntryId], drive.context)).get(batch.assistantEntryId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new SessionInvariantError("Tool batch assistant entry is invalid");
		}
		const calls = new Map<number, AgentToolCall>();
		for (const call of batch.calls) {
			const block = entry.message.content[call.sourceIndex];
			if (block?.type !== "toolCall") {
				throw new SessionInvariantError(
					`Tool call source index ${call.sourceIndex} does not name a tool-call block`,
				);
			}
			calls.set(call.sourceIndex, block);
		}
		return { kind: "return", result: { kind: "source", assistant: entry.message, calls } };
	}, drive.context);
}

function invocationCapability<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	call: Extract<ToolCall, { status: "effect_pending" }>,
): { invocation: AgentHarnessToolInvocation; expire(): void } {
	let active = true;
	const ownsEffect = (state: LaneState): boolean => {
		const operation = state.operation;
		if (operation?.state.at !== "run.tools") return false;
		return findCall(operation.state.batch, call.sourceIndex, call.resultEntryId)?.status === "effect_pending";
	};
	const ended = (): ToolInvocationEnded => new ToolInvocationEnded();
	return {
		invocation: {
			invocationId: call.resultEntryId,
			operationId: drive.operationId,
			turnId: batch.turnId,
			getMemo(name) {
				validateMemoName(name);
				if (!active) return Promise.reject(ended());
				return lane
					.command<{ kind: "value"; value: JsonValue | undefined } | { kind: "ended" }>(async (state, reader) => {
						if (!ownsEffect(state)) return { kind: "return", result: { kind: "ended" } as const };
						const stored = await reader.getValue(
							operationToolMemo(drive.operationId, call.resultEntryId, name),
							drive.context,
						);
						return {
							kind: "return",
							result: { kind: "value", value: stored?.value } as const,
						};
					}, drive.context)
					.then((result) => {
						if (result.kind === "ended") throw ended();
						return result.value;
					});
			},
			setMemo(name, value) {
				validateMemoName(name);
				if (!active) return Promise.reject(ended());
				return lane
					.command<{ kind: "written" } | { kind: "ended" }>((state) => {
						if (!ownsEffect(state)) return { kind: "return", result: { kind: "ended" } as const };
						const address = operationToolMemo(drive.operationId, call.resultEntryId, name);
						return {
							kind: "commit",
							writes: [value === undefined ? deleteValue(address) : setValue(address, value)],
							next: state,
							materialize: () => ({ kind: "written" }) as const,
						};
					}, drive.context)
					.then((result) => {
						if (result.kind === "ended") throw ended();
					});
			},
		},
		expire() {
			active = false;
		},
	};
}

function syntheticMessage(
	toolCall: AgentToolCall,
	content: AgentToolResult<unknown>["content"],
	options: { details?: unknown; usage?: AgentToolResult<unknown>["usage"] } = {},
): ToolResultMessage<unknown> {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content,
		...(options.details === undefined ? {} : { details: options.details }),
		...(options.usage === undefined ? {} : { usage: options.usage }),
		isError: true,
		timestamp: Date.now(),
	};
}

function abortedMessage(toolCall: AgentToolCall): ToolResultMessage<unknown> {
	return syntheticMessage(toolCall, [{ type: "text", text: "Tool execution was cancelled before completion." }]);
}

function interruptedMessage(
	toolCall: AgentToolCall,
	checkpoint: AgentToolResult<unknown> | undefined,
): ToolResultMessage<unknown> {
	return syntheticMessage(
		toolCall,
		[...(checkpoint?.content ?? []), { type: "text", text: INTERRUPTION_MARKER }],
		checkpoint === undefined ? {} : { details: checkpoint.details, usage: checkpoint.usage },
	);
}

function truncatedMessage(toolCall: AgentToolCall): ToolResultMessage<unknown> {
	return syntheticMessage(toolCall, [
		{
			type: "text",
			text: `Tool call ${JSON.stringify(toolCall.name)} was not executed because the assistant response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
		},
	]);
}

async function commitIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	planned: Extract<ToolCall, { status: "planned" }>,
	args: Record<string, JsonValue>,
	replay: "never" | "safe",
): Promise<LocalResult> {
	return lane.mutateOperation<RunToolsOperation, LocalResult>(
		toolOperation(lane),
		(_state, run) => {
			const currentBatchState = run.batch;
			if (run.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			const current = findCall(currentBatchState, planned.sourceIndex, planned.resultEntryId);
			if (current?.status !== "planned") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			const effectPending: Extract<ToolCall, { status: "effect_pending" }> = {
				status: "effect_pending",
				sourceIndex: current.sourceIndex,
				resultEntryId: current.resultEntryId,
				replay,
			};
			const nextRun = withBatch(run, replaceCall(currentBatchState, effectPending));
			return {
				kind: "commit",
				writes: [setValue(operationToolArgs(drive.operationId, batch.turnId, current.sourceIndex), args)],
				operationState: nextRun,
				materialize: () => ({ kind: "committed" }) as const,
			};
		},
		drive.context,
	);
}

async function stageOutcome<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	call: ToolCall,
	message: ToolResultMessage<unknown>,
	terminate: boolean,
): Promise<LocalResult> {
	return lane.mutateOperation<RunToolsOperation, LocalResult>(
		toolOperation(lane),
		async (_state, run, _meta, reader) => {
			const currentBatchState = run.batch;
			const current = findCall(currentBatchState, call.sourceIndex, call.resultEntryId);
			if (
				current === undefined ||
				current.status !== call.status ||
				(current.status === "effect_pending" && call.status === "effect_pending" && current.replay !== call.replay)
			) {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			const memos = await reader.scanValues(
				operationToolMemoPrefix(drive.operationId, current.resultEntryId),
				drive.context,
			);
			const outcome: Extract<ToolCall, { status: "outcome_ready" }> = {
				status: "outcome_ready",
				sourceIndex: current.sourceIndex,
				resultEntryId: current.resultEntryId,
				terminate: run.control.status === "running" && terminate,
			};
			const nextRun = withBatch(run, replaceCall(currentBatchState, outcome));
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(current.resultEntryId), { type: "message", payload: message }),
					deleteValue(pendingToolOutput(drive.operationId, current.resultEntryId)),
					...memos.map(({ address }) => deleteValue(address)),
				],
				operationState: nextRun,
				materialize: () => ({ kind: "committed" }) as const,
			};
		},
		drive.context,
	);
}

async function clearReplayCheckpoint<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	call: Extract<ToolCall, { status: "effect_pending" }>,
): Promise<{ kind: "args"; args: Record<string, JsonValue> } | { kind: "state_changed" }> {
	return lane.command<{ kind: "args"; args: Record<string, JsonValue> } | { kind: "state_changed" }>(
		async (state, reader) => {
			const run = state.operation!.state as RunToolsOperation;
			const current = findCall(run.batch, call.sourceIndex, call.resultEntryId);
			if (current?.status !== "effect_pending") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			const stored = await reader.getValue(
				operationToolArgs(drive.operationId, batch.turnId, call.sourceIndex),
				drive.context,
			);
			if (stored === undefined) {
				throw new SessionInvariantError(`Tool call ${call.resultEntryId} is missing persisted arguments`);
			}
			return {
				kind: "commit",
				writes: [deleteValue(pendingToolOutput(drive.operationId, call.resultEntryId))],
				next: state,
				materialize: () => ({ kind: "args", args: stored.value }) as const,
			};
		},
		drive.context,
	);
}

async function readCheckpoint<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	call: Extract<ToolCall, { status: "effect_pending" }>,
): Promise<{ kind: "checkpoint"; value: AgentToolResult<unknown> | undefined } | { kind: "state_changed" }> {
	return lane.command<{ kind: "checkpoint"; value: AgentToolResult<unknown> | undefined } | { kind: "state_changed" }>(
		async (state, reader) => {
			const run = state.operation!.state as RunToolsOperation;
			const current = findCall(run.batch, call.sourceIndex, call.resultEntryId);
			if (current?.status !== "effect_pending") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			const stored = await reader.getValue(pendingToolOutput(drive.operationId, call.resultEntryId), drive.context);
			return {
				kind: "return",
				result: { kind: "checkpoint", value: stored?.value } as const,
			};
		},
		drive.context,
	);
}

async function resolveToolContext<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
): Promise<TContext> {
	const source = lane.readConfig().toolContext;
	return (typeof source === "function" ? await source(drive.context) : source) as TContext;
}

async function executeAndStage<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	call: Extract<ToolCall, { status: "effect_pending" }>,
	cleared: ClearedToolCall<TContext>,
	toolContext: TContext,
	recovery: boolean,
): Promise<LocalResult> {
	const capability = invocationCapability(lane, drive, batch, call);
	const progress = openToolProgress(lane, drive, batch.turnId, call.sourceIndex, call.resultEntryId);
	let latestUpdateDelivery: Promise<void> = Promise.resolve();
	let startDelivered: Promise<void> = Promise.resolve();
	let startQueued = false;
	const bufferedUpdates: AgentToolResult<unknown>[] = [];
	const publishUpdate = (partial: AgentToolResult<unknown>): void => {
		latestUpdateDelivery = lane.emitBatch(
			[
				{
					type: "tool_update",
					lane: lane.name,
					runId: drive.operationId,
					turnId: batch.turnId,
					toolCallId: cleared.toolCall.id,
					toolName: cleared.toolCall.name,
					partialResult: partial,
					...(recovery ? { recovery: true as const } : {}),
				},
			],
			drive.context,
		);
		void latestUpdateDelivery.catch(() => {});
	};

	let execution: Promise<ExecutedToolCall>;
	try {
		execution = executeToolCall(
			cleared,
			drive.gate,
			(partial, options) => {
				if (startQueued) publishUpdate(partial);
				else bufferedUpdates.push(partial);
				if (options?.checkpoint === true) progress.write(partial);
			},
			toolContext,
			capability.invocation,
			drive.context,
		);
		startDelivered = lane.emitBatch(
			[
				{
					type: "tool_start",
					lane: lane.name,
					runId: drive.operationId,
					turnId: batch.turnId,
					toolCallId: cleared.toolCall.id,
					toolName: cleared.toolCall.name,
					args: cleared.args,
					...(recovery ? { recovery: true as const } : {}),
				},
			],
			drive.context,
		);
		startQueued = true;
		for (const update of bufferedUpdates) publishUpdate(update);
	} catch (error) {
		capability.expire();
		progress.seal();
		await progress.drain();
		if (!(error instanceof AbortRequested)) throw error;
		await error.cancellation;
		return stageOutcome(
			lane,
			drive,
			call,
			recovery ? interruptedMessage(cleared.toolCall, undefined) : abortedMessage(cleared.toolCall),
			false,
		);
	}

	const executed = await execution.finally(() => {
		capability.expire();
		progress.seal();
	});
	await startDelivered;
	await latestUpdateDelivery;
	await progress.drain();

	let patch: Awaited<ReturnType<typeof lane.hooks.runToolWithGate<"after_tool">>>;
	try {
		patch = await lane.hooks.runToolWithGate(
			"after_tool",
			{
				lane: lane.name,
				runId: drive.operationId,
				toolCallId: cleared.toolCall.id,
				toolName: cleared.toolCall.name,
				args: cleared.args,
				content: executed.result.content,
				...(executed.result.details === undefined ? {} : { details: executed.result.details as JsonValue }),
				isError: executed.isError,
				...(executed.result.usage === undefined ? {} : { usage: executed.result.usage }),
			},
			drive.gate,
			drive.context,
		);
	} catch (error) {
		if (!(error instanceof AbortRequested)) throw error;
		patch = undefined;
	}
	const current = currentBatch(lane);
	const cancelled = current?.run.control.status === "cancel_requested";
	const finalized = finalizeToolCall(cleared, executed, cancelled ? { ...patch, terminate: false } : patch);
	await lane.emitBatch(
		[
			{
				type: "tool_end",
				lane: lane.name,
				runId: drive.operationId,
				turnId: batch.turnId,
				toolCallId: cleared.toolCall.id,
				toolName: cleared.toolCall.name,
				result: finalized.result,
				isError: finalized.isError,
				terminate: cancelled ? false : finalized.terminate,
				...(recovery ? { recovery: true as const } : {}),
			},
		],
		drive.context,
	);
	return stageOutcome(lane, drive, call, createToolResultMessage(finalized), cancelled ? false : finalized.terminate);
}

async function readPlacement<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
): Promise<PlacementRead | { kind: "none" }> {
	return lane.command<PlacementRead | { kind: "none" }>(async (state, reader) => {
		const operation = state.operation;
		if (operation?.state.at !== "run.tools") return { kind: "return", result: { kind: "none" } as const };
		const current = operation.state.batch;
		let first = current.calls.findIndex((call) => call.status !== "completed");
		if (first === -1) return { kind: "return", result: { kind: "none" } as const };
		const ready: Array<Extract<ToolCall, { status: "outcome_ready" }>> = [];
		while (first < current.calls.length) {
			const call = current.calls[first]!;
			if (call.status !== "outcome_ready") break;
			ready.push(call);
			first += 1;
		}
		if (ready.length === 0) return { kind: "return", result: { kind: "none" } as const };

		const assistantEntry = (await reader.getEntries([current.assistantEntryId], drive.context)).get(
			current.assistantEntryId,
		);
		if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") {
			throw new SessionInvariantError("Tool placement assistant entry is invalid");
		}
		const items: PlacementItem[] = [];
		for (const call of ready) {
			const stored = await reader.getValue(pendingEntry(call.resultEntryId), drive.context);
			if (stored?.value.type !== "message" || !isToolResultMessage(stored.value.payload)) {
				throw new SessionInvariantError(`Tool call ${call.resultEntryId} is missing its staged result`);
			}
			const block = assistantEntry.message.content[call.sourceIndex];
			if (
				block?.type !== "toolCall" ||
				stored.value.payload.toolCallId !== block.id ||
				stored.value.payload.toolName !== block.name
			) {
				throw new SessionInvariantError(`Tool call ${call.resultEntryId} has a mismatched staged result`);
			}
			items.push({ call, message: stored.value.payload });
		}

		let turnResults: ToolResultMessage<unknown>[] | undefined;
		if (first === current.calls.length) {
			const placedIds = current.calls
				.filter((call) => call.status === "completed")
				.map((call) => call.resultEntryId);
			const placed = await reader.getEntries(placedIds, drive.context);
			const staged = new Map(items.map((item) => [item.call.resultEntryId, item.message]));
			turnResults = current.calls.map((call) => {
				const message =
					staged.get(call.resultEntryId) ??
					(() => {
						const entry = placed.get(call.resultEntryId);
						return entry?.type === "message" && isToolResultMessage(entry.message) ? entry.message : undefined;
					})();
				if (message === undefined) {
					throw new SessionInvariantError(`Completed tool call ${call.resultEntryId} is missing its result entry`);
				}
				return message;
			});
		}
		return {
			kind: "return",
			result: {
				kind: "placement",
				items,
				assistant: assistantEntry.message,
				...(turnResults === undefined ? {} : { turnResults }),
			},
		};
	}, drive.context);
}

async function commitPlacement<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	read: PlacementRead,
): Promise<PlacementResult> {
	const usageIds = read.items.map((item) =>
		item.message.usage === undefined ? undefined : lane.session.idGenerator.next(),
	);
	return lane.mutateOperation<RunToolsOperation, PlacementResult>(
		toolOperation(lane),
		async (state, run, _meta, reader) => {
			const current = run.batch;
			const writes: Write[] = [];
			const eventEntries: Array<{ entry: NewEntry<MessageEntry>; seqIndex: number }> = [];
			const eventUsage: Array<{ row: Omit<UsageRow, "seq">; seqIndex: number }> = [];
			let parentId = state.tipId;
			for (const [index, item] of read.items.entries()) {
				const entry: NewEntry<MessageEntry> = {
					id: item.call.resultEntryId,
					parentId,
					type: "message",
					message: item.message,
					...(item.call.terminate ? { terminate: true } : {}),
				};
				eventEntries.push({ entry, seqIndex: writes.length });
				writes.push(insertEntry(entry), deleteValue(pendingEntry(item.call.resultEntryId)));
				const usageId = usageIds[index];
				if (usageId !== undefined && item.message.usage !== undefined) {
					const row: Omit<UsageRow, "seq"> = {
						id: usageId,
						usage: item.message.usage,
						entryId: item.call.resultEntryId,
						adjustment: false,
					};
					eventUsage.push({ row, seqIndex: writes.length });
					writes.push(insertUsage(row));
				}
				parentId = item.call.resultEntryId;
			}

			const completedCalls = current.calls.map((call) => {
				const item = read.items.find(
					(candidate) =>
						candidate.call.sourceIndex === call.sourceIndex &&
						candidate.call.resultEntryId === call.resultEntryId,
				);
				return item === undefined
					? call
					: {
							status: "completed" as const,
							sourceIndex: call.sourceIndex,
							resultEntryId: call.resultEntryId,
							terminate: item.call.terminate,
						};
			});
			const complete = completedCalls.every((call) => call.status === "completed");
			let nextConfiguration = state.configuration;
			const addedNames: string[] = [];
			for (const item of read.items) {
				for (const name of item.message.addedToolNames ?? []) {
					if (!nextConfiguration.activeToolNames.includes(name) && !addedNames.includes(name))
						addedNames.push(name);
				}
			}
			if (addedNames.length !== 0) {
				nextConfiguration = {
					...nextConfiguration,
					activeToolNames: [...nextConfiguration.activeToolNames, ...addedNames],
				};
				writes.push(setValue(laneConfig(lane.name), nextConfiguration));
			}
			writes.push(setValue(branchTip(lane.name), parentId));

			let nextRun: OperationState;
			if (complete) {
				const allTerminate = completedCalls.every((call) => call.status === "completed" && call.terminate);
				const checkpoint: RunCheckpointOperation = {
					...runScopeOf(run),
					at: "run.checkpoint",
					continuation: allTerminate
						? { kind: "may_finish", includeFinalAssistant: false }
						: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: parentId!,
				};
				nextRun = checkpoint;
				const args = await reader.scanValues(
					operationToolArgsPrefix(drive.operationId, batch.turnId),
					drive.context,
				);
				writes.push(...args.map(({ address }) => deleteValue(address)));
			} else {
				nextRun = withBatch(run, { ...current, calls: completedCalls });
			}
			return {
				kind: "commit",
				writes,
				operationState: nextRun,
				lane: { tipId: parentId, configuration: nextConfiguration },
				materialize: () => ({ kind: "committed", complete }) as const,
				events: (commit) => {
					const events: HarnessEvent[] = [];
					for (const { entry, seqIndex } of eventEntries) {
						events.push({
							type: "entry_added",
							lane: lane.name,
							entry: { ...entry, seq: commit.seqs[seqIndex]!, timestamp: commit.timestamp },
						});
						const usage = eventUsage.find((candidate) => candidate.row.entryId === entry.id);
						if (usage !== undefined) {
							events.push({
								type: "usage",
								lane: lane.name,
								row: { ...usage.row, seq: commit.seqs[usage.seqIndex]! },
								totals: commit.stats.usage,
							});
						}
					}
					if (addedNames.length !== 0) {
						events.push({
							type: "config_update",
							lane: lane.name,
							property: "activeTools",
							previous: state.configuration.activeToolNames,
							value: nextConfiguration.activeToolNames,
						});
					}
					return events;
				},
			};
		},
		drive.context,
	);
}

async function materializeReady<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	recovery: boolean,
): Promise<PlacementResult> {
	const read = await readPlacement(lane, drive);
	if (read.kind === "none") return read;
	await lane.emitBatch(
		read.items.flatMap(({ call, message }) => [
			{
				type: "message_start" as const,
				lane: lane.name,
				runId: drive.operationId,
				message,
				...(recovery ? { recovery: true as const } : {}),
			},
			{
				type: "message_end" as const,
				lane: lane.name,
				runId: drive.operationId,
				message,
				entryId: call.resultEntryId,
				...(recovery ? { recovery: true as const } : {}),
			},
		]),
		drive.context,
	);
	const committed = await commitPlacement(lane, drive, batch, read);
	if (committed.kind === "committed" && committed.complete && read.turnResults !== undefined) {
		await lane.emitBatch(
			[
				{
					type: "turn_end",
					lane: lane.name,
					runId: drive.operationId,
					turnId: batch.turnId,
					message: read.assistant,
					toolResults: read.turnResults,
					...(recovery ? { recovery: true as const } : {}),
				},
			],
			drive.context,
		);
	}
	return committed;
}

async function beginFreshCall<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	sources: BatchSource,
	call: Extract<ToolCall, { status: "planned" }>,
	tools: AgentHarnessTool<TContext>[],
	toolContext: TContext,
	recovery: boolean,
): Promise<{ job: Promise<LocalResult> }> {
	const toolCall = toolCallFor(sources, call);
	if (sources.assistant.stopReason === "length") {
		return { job: stageOutcome(lane, drive, call, truncatedMessage(toolCall), false) };
	}
	const prepared = prepareToolCall(toolCall, tools);
	if ("kind" in prepared) {
		const finalized = {
			toolCall: prepared.toolCall,
			result: prepared.result,
			isError: prepared.isError,
			terminate: prepared.terminate,
		};
		return {
			job: stageOutcome(lane, drive, call, createToolResultMessage(finalized), finalized.terminate),
		};
	}

	let decision: Awaited<ReturnType<typeof lane.hooks.runToolWithGate<"before_tool">>>;
	try {
		decision = await lane.hooks.runToolWithGate(
			"before_tool",
			{
				lane: lane.name,
				runId: drive.operationId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: prepared.args,
			},
			drive.gate,
			drive.context,
		);
	} catch (error) {
		if (!(error instanceof AbortRequested)) throw error;
		await error.cancellation;
		return { job: stageOutcome(lane, drive, call, abortedMessage(toolCall), false) };
	}
	const cleared = applyBeforeToolDecision(prepared, decision);
	if ("kind" in cleared) {
		const finalized = {
			toolCall: cleared.toolCall,
			result: cleared.result,
			isError: cleared.isError,
			terminate: cleared.terminate,
		};
		return {
			job: stageOutcome(lane, drive, call, createToolResultMessage(finalized), finalized.terminate),
		};
	}
	const intent = await commitIntent(lane, drive, batch, call, cleared.args, cleared.tool.replay ?? "never");
	if (intent.kind !== "committed") {
		return { job: stageOutcome(lane, drive, call, abortedMessage(toolCall), false) };
	}
	const effectPending: Extract<ToolCall, { status: "effect_pending" }> = {
		status: "effect_pending",
		sourceIndex: call.sourceIndex,
		resultEntryId: call.resultEntryId,
		replay: cleared.tool.replay ?? "never",
	};
	return {
		job: executeAndStage(lane, drive, batch, effectPending, cleared, toolContext, recovery),
	};
}

async function beginRecoveryCall<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	sources: BatchSource,
	call: Extract<ToolCall, { status: "effect_pending" }>,
	toolsByName: Map<string, AgentHarnessTool<TContext>>,
	toolContext: TContext,
	cancelled: boolean,
): Promise<{ job: Promise<LocalResult> }> {
	const toolCall = toolCallFor(sources, call);
	const tool = toolsByName.get(toolCall.name);
	if (!cancelled && call.replay === "safe" && tool?.replay === "safe") {
		const replay = await clearReplayCheckpoint(lane, drive, batch, call);
		if (replay.kind !== "args") return { job: Promise.resolve(replay) };
		const cleared: ClearedToolCall<TContext> = { toolCall, tool, args: replay.args };
		return { job: executeAndStage(lane, drive, batch, call, cleared, toolContext, true) };
	}
	const checkpoint = await readCheckpoint(lane, drive, call);
	if (checkpoint.kind !== "checkpoint") return { job: Promise.resolve(checkpoint) };
	return {
		job: stageOutcome(lane, drive, call, interruptedMessage(toolCall, checkpoint.value), false),
	};
}

async function runSequential<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	sources: BatchSource,
	execution:
		| {
				tools: AgentHarnessTool<TContext>[];
				toolsByName: Map<string, AgentHarnessTool<TContext>>;
				toolContext: TContext;
		  }
		| undefined,
	recovery: boolean,
): Promise<ProcedureResult> {
	for (let transition = 0; transition <= batch.calls.length * 2 + 1; transition += 1) {
		await materializeReady(lane, drive, batch, recovery);
		const current = currentBatch(lane);
		if (current === undefined) return { kind: "continue" };
		const call = current.batch.calls.find((candidate) => candidate.status !== "completed");
		if (call === undefined) throw new SessionInvariantError("Tool batch remained open after every call completed");
		if (call.status === "outcome_ready") throw new SessionInvariantError("Ready tool outcome was not materialized");

		if (current.run.control.status === "cancel_requested") {
			const toolCall = toolCallFor(sources, call);
			if (call.status === "planned") {
				await stageOutcome(lane, drive, call, abortedMessage(toolCall), false);
			} else {
				const checkpoint = await readCheckpoint(lane, drive, call);
				if (checkpoint.kind === "state_changed") continue;
				await stageOutcome(lane, drive, call, interruptedMessage(toolCall, checkpoint.value), false);
			}
			continue;
		}

		if (execution === undefined) throw new SessionInvariantError("Running tool batch is missing execution context");
		const started =
			call.status === "planned"
				? await beginFreshCall(lane, drive, batch, sources, call, execution.tools, execution.toolContext, recovery)
				: await beginRecoveryCall(
						lane,
						drive,
						batch,
						sources,
						call,
						execution.toolsByName,
						execution.toolContext,
						false,
					);
		await started.job;
	}
	throw new SessionInvariantError("Sequential tool batch exceeded its bounded transition count");
}

async function runParallel<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	batch: ToolBatch,
	sources: BatchSource,
	tools: AgentHarnessTool<TContext>[],
	toolsByName: Map<string, AgentHarnessTool<TContext>>,
	toolContext: TContext,
	recovery: boolean,
): Promise<ProcedureResult> {
	let materialization: Promise<PlacementResult> = Promise.resolve({ kind: "none" });
	const scheduleMaterialization = (): Promise<PlacementResult> => {
		const scheduled = materialization.then(() => materializeReady(lane, drive, batch, recovery));
		materialization = scheduled.catch(() => ({ kind: "none" }));
		return scheduled;
	};
	const jobs: Promise<LocalResult>[] = [];
	const snapshot = currentBatch(lane);
	if (snapshot === undefined) return { kind: "continue" };
	for (const call of snapshot.batch.calls) {
		if (call.status === "completed" || call.status === "outcome_ready") continue;
		const current = currentBatch(lane);
		if (current === undefined) break;
		const started =
			call.status === "planned"
				? await beginFreshCall(lane, drive, batch, sources, call, tools, toolContext, recovery)
				: await beginRecoveryCall(
						lane,
						drive,
						batch,
						sources,
						call,
						toolsByName,
						toolContext,
						current.run.control.status === "cancel_requested",
					);
		const job = started.job.then(async (result) => {
			if (result.kind === "committed") await scheduleMaterialization();
			return result;
		});
		void job.catch(() => {});
		jobs.push(job);
	}
	await Promise.all(jobs);
	await scheduleMaterialization();
	return { kind: "continue" };
}

/** Execute, recover, stage, and source-order one complete durable tool batch. */
export async function runTools<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunToolsOperation,
): Promise<ProcedureResult> {
	const batch = run.batch;
	const recovery = batch.calls.some((call) => call.status === "effect_pending" || call.status === "outcome_ready");
	if (recovery) {
		await lane.emitBatch(
			[
				{
					type: "turn_start",
					lane: lane.name,
					runId: drive.operationId,
					turnId: batch.turnId,
					recovery: true,
				},
			],
			drive.context,
		);
	}
	await materializeReady(lane, drive, batch, recovery);
	if (currentBatch(lane) === undefined) return { kind: "continue" };

	const sources = await readBatchSource(lane, drive, batch);
	if (toolOperation(lane).control.status === "cancel_requested") {
		return runSequential(lane, drive, batch, sources, undefined, recovery);
	}
	const config = lane.readConfig();
	const active = new Set(batch.configuration.activeToolNames);
	const tools = config.tools.filter((tool) => active.has(tool.name));
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const toolContext = await resolveToolContext(lane, drive);
	return toolOperation(lane).settings.toolExecution === "sequential"
		? runSequential(lane, drive, batch, sources, { tools, toolsByName, toolContext }, recovery)
		: runParallel(lane, drive, batch, sources, tools, toolsByName, toolContext, recovery);
}
