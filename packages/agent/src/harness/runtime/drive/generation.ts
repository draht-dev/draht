import { type AssistantMessage, type AssistantMessageEvent, AssistantMessageFrameEncoder, type Tool } from "@draht/ai";
import type { AgentMessage } from "../../../types.ts";
import { type Context, withAbortSignal } from "../../context.ts";
import { streamHarnessAssistant } from "../../execution/assistant.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { buildSessionContext } from "../../session/context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type JsonValue,
	type OperationError,
	type OperationState,
	type RunAssistantEffectPendingOperation,
	type RunAssistantReadyOperation,
	type RunAssistantRetryWaitOperation,
	type RunScope,
	runScopeOf,
	type SettledAssistantMessage,
} from "../../session/types.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { openFrameProgress } from "../progress.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { settleResponse } from "./response.ts";

/** Assistant effect-pending payload without the run-wide scope fields. */
type AssistantEffectPending = Omit<RunAssistantEffectPendingOperation, keyof RunScope>;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function configurationError(
	code: "model_unavailable" | "configured_tools_unavailable",
	details: JsonValue,
): OperationError {
	return {
		code,
		message:
			code === "model_unavailable"
				? "The configured model is unavailable in this process"
				: "One or more configured tools are unavailable in this process",
		details,
	};
}

function waitUntil(notBefore: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		const check = () => {
			const remaining = notBefore - Date.now();
			if (remaining <= 0) {
				cleanup();
				resolve();
				return;
			}
			timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		else check();
	});
}

async function resolveSystemPrompt<TContext extends object | undefined>(
	lane: Lane<TContext>,
	context: Context,
): Promise<string> {
	const config = lane.readConfig();
	if (config.systemPrompt === undefined) return "";
	if (typeof config.systemPrompt === "string") return config.systemPrompt;
	const source = config.toolContext;
	const toolContext = typeof source === "function" ? await source(context) : source;
	return config.systemPrompt(toolContext as TContext, context);
}

async function readRequestMessages<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: RunAssistantReadyOperation,
): Promise<AgentMessage[] | undefined> {
	const path = await lane.continueOperation(
		generation,
		async (state, _current, _meta, reader) => {
			if (state.tipId === null) throw new SessionInvariantError("Assistant generation has no Branch tip");
			const entries = (
				await reader.scanBranch(
					{ start: state.tipId, stopAtType: "compaction", order: "newestFirst" },
					drive.context,
				)
			).reverse();
			return { kind: "return", result: entries };
		},
		drive.context,
	);
	return path === undefined
		? undefined
		: buildSessionContext(path, { entryProjectors: lane.readConfig().entryProjectors }, drive.context);
}

async function commitGenerationIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: RunAssistantReadyOperation,
	pending: AssistantEffectPending,
): Promise<RunAssistantEffectPendingOperation | undefined> {
	return lane.continueOperation(
		ready,
		(_state, current) => {
			const nextState: RunAssistantEffectPendingOperation = { ...runScopeOf(current), ...pending };
			return {
				kind: "commit",
				writes: [],
				operationState: nextState,
				materialize: () => nextState,
				events: () =>
					ready.nextAttempt === 1
						? [
								{
									type: "turn_start",
									lane: lane.name,
									runId: drive.operationId,
									turnId: ready.generationContext.stepId,
								},
							]
						: [],
			};
		},
		drive.context,
	);
}

/** Commit a non-retryable request-configuration failure before reserving response ids. */
export async function enterConfigurationFailure<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: RunAssistantReadyOperation,
	error: OperationError,
): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		ready,
		(_state, current) => {
			const nextState: OperationState = {
				...runScopeOf(current),
				at: "run.failure_drain",
				error,
				provenance: { kind: "configuration" },
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

/** Advance one durable assistant retry wait according to this pass's local wait policy. */
export async function runRetryWait<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: RunAssistantRetryWaitOperation,
): Promise<ProcedureResult> {
	if (Date.now() < generation.notBefore) {
		if (!drive.waitForRetry) {
			return {
				kind: "waiting",
				outcome: {
					kind: "waiting",
					operationId: drive.operationId,
					reason: "retry",
					notBefore: generation.notBefore,
				},
			};
		}
		await drive.gate.admit(() => waitUntil(generation.notBefore, drive.gate.signal));
	}

	const result = await lane.continueOperation(
		generation,
		(_state, current) => {
			const nextState: RunAssistantReadyOperation = {
				...runScopeOf(current),
				at: "run.assistant.ready",
				generationContext: generation.generationContext,
				nextAttempt: generation.nextAttempt,
			};
			return {
				kind: "commit",
				writes: [],
				operationState: nextState,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "retry_start",
						lane: lane.name,
						runId: drive.operationId,
						step: generation.generationContext.stepId,
						attempt: generation.nextAttempt,
					},
				],
			};
		},
		drive.context,
	);
	return result ?? { kind: "continue" };
}

/** Execute one ready assistant generation or advance its durable retry wait. */
export async function runGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: RunAssistantReadyOperation | RunAssistantRetryWaitOperation,
): Promise<ProcedureResult> {
	if (generation.at === "run.assistant.retry_wait") return runRetryWait(lane, drive, generation);

	const identity = generation.generationContext.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) {
		return enterConfigurationFailure(lane, drive, generation, configurationError("model_unavailable", identity));
	}
	const config = lane.readConfig();
	const toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
	const missingTools = generation.generationContext.configuration.activeToolNames.filter(
		(name) => !toolsByName.has(name),
	);
	if (missingTools.length !== 0) {
		return enterConfigurationFailure(
			lane,
			drive,
			generation,
			configurationError("configured_tools_unavailable", { tools: missingTools }),
		);
	}
	const tools: Tool[] = generation.generationContext.configuration.activeToolNames.map((name) => {
		const tool = toolsByName.get(name);
		if (tool === undefined) throw new SessionInvariantError(`Configured tool ${name} disappeared during resolution`);
		return {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
		};
	});

	const messages = await readRequestMessages(lane, drive, generation);
	if (messages === undefined) return { kind: "continue" };
	const systemPrompt = await resolveSystemPrompt(lane, drive.context);
	const beforeRequest = await lane.hooks.runWithGate(
		"before_request",
		{
			lane: lane.name,
			runId: drive.operationId,
			model,
			step: "assistant",
			attempt: generation.nextAttempt,
			streamOptions: generation.generationContext.streamOptions,
		},
		drive.gate,
		drive.context,
	);
	const streamOptions: AgentHarnessStreamOptions =
		beforeRequest?.streamOptions === undefined
			? generation.generationContext.streamOptions
			: applyStreamOptionsPatch(generation.generationContext.streamOptions, beforeRequest.streamOptions);
	const at = Date.now();
	const responseEntryId = lane.session.idGenerator.next(at);
	const usageId = lane.session.idGenerator.next(at);
	const effectPending: AssistantEffectPending = {
		at: "run.assistant.effect_pending",
		generationContext: generation.generationContext,
		attempt: generation.nextAttempt,
		responseEntryId,
		usageId,
		intendedOutputLimit: model.maxTokens,
		contextWindow: model.contextWindow,
	};
	const intent = await commitGenerationIntent(lane, drive, generation, effectPending);
	if (intent === undefined) return { kind: "continue" };

	const progress = openFrameProgress(lane, drive, intent.responseEntryId);
	const frameEncoder = new AssistantMessageFrameEncoder();
	let drained = false;
	const drainProgress = async () => {
		if (drained) return;
		progress.seal();
		await progress.drain();
		drained = true;
	};
	let response: SettledAssistantMessage;
	try {
		response = await streamHarnessAssistant(
			messages,
			{
				model,
				systemPrompt,
				tools,
				thinkingLevel: generation.generationContext.configuration.thinkingLevel,
				streamOptions,
				transformContext: async (requestContext, context) => {
					const result = await lane.hooks.runWithGate(
						"transform_context",
						{ lane: lane.name, runId: drive.operationId, ...requestContext },
						drive.gate,
						context,
					);
					return {
						messages: result?.messages ?? requestContext.messages,
						systemPrompt: result?.systemPrompt ?? requestContext.systemPrompt,
					};
				},
				toProviderMessages: config.toProviderMessages,
				beforePayload: async (payload, requestModel, context) => {
					const result = await lane.hooks.runWithGate(
						"before_payload",
						{ lane: lane.name, runId: drive.operationId, model: requestModel, payload },
						drive.gate,
						context,
					);
					return result?.payload;
				},
				afterResponse: async (message, metadata, context) => {
					await drainProgress();
					const result = await lane.hooks.runWithGate(
						"after_response",
						{ lane: lane.name, runId: drive.operationId, ...metadata, message },
						drive.gate,
						context,
					);
					return result?.message ?? message;
				},
				request: (aiContext, options, context) => {
					const admitted = withAbortSignal(drive.gate.signal, context);
					return drive.gate.admit(() =>
						lane.models.streamSimple(model, aiContext, {
							...options,
							signal: admitted.abortSignal,
							telemetryContext: admitted.telemetryContext,
						}),
					);
				},
				observer: {
					start(message, event, context) {
						const frame = frameEncoder.encode(event);
						if (frame !== undefined) progress.write(frame);
						return lane.emitBatch(
							[{ type: "message_start", lane: lane.name, runId: drive.operationId, message }],
							context,
						);
					},
					update(message, event: AssistantMessageEvent, context) {
						const frame = frameEncoder.encode(event);
						if (frame !== undefined) progress.write(frame);
						return lane.emitBatch(
							[
								{
									type: "message_update",
									lane: lane.name,
									runId: drive.operationId,
									message,
									event,
									...(frame === undefined ? {} : { frame }),
								},
							],
							context,
						);
					},
					end(message, context) {
						return lane.emitBatch(
							[
								{
									type: "message_end",
									lane: lane.name,
									runId: drive.operationId,
									message,
									entryId: responseEntryId,
								},
							],
							context,
						);
					},
				},
			},
			drive.context,
		);
	} finally {
		await drainProgress();
	}

	return settleResponse(lane, drive, intent, response);
}

export function interruptedAssistantMessage(
	generation: RunAssistantEffectPendingOperation,
	partial: AssistantMessage | undefined,
): SettledAssistantMessage {
	const warning =
		"Assistant request was interrupted. The preceding content is the latest committed partial; newer live output may be missing and the external outcome is unknown.";
	return partial === undefined
		? {
				role: "assistant",
				content: [],
				api: "unknown",
				provider: generation.generationContext.configuration.model.provider,
				model: generation.generationContext.configuration.model.modelId,
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: warning,
				timestamp: Date.now(),
			}
		: { ...partial, usage: ZERO_USAGE, stopReason: "error", errorMessage: warning };
}
