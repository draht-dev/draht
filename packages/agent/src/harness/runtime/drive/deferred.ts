import {
	type Api,
	type AssistantMessageEvent,
	AssistantMessageFrameEncoder,
	type DeferredHandle,
	type Model,
} from "@draht/ai";
import { withAbortSignal } from "../../context.ts";
import { AbortRequested } from "../../execution/effect-gate.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type LaneConfiguration,
	type OperationError,
	type OperationState,
	type RunDeferredEffectPendingOperation,
	type RunDeferredSuspendedOperation,
	type RunScope,
	runScopeOf,
	type SettledAssistantMessage,
} from "../../session/types.ts";
import { deleteList, pendingAssistantFrames } from "../../session/values.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { openFrameProgress } from "../progress.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { settleResponse } from "./response.ts";

type DeferredLeaf = RunDeferredSuspendedOperation | RunDeferredEffectPendingOperation;
/** Deferred effect payload without the run-wide scope fields. */
type EffectPendingFields = Omit<RunDeferredEffectPendingOperation, keyof RunScope>;
function configurationError(identity: LaneConfiguration["model"]): OperationError {
	return {
		code: "model_unavailable",
		message: "The configured model is unavailable in this process",
		details: identity,
	};
}

function isUpdateEvent(
	event: AssistantMessageEvent,
): event is Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }> {
	return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

async function readSourceHandle<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredLeaf,
): Promise<DeferredHandle | undefined> {
	return lane.advanceOperation(
		deferred,
		async (_state, _current, _meta, reader) => {
			const source = (await reader.getEntries([deferred.sourceEntryId], drive.context)).get(deferred.sourceEntryId);
			if (
				source?.type !== "message" ||
				source.message.role !== "assistant" ||
				source.message.stopReason !== "deferred" ||
				source.message.deferred === undefined
			) {
				throw new SessionInvariantError(
					`Deferred source ${deferred.sourceEntryId} is missing its assistant handle`,
				);
			}
			const handle = source.message.deferred;
			const identity = deferred.configuration.model;
			if (
				handle.id.length === 0 ||
				handle.provider !== identity.provider ||
				handle.modelId !== identity.modelId ||
				handle.api !== source.message.api
			) {
				throw new SessionInvariantError(`Deferred source ${deferred.sourceEntryId} has an invalid handle`);
			}
			return { kind: "return", result: handle };
		},
		drive.context,
	);
}

async function enterDeferredConfigurationFailure<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredLeaf,
): Promise<ProcedureResult> {
	const result = await lane.advanceOperation(
		deferred,
		(_state, current) => {
			const nextState: OperationState = {
				...runScopeOf(current),
				at: "run.failure_drain",
				error: configurationError(deferred.configuration.model),
				provenance: { kind: "configuration" },
			};
			return {
				kind: "commit",
				writes:
					deferred.at === "run.deferred.effect_pending"
						? [deleteList(pendingAssistantFrames(drive.operationId, deferred.responseEntryId))]
						: [],
				operationState: nextState,
				materialize: () => ({ kind: "continue" }) as const,
			};
		},
		drive.context,
	);
	return result ?? { kind: "continue" };
}

async function commitPollIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: DeferredLeaf,
	next: EffectPendingFields,
	recovery: boolean,
): Promise<RunDeferredEffectPendingOperation | undefined> {
	return lane.advanceOperation(
		deferred,
		(_state, current) => {
			if (drive.deferredPermits === 0) {
				throw new SessionInvariantError("Deferred poll intent lost its pass-local permit");
			}
			const nextState: RunDeferredEffectPendingOperation = { ...runScopeOf(current), ...next };
			return {
				kind: "commit",
				writes:
					deferred.at === "run.deferred.effect_pending"
						? [deleteList(pendingAssistantFrames(drive.operationId, deferred.responseEntryId))]
						: [],
				operationState: nextState,
				materialize: () => {
					drive.deferredPermits--;
					return nextState;
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

async function pollDeferred<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: DeferredLeaf,
	recovery: boolean,
): Promise<ProcedureResult> {
	const source = await readSourceHandle(lane, drive, expected);
	if (source === undefined) return { kind: "continue" };
	if (drive.deferredPermits === 0) {
		return {
			kind: "waiting",
			outcome: {
				kind: "waiting",
				operationId: drive.operationId,
				reason: "deferred",
				deferred: source,
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
			attempt: expected.at === "run.deferred.suspended" ? expected.poll + 1 : expected.poll,
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
	const poll = expected.at === "run.deferred.suspended" ? expected.poll + 1 : expected.poll;
	const at = Date.now();
	const responseEntryId = lane.session.idGenerator.next(at);
	const usageId = lane.session.idGenerator.next(at);
	const effectPending: EffectPendingFields = {
		at: "run.deferred.effect_pending",
		stepId: expected.stepId,
		sourceEntryId: expected.sourceEntryId,
		poll,
		responseEntryId,
		usageId,
		configuration: expected.configuration,
		streamOptions: expected.streamOptions,
	};
	const intent = await commitPollIntent(lane, drive, expected, effectPending, recovery);
	if (intent === undefined) return { kind: "continue" };

	const response = await streamDeferredResponse(
		lane,
		drive,
		model,
		source,
		streamOptions,
		intent.responseEntryId,
		recovery,
	);
	return settleResponse(lane, drive, intent, response, recovery ? { recovery: true } : {});
}

/** Poll one durably suspended deferred response when this pass carries a permit. */
export function runDeferredSuspended<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: RunDeferredSuspendedOperation,
): Promise<ProcedureResult> {
	return pollDeferred(lane, drive, deferred, false);
}

/** Replace one orphaned unknown-outcome poll under fresh ids when this pass carries a permit. */
export function recoverDeferredPoll<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: RunDeferredEffectPendingOperation,
): Promise<ProcedureResult> {
	return pollDeferred(lane, drive, deferred, true);
}

/** Advance or report the wait for one deferred run phase. */
export function runDeferred<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deferred: RunDeferredSuspendedOperation | RunDeferredEffectPendingOperation,
): Promise<ProcedureResult> {
	return deferred.at === "run.deferred.suspended"
		? runDeferredSuspended(lane, drive, deferred)
		: recoverDeferredPoll(lane, drive, deferred);
}
