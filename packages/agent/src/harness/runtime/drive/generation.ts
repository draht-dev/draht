import {
	type AssistantMessage,
	type AssistantMessageEvent,
	AssistantMessageFrameEncoder,
	isRetryableAssistantError,
	type Tool,
} from "@draht/ai";
import type { AgentMessage } from "../../../types.ts";
import type { HarnessEvent } from "../../agent-harness.ts";
import { type Context, withAbortSignal } from "../../context.ts";
import { streamHarnessAssistant } from "../../execution/assistant.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { buildSessionContext } from "../../session/context.ts";
import { SessionInvariantError } from "../../session/session.ts";
import type {
	Entry,
	Generation,
	GenerationContext,
	JsonValue,
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
type ReadResult<T> = { kind: "value"; value: T } | { kind: "state_changed" } | LostOwnership;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sameReadyGeneration(current: Generation, expected: Extract<Generation, { status: "ready" }>): boolean {
	return (
		current.status === "ready" &&
		current.context.stepId === expected.context.stepId &&
		current.nextAttempt === expected.nextAttempt
	);
}

function uuidV7Timestamp(id: string): number {
	const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
	if (!Number.isSafeInteger(timestamp)) throw new SessionInvariantError(`Invalid reserved UUIDv7 ${id}`);
	return timestamp;
}

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

function providerError(message: SettledAssistantMessage): OperationError {
	return {
		code: "assistant_error",
		message: message.errorMessage ?? `Assistant request ended with ${message.stopReason}`,
	};
}

function normalizeError(message: SettledAssistantMessage, errorMessage: string): SettledAssistantMessage {
	return { ...message, stopReason: "error", errorMessage };
}

function normalizeAborted(message: SettledAssistantMessage): SettledAssistantMessage {
	return {
		...message,
		stopReason: "aborted",
		errorMessage: message.errorMessage ?? "Assistant request was cancelled",
	};
}

function retryDelay(baseDelayMs: number, attempt: number): number {
	const delay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
	return Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
}

function saturatingAdd(left: number, right: number): number {
	const sum = left + right;
	return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

function deferredHandleIsValid(
	message: SettledAssistantMessage,
	identity: GenerationContext["configuration"]["model"],
): boolean {
	const handle = message.deferred;
	return (
		message.stopReason === "deferred" &&
		handle !== undefined &&
		handle.id.length !== 0 &&
		handle.provider === identity.provider &&
		handle.modelId === identity.modelId &&
		handle.api === message.api
	);
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
	generation: Extract<Generation, { status: "ready" }>,
): Promise<ReadResult<AgentMessage[]>> {
	const path = await lane.commandDriveOwned<ReadResult<Entry[]>>(
		drive,
		async (state, reader): Promise<LaneCommand<ReadResult<Entry[]>>> => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Generation context reached a non-run operation");
			}
			if (operation.state.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			if (
				operation.state.phase.kind !== "assistant" ||
				!sameReadyGeneration(operation.state.phase.generation, generation)
			) {
				throw new SessionInvariantError("Generation context lost its ready boundary");
			}
			if (state.tipId === null) throw new SessionInvariantError("Assistant generation has no Branch tip");
			const entries = (
				await reader.scanBranch(
					{ start: state.tipId, stopAtType: "compaction", order: "newestFirst" },
					drive.context,
				)
			).reverse();
			return { kind: "return", result: { kind: "value", value: entries } as const };
		},
		drive.context,
	);
	if (path.kind !== "value") return path;
	return {
		kind: "value",
		value: await buildSessionContext(
			path.value,
			{ entryProjectors: lane.readConfig().entryProjectors },
			drive.context,
		),
	};
}

async function commitGenerationIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: Extract<Generation, { status: "ready" }>,
	generation: Extract<Generation, { status: "effect_pending" }>,
): Promise<LocalResult> {
	return lane.commandDriveOwned<LocalResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Generation intent reached a non-run operation");
			}
			const run = operation.state;
			if (run.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "state_changed" } as const };
			}
			if (run.phase.kind !== "assistant" || !sameReadyGeneration(run.phase.generation, expected)) {
				throw new SessionInvariantError("Generation intent lost its ready boundary");
			}
			const nextState: RunState = { ...run, phase: { kind: "assistant", generation } };
			return {
				kind: "commit",
				writes: [setValue(operationStateValue(drive.operationId), nextState)],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => ({ kind: "committed" }) as const,
				events: () =>
					expected.nextAttempt === 1
						? [
								{
									type: "turn_start",
									lane: lane.name,
									runId: drive.operationId,
									turnId: expected.context.stepId,
								},
							]
						: [],
			};
		},
		drive.context,
	);
}

/** Commit a non-retryable request-configuration failure before reserving response ids. */
export function enterConfigurationFailure<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	expected: Extract<Generation, { status: "ready" }>,
	error: OperationError,
): Promise<ProcedureResult> {
	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Configuration failure reached a non-run operation");
			}
			const run = operation.state;
			if (run.control.status === "cancel_requested") {
				return { kind: "return", result: { kind: "continue" } as const };
			}
			if (run.phase.kind !== "assistant" || !sameReadyGeneration(run.phase.generation, expected)) {
				throw new SessionInvariantError("Configuration failure lost its ready boundary");
			}
			const nextState: RunState = {
				...run,
				phase: { kind: "failure_drain", error, provenance: { kind: "configuration" } },
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

interface SettlementIdentity {
	responseEntryId: string;
	usageId: string;
	stepId: string;
}

/** Classify and atomically settle one complete assistant response under its reserved ids. */
export function settleAssistant<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	identity: SettlementIdentity,
	response: SettledAssistantMessage,
	options: { recovery?: true } = {},
): Promise<ProcedureResult> {
	return lane.commandDriveOwned<ProcedureResult>(
		drive,
		(state) => {
			const operation = state.operation;
			if (operation === null || operation.state.kind !== "run") {
				throw new SessionInvariantError("Assistant settlement reached a non-run operation");
			}
			const run = operation.state;
			if (run.phase.kind !== "assistant" || run.phase.generation.status !== "effect_pending") {
				throw new SessionInvariantError("Assistant settlement lost its effect-pending boundary");
			}
			const generation = run.phase.generation;
			if (
				generation.context.stepId !== identity.stepId ||
				generation.responseEntryId !== identity.responseEntryId ||
				generation.usageId !== identity.usageId
			) {
				throw new SessionInvariantError("Assistant settlement ids contradict the durable request intent");
			}

			const modelIdentity = generation.context.configuration.model;
			let committed = response;
			let nextPhase: RunState["phase"];
			if (run.control.status === "cancel_requested") {
				committed = normalizeAborted(response);
				nextPhase = {
					kind: "checkpoint",
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: identity.responseEntryId,
				};
			} else if (response.stopReason === "aborted") {
				throw new SessionInvariantError("Assistant response is aborted while durable control is running");
			} else if (response.stopReason === "deferred") {
				if (deferredHandleIsValid(response, modelIdentity)) {
					nextPhase = {
						kind: "deferred",
						deferred: {
							status: "suspended",
							stepId: generation.context.stepId,
							sourceEntryId: identity.responseEntryId,
							poll: 0,
							configuration: generation.context.configuration,
							streamOptions: generation.context.streamOptions,
						},
					};
				} else {
					committed = normalizeError(response, "Provider returned an invalid deferred handle");
					nextPhase = {
						kind: "failure_drain",
						error: providerError(committed),
						provenance: { kind: "response", entryId: identity.responseEntryId },
					};
				}
			} else if (
				response.stopReason === "error" &&
				(options.recovery === true || isRetryableAssistantError(response)) &&
				generation.attempt < generation.context.retryPolicy.maxAttempts
			) {
				const delayMs = retryDelay(generation.context.retryPolicy.baseDelayMs, generation.attempt);
				nextPhase = {
					kind: "assistant",
					generation: {
						status: "retry_wait",
						context: generation.context,
						nextAttempt: generation.attempt + 1,
						notBefore: saturatingAdd(Date.now(), delayMs),
						errorMessage: response.errorMessage ?? "Assistant request failed",
					},
				};
			} else if (response.stopReason === "error") {
				nextPhase = {
					kind: "failure_drain",
					error: providerError(response),
					provenance: { kind: "response", entryId: identity.responseEntryId },
				};
			} else {
				const calls = response.content.flatMap((content, sourceIndex) =>
					content.type === "toolCall" ? [{ content, sourceIndex }] : [],
				);
				if (calls.length !== 0) {
					const timestamp = uuidV7Timestamp(identity.responseEntryId);
					const planned: ToolCall[] = calls.map(({ sourceIndex }) => ({
						status: "planned",
						sourceIndex,
						resultEntryId: lane.session.idGenerator.next(timestamp),
					}));
					nextPhase = {
						kind: "tools",
						batch: {
							assistantEntryId: identity.responseEntryId,
							configuration: generation.context.configuration,
							turnId: generation.context.stepId,
							calls: planned,
						},
					};
				} else if (response.stopReason === "toolUse") {
					committed = normalizeError(response, "Provider reported tool use without any tool calls");
					nextPhase = {
						kind: "failure_drain",
						error: providerError(committed),
						provenance: { kind: "response", entryId: identity.responseEntryId },
					};
				} else {
					nextPhase = {
						kind: "checkpoint",
						continuation: { kind: "may_finish", includeFinalAssistant: true },
						triggerEntryId: identity.responseEntryId,
					};
				}
			}

			const nextState: RunState = {
				...run,
				phase: nextPhase,
				latestAssistantEntryId: identity.responseEntryId,
			};
			const responseEntry: NewEntry<MessageEntry> = {
				id: identity.responseEntryId,
				parentId: state.tipId,
				type: "message",
				message: committed,
			};
			const usageRow: Omit<UsageRow, "seq"> = {
				id: identity.usageId,
				usage: committed.usage,
				entryId: identity.responseEntryId,
				adjustment: false,
			};
			return {
				kind: "commit",
				writes: [
					insertEntry(responseEntry),
					insertUsage(usageRow),
					setValue(branchTip(lane.name), identity.responseEntryId),
					deleteList(pendingAssistantFrames(drive.operationId, identity.responseEntryId)),
					setValue(operationStateValue(drive.operationId), nextState),
				],
				next: {
					...state,
					tipId: identity.responseEntryId,
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
						{ type: "entry_added", lane: lane.name, entry, ...options },
						{
							type: "usage",
							lane: lane.name,
							row: { ...usageRow, seq: commit.seqs[1]! },
							totals: commit.stats.usage,
						},
					];
					if (
						options.recovery !== true &&
						nextPhase.kind === "assistant" &&
						nextPhase.generation.status === "retry_wait"
					) {
						events.push({
							type: "retry_scheduled",
							lane: lane.name,
							runId: drive.operationId,
							step: identity.stepId,
							attempt: nextPhase.generation.nextAttempt,
							maxAttempts: nextPhase.generation.context.retryPolicy.maxAttempts,
							delayMs: retryDelay(generation.context.retryPolicy.baseDelayMs, generation.attempt),
							errorMessage: nextPhase.generation.errorMessage,
						});
					}
					if (
						options.recovery !== true &&
						nextPhase.kind !== "tools" &&
						!(nextPhase.kind === "assistant" && nextPhase.generation.status === "retry_wait")
					) {
						events.push({
							type: "turn_end",
							lane: lane.name,
							runId: drive.operationId,
							turnId: identity.stepId,
							message: committed,
							toolResults: [],
							...options,
						});
					}
					return events;
				},
			};
		},
		drive.context,
	);
}

/** Execute one ready assistant generation through intent, admitted stream, and settlement. */
export async function runGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	generation: Generation,
): Promise<ProcedureResult> {
	if (generation.status !== "ready") {
		throw new SessionInvariantError("M3 runGeneration requires a ready generation");
	}
	if (run.phase.kind !== "assistant" || !sameReadyGeneration(run.phase.generation, generation)) {
		throw new SessionInvariantError("runGeneration requires its current ready phase");
	}
	if (run.control.status === "cancel_requested") return { kind: "continue" };

	const identity = generation.context.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) {
		return enterConfigurationFailure(lane, drive, generation, configurationError("model_unavailable", identity));
	}
	const config = lane.readConfig();
	const toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
	const missingTools = generation.context.configuration.activeToolNames.filter((name) => !toolsByName.has(name));
	if (missingTools.length !== 0) {
		return enterConfigurationFailure(
			lane,
			drive,
			generation,
			configurationError("configured_tools_unavailable", { tools: missingTools }),
		);
	}
	const tools: Tool[] = generation.context.configuration.activeToolNames.map((name) => {
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
	if (messages.kind === "lost_ownership") return messages;
	if (messages.kind === "state_changed") return { kind: "continue" };
	const systemPrompt = await resolveSystemPrompt(lane, drive.context);
	const beforeRequest = await lane.hooks.runWithGate(
		"before_request",
		{
			lane: lane.name,
			runId: drive.operationId,
			model,
			step: "assistant",
			attempt: generation.nextAttempt,
			streamOptions: generation.context.streamOptions,
		},
		drive.gate,
		drive.context,
	);
	const streamOptions: AgentHarnessStreamOptions =
		beforeRequest?.streamOptions === undefined
			? generation.context.streamOptions
			: applyStreamOptionsPatch(generation.context.streamOptions, beforeRequest.streamOptions);
	const at = Date.now();
	const responseEntryId = lane.session.idGenerator.next(at);
	const usageId = lane.session.idGenerator.next(at);
	const effectPending: Extract<Generation, { status: "effect_pending" }> = {
		status: "effect_pending",
		context: generation.context,
		attempt: generation.nextAttempt,
		responseEntryId,
		usageId,
		intendedOutputLimit: model.maxTokens,
		contextWindow: model.contextWindow,
	};
	const intent = await commitGenerationIntent(lane, drive, generation, effectPending);
	if (intent.kind === "lost_ownership") return intent;
	if (intent.kind === "state_changed") return { kind: "continue" };

	const progress = openFrameProgress(lane, drive, responseEntryId);
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
			messages.value,
			{
				model,
				systemPrompt,
				tools,
				thinkingLevel: generation.context.configuration.thinkingLevel,
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

	return settleAssistant(lane, drive, { responseEntryId, usageId, stepId: generation.context.stepId }, response);
}

export function interruptedAssistantMessage(
	generation: Extract<Generation, { status: "effect_pending" }>,
	partial: AssistantMessage | undefined,
): SettledAssistantMessage {
	const warning =
		"Assistant request was interrupted. The preceding content is the latest committed partial; newer live output may be missing and the external outcome is unknown.";
	return partial === undefined
		? {
				role: "assistant",
				content: [],
				api: "unknown",
				provider: generation.context.configuration.model.provider,
				model: generation.context.configuration.model.modelId,
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: warning,
				timestamp: Date.now(),
			}
		: { ...partial, usage: ZERO_USAGE, stopReason: "error", errorMessage: warning };
}
