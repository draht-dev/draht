import {
	type Api,
	type AssistantMessageEvent,
	AssistantMessageFrameEncoder,
	type DeferredHandle,
	type Model,
} from "@draht/ai";
import type { HarnessEvent } from "../../agent-harness.ts";
import { withAbortSignal } from "../../context.ts";
import { AbortRequested } from "../../execution/effect-gate.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import type {
	Deferred,
	MessageEntry,
	NewEntry,
	OperationError,
	RunState,
	SettledAssistantMessage,
	ToolCall,
	UsageRow,
} from "../../session/types.ts";
import {
	branchTip,
	deleteList,
	operationState as operationStateValue,
	pendingAssistantFrames,
	setValue,
} from "../../session/values.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { openFrameProgress } from "../progress.ts";
import type { Drive, LaneCommand, LostOwnership, ProcedureResult } from "../types.ts";

type LocalResult = { kind: "committed" } | { kind: "state_changed" } | LostOwnership;
type SourceResult = { kind: "value"; handle: DeferredHandle } | { kind: "state_changed" } | LostOwnership;

function sameDeferred(current: Deferred, expected: Deferred): boolean {
	if (
		current.status !== expected.status ||
		current.stepId !== expected.stepId ||
		current.sourceEntryId !== expected.sourceEntryId ||
		current.poll !== expected.poll
	) {
		return false;
	}
	return (
		current.status === "suspended" ||
		(expected.status === "effect_pending" &&
			current.responseEntryId === expected.responseEntryId &&
			current.usageId === expected.usageId)
	);
}

function configurationError(identity: Deferred["configuration"]["model"]): OperationError {
	return {
		code: "model_unavailable",
		message: "The configured model is unavailable in this process",
		details: identity,
	};
}

function providerError(message: SettledAssistantMessage): OperationError {
	return {
		code: "assistant_error",
		message: message.errorMessage ?? `Deferred request ended with ${message.stopReason}`,
	};
}

function normalizeError(message: SettledAssistantMessage, errorMessage: string): SettledAssistantMessage {
	return { ...message, stopReason: "error", errorMessage };
}

function normalizeAborted(message: SettledAssistantMessage): SettledAssistantMessage {
	return {
		...message,
		stopReason: "aborted",
		errorMessage: message.errorMessage ?? "Deferred request was cancelled",
	};
}

function uuidV7Timestamp(id: string): number {
	const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
	if (!Number.isSafeInteger(timestamp)) throw new SessionInvariantError(`Invalid reserved UUIDv7 ${id}`);
	return timestamp;
}

function isUpdateEvent(
	event: AssistantMessageEvent,
): event is Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }> {
	return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

async function readSourceHandle<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: Deferred,
): Promise<SourceResult> {
	return lane.commandDriveOwned<SourceResult>(
		drive,
		async (state, reader): Promise<LaneCommand<SourceResult>> => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Deferred source reached a non-run operation");
			}
			const run = operation.state;
			if (run.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			if (run.phase.kind !== "deferred" || !sameDeferred(run.phase.deferred, expected)) {
				throw new SessionInvariantError("Deferred source lost its durable boundary");
			}
			const source = (await reader.getEntries([expected.sourceEntryId], drive.context)).get(expected.sourceEntryId);
			if (
				source?.type !== "message" ||
				source.message.role !== "assistant" ||
				source.message.stopReason !== "deferred" ||
				source.message.deferred === undefined
			) {
				throw new SessionInvariantError(
					`Deferred source ${expected.sourceEntryId} is missing its assistant handle`,
				);
			}
			const handle = source.message.deferred;
			const identity = expected.configuration.model;
			if (
				handle.id.length === 0 ||
				handle.provider !== identity.provider ||
				handle.modelId !== identity.modelId ||
				handle.api !== source.message.api
			) {
				throw new SessionInvariantError(`Deferred source ${expected.sourceEntryId} has an invalid handle`);
			}
			return { kind: "return", result: { kind: "value", handle } as const };
		},
		drive.context,
	);
}

function enterDeferredConfigurationFailure<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: Deferred,
): Promise<ProcedureResult> {
	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Deferred configuration failure reached a non-run operation");
			}
			const run = operation.state;
			if (run.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (run.phase.kind !== "deferred" || !sameDeferred(run.phase.deferred, expected)) {
				throw new SessionInvariantError("Deferred configuration failure lost its durable boundary");
			}
			const nextState: RunState = {
				...run,
				phase: {
					kind: "failure_drain",
					error: configurationError(expected.configuration.model),
					provenance: { kind: "configuration" },
				},
			};
			return {
				kind: "commit",
				writes: [
					...(expected.status === "effect_pending"
						? [deleteList(pendingAssistantFrames(drive.operationId, expected.responseEntryId))]
						: []),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => ({ kind: "continue" }) as const,
			};
		},
		drive.context,
	);
}

async function commitPollIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: Deferred,
	next: Extract<Deferred, { status: "effect_pending" }>,
	recovery: boolean,
): Promise<LocalResult> {
	return lane.commandDriveOwned<LocalResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Deferred poll intent reached a non-run operation");
			}
			const run = operation.state;
			if (run.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			if (drive.deferredPermits === 0) {
				throw new SessionInvariantError("Deferred poll intent lost its pass-local permit");
			}
			if (run.phase.kind !== "deferred" || !sameDeferred(run.phase.deferred, expected)) {
				throw new SessionInvariantError("Deferred poll intent lost its durable boundary");
			}
			const nextState: RunState = { ...run, phase: { kind: "deferred", deferred: next } };
			return {
				kind: "commit",
				writes: [
					...(expected.status === "effect_pending"
						? [deleteList(pendingAssistantFrames(drive.operationId, expected.responseEntryId))]
						: []),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => {
					drive.deferredPermits--;
					return { kind: "committed" } as const;
				},
				events: () => [
					{
						type: "turn_start",
						lane: lane.name,
						runId: drive.operationId,
						turnId: `${next.stepId}:poll:${next.poll}`,
						...(recovery ? { recovery: true as const } : {}),
					},
				],
			};
		},
		drive.context,
	);
}

async function streamDeferredResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	model: Model<Api>,
	handle: DeferredHandle,
	streamOptions: AgentHarnessStreamOptions,
	responseEntryId: string,
	recovery: boolean,
): Promise<SettledAssistantMessage> {
	const progress = openFrameProgress(lane, drive, responseEntryId);
	const frameEncoder = new AssistantMessageFrameEncoder();
	let metadata: { status?: number; headers?: Record<string, string> } = {};
	let drained = false;
	const drainProgress = async () => {
		if (drained) return;
		progress.seal();
		await progress.drain();
		drained = true;
	};
	const admitted = withAbortSignal(drive.gate.signal, drive.context);
	const stream = drive.gate.admit(() =>
		lane.models.streamDeferred(model, handle, {
			wait: 0,
			signal: admitted.abortSignal,
			telemetryContext: admitted.telemetryContext,
			timeoutMs: streamOptions.timeoutMs,
			maxRetries: streamOptions.maxRetries,
			maxRetryDelayMs: streamOptions.maxRetryDelayMs,
			headers: streamOptions.headers,
			onPayload: async (payload, requestModel) => {
				const result = await lane.hooks.runWithGate(
					"before_payload",
					{ lane: lane.name, runId: drive.operationId, model: requestModel, payload },
					drive.gate,
					drive.context,
				);
				return result?.payload;
			},
			onResponse: (response) => {
				metadata = { status: response.status, headers: response.headers };
			},
		}),
	);

	let started = false;
	let response: SettledAssistantMessage;
	try {
		for await (const event of stream) {
			if (event.type === "start") {
				if (started) throw new Error("Assistant message stream emitted more than one start event");
				started = true;
				const frame = frameEncoder.encode(event);
				if (frame !== undefined) progress.write(frame);
				await lane.emitBatch(
					[
						{
							type: "message_start",
							lane: lane.name,
							runId: drive.operationId,
							message: { ...event.partial },
							...(recovery ? { recovery: true as const } : {}),
						},
					],
					drive.context,
				);
			} else if (isUpdateEvent(event)) {
				if (!started) throw new Error(`Assistant message stream emitted ${event.type} before start`);
				const frame = frameEncoder.encode(event);
				if (frame !== undefined) progress.write(frame);
				await lane.emitBatch(
					[
						{
							type: "message_update",
							lane: lane.name,
							runId: drive.operationId,
							message: { ...event.partial },
							event,
							...(frame === undefined ? {} : { frame }),
							...(recovery ? { recovery: true as const } : {}),
						},
					],
					drive.context,
				);
			} else if (event.type === "done" && !started) {
				throw new Error("Assistant message stream emitted done before start");
			}
		}
		response = (await stream.result()) as SettledAssistantMessage;
	} finally {
		await drainProgress();
	}

	let final = response;
	try {
		const transformed = await lane.hooks.runWithGate(
			"after_response",
			{ lane: lane.name, runId: drive.operationId, ...metadata, message: response },
			drive.gate,
			drive.context,
		);
		final = transformed?.message ?? response;
	} catch (error) {
		if (!(error instanceof AbortRequested)) throw error;
		await error.cancellation;
	}
	await lane.emitBatch(
		[
			{
				type: "message_end",
				lane: lane.name,
				runId: drive.operationId,
				message: final,
				entryId: responseEntryId,
				...(recovery ? { recovery: true as const } : {}),
			},
		],
		drive.context,
	);
	return final;
}

async function settleDeferredResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: Extract<Deferred, { status: "effect_pending" }>,
	response: SettledAssistantMessage,
	recovery: boolean,
): Promise<ProcedureResult> {
	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Deferred settlement reached a non-run operation");
			}
			const run = operation.state;
			if (run.phase.kind !== "deferred" || !sameDeferred(run.phase.deferred, expected)) {
				throw new SessionInvariantError("Deferred settlement lost its effect-pending boundary");
			}

			let committed = response;
			let nextPhase: RunState["phase"];
			if (run.control.status === "cancel_requested") {
				committed = normalizeAborted(response);
				nextPhase = {
					kind: "checkpoint",
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: expected.responseEntryId,
				};
			} else if (response.stopReason === "aborted") {
				throw new SessionInvariantError("Deferred response is aborted while durable control is running");
			} else if (response.stopReason === "deferred") {
				nextPhase = {
					kind: "deferred",
					deferred: {
						status: "suspended",
						stepId: expected.stepId,
						sourceEntryId: expected.responseEntryId,
						poll: expected.poll,
						configuration: expected.configuration,
						streamOptions: expected.streamOptions,
					},
				};
			} else if (response.stopReason === "error") {
				nextPhase = {
					kind: "failure_drain",
					error: providerError(response),
					provenance: { kind: "response", entryId: expected.responseEntryId },
				};
			} else {
				const calls = response.content.flatMap((content, sourceIndex) =>
					content.type === "toolCall" ? [{ content, sourceIndex }] : [],
				);
				if (calls.length !== 0) {
					const timestamp = uuidV7Timestamp(expected.responseEntryId);
					const planned: ToolCall[] = calls.map(({ sourceIndex }) => ({
						status: "planned",
						sourceIndex,
						resultEntryId: lane.session.idGenerator.next(timestamp),
					}));
					nextPhase = {
						kind: "tools",
						batch: {
							assistantEntryId: expected.responseEntryId,
							configuration: expected.configuration,
							turnId: `${expected.stepId}:poll:${expected.poll}`,
							calls: planned,
						},
					};
				} else if (response.stopReason === "toolUse") {
					committed = normalizeError(response, "Provider reported tool use without any tool calls");
					nextPhase = {
						kind: "failure_drain",
						error: providerError(committed),
						provenance: { kind: "response", entryId: expected.responseEntryId },
					};
				} else {
					nextPhase = {
						kind: "checkpoint",
						continuation: { kind: "may_finish", includeFinalAssistant: true },
						triggerEntryId: expected.responseEntryId,
					};
				}
			}

			const nextState: RunState = {
				...run,
				phase: nextPhase,
				latestAssistantEntryId: expected.responseEntryId,
			};
			const responseEntry: NewEntry<MessageEntry> = {
				id: expected.responseEntryId,
				parentId: state.tipId,
				type: "message",
				message: committed,
			};
			const usageRow: Omit<UsageRow, "seq"> = {
				id: expected.usageId,
				usage: committed.usage,
				entryId: expected.responseEntryId,
				adjustment: false,
			};
			return {
				kind: "commit",
				writes: [
					insertEntry(responseEntry),
					insertUsage(usageRow),
					setValue(branchTip(lane.name), expected.responseEntryId),
					deleteList(pendingAssistantFrames(drive.operationId, expected.responseEntryId)),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: {
					...state,
					tipId: expected.responseEntryId,
					operation: { meta: operation.meta, state: nextState },
				},
				materialize: () => ({ kind: "continue" }) as const,
				events: (commit) => {
					const entry: MessageEntry = {
						...responseEntry,
						seq: commit.seqs[0]!,
						timestamp: commit.timestamp,
					};
					const events: HarnessEvent[] = [
						{ type: "entry_added", lane: lane.name, entry, ...(recovery ? { recovery: true } : {}) },
						{
							type: "usage",
							lane: lane.name,
							row: { ...usageRow, seq: commit.seqs[1]! },
							totals: commit.stats.usage,
						},
					];
					if (nextPhase.kind !== "tools") {
						events.push({
							type: "turn_end",
							lane: lane.name,
							runId: drive.operationId,
							turnId: `${expected.stepId}:poll:${expected.poll}`,
							message: committed,
							toolResults: [],
							...(recovery ? { recovery: true } : {}),
						});
					}
					if (nextPhase.kind === "deferred" && committed.deferred !== undefined) {
						events.push({
							type: "run_suspend",
							lane: lane.name,
							runId: drive.operationId,
							reason: "deferred",
							deferred: committed.deferred,
							...(recovery ? { recovery: true } : {}),
						});
					}
					return events;
				},
			};
		},
		drive.context,
	);
}

async function pollDeferred<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	expected: Deferred,
	recovery: boolean,
): Promise<ProcedureResult> {
	if (run.phase.kind !== "deferred" || !sameDeferred(run.phase.deferred, expected)) {
		throw new SessionInvariantError("Deferred procedure requires its current durable phase");
	}
	if (run.control.status === "cancel_requested") return { kind: "continue" };
	const source = await readSourceHandle(lane, drive, expected);
	if (source.kind === "lost_ownership") return source;
	if (source.kind === "state_changed") return { kind: "continue" };
	if (drive.deferredPermits === 0) {
		return {
			kind: "waiting",
			outcome: {
				kind: "waiting",
				operationId: drive.operationId,
				reason: "deferred",
				deferred: source.handle,
			},
		};
	}

	const identity = expected.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) return enterDeferredConfigurationFailure(lane, drive, expected);
	const baseOptions: AgentHarnessStreamOptions = { ...expected.streamOptions, deferred: false };
	const beforeRequest = await lane.hooks.runWithGate(
		"before_request",
		{
			lane: lane.name,
			runId: drive.operationId,
			model,
			step: "deferred",
			attempt: expected.status === "suspended" ? expected.poll + 1 : expected.poll,
			streamOptions: baseOptions,
		},
		drive.gate,
		drive.context,
	);
	const streamOptions: AgentHarnessStreamOptions = {
		...(beforeRequest?.streamOptions === undefined
			? baseOptions
			: applyStreamOptionsPatch(baseOptions, beforeRequest.streamOptions)),
		deferred: false,
	};
	const poll = expected.status === "suspended" ? expected.poll + 1 : expected.poll;
	const at = Date.now();
	const responseEntryId = lane.session.idGenerator.next(at);
	const usageId = lane.session.idGenerator.next(at);
	const effectPending: Extract<Deferred, { status: "effect_pending" }> = {
		status: "effect_pending",
		stepId: expected.stepId,
		sourceEntryId: expected.sourceEntryId,
		poll,
		responseEntryId,
		usageId,
		configuration: expected.configuration,
		streamOptions: expected.streamOptions,
	};
	const intent = await commitPollIntent(lane, drive, expected, effectPending, recovery);
	if (intent.kind === "lost_ownership") return intent;
	if (intent.kind === "state_changed") return { kind: "continue" };

	const response = await streamDeferredResponse(
		lane,
		drive,
		model,
		source.handle,
		streamOptions,
		responseEntryId,
		recovery,
	);
	return settleDeferredResponse(lane, drive, effectPending, response, recovery);
}

/** Poll one durably suspended deferred response when this pass carries a permit. */
export function runDeferredSuspended<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	deferred: Extract<Deferred, { status: "suspended" }>,
): Promise<ProcedureResult> {
	return pollDeferred(lane, drive, run, deferred, false);
}

/** Replace one orphaned unknown-outcome poll under fresh ids when this pass carries a permit. */
export function recoverDeferredPoll<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	deferred: Extract<Deferred, { status: "effect_pending" }>,
): Promise<ProcedureResult> {
	return pollDeferred(lane, drive, run, deferred, true);
}

/** Advance or report the wait for one deferred run phase. */
export function runDeferred<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	deferred: Deferred,
): Promise<ProcedureResult> {
	return deferred.status === "suspended"
		? runDeferredSuspended(lane, drive, run, deferred)
		: recoverDeferredPoll(lane, drive, run, deferred);
}
