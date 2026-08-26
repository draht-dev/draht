import {
	type AssistantMessageEvent,
	AssistantMessageFrameEncoder,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
} from "@draht/ai";
import type { HarnessEvent } from "../../agent-harness.ts";
import type { Context } from "../../context.ts";
import type { AssistantResponseMetadata, AssistantStreamObserver } from "../../execution/assistant.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type MessageEntry,
	type NewEntry,
	type OperationError,
	type OperationState,
	type RunAssistantEffectPendingOperation,
	type RunCompactionDecidingOperation,
	type RunDeferredEffectPendingOperation,
	type RunOperationState,
	runScopeOf,
	type SettledAssistantMessage,
	type ToolCall,
	type UsageRow,
	type Write,
} from "../../session/types.ts";
import { branchTip, deleteList, operationPreparation, pendingAssistantFrames, setValue } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import { openFrameProgress } from "../progress.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { retryDelay, retryNotBefore } from "./retry.ts";
import { prepareOverflowCompaction } from "./structural.ts";

export type AssistantResponseLifecycle = {
	observer: AssistantStreamObserver;
	afterResponse(
		message: SettledAssistantMessage,
		metadata: AssistantResponseMetadata,
		context: Context,
	): Promise<SettledAssistantMessage>;
	close(): Promise<void>;
};

export function openAssistantResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	responseEntryId: string,
	recovery = false,
): AssistantResponseLifecycle {
	const progress = openFrameProgress(lane, drive, responseEntryId);
	const frameEncoder = new AssistantMessageFrameEncoder();
	const eventContext = {
		lane: lane.name,
		runId: drive.operationId,
		...(recovery ? { recovery: true as const } : {}),
	};
	const close = async () => {
		progress.seal();
		await progress.drain();
	};
	return {
		observer: {
			start(message, event, context) {
				const frame = frameEncoder.encode(event);
				if (frame !== undefined) progress.write(frame);
				return lane.emitBatch([{ type: "message_start", ...eventContext, message }], context);
			},
			update(message, event: AssistantMessageEvent, context) {
				const frame = frameEncoder.encode(event);
				if (frame !== undefined) progress.write(frame);
				return lane.emitBatch(
					[{ type: "message_update", ...eventContext, message, event, ...(frame === undefined ? {} : { frame }) }],
					context,
				);
			},
			end(message, context) {
				return lane.emitBatch(
					[{ type: "message_end", ...eventContext, message, entryId: responseEntryId }],
					context,
				);
			},
		},
		async afterResponse(message, metadata, context) {
			await close();
			const result = await lane.hooks.runWithGate(
				"after_response",
				{ lane: lane.name, runId: drive.operationId, ...metadata, message },
				drive.gate,
				context,
			);
			return result?.message ?? message;
		},
		close,
	};
}

type ResponseIntent = RunAssistantEffectPendingOperation | RunDeferredEffectPendingOperation;

/** Publish a non-retryable request-configuration failure before reserving response ids. */
export async function publishConfigurationFailure<
	TContext extends object | undefined,
	TState extends RunOperationState,
>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: TState,
	error: OperationError,
	writes: Write[] = [],
): Promise<ProcedureResult> {
	const result = await lane.continueOperation(
		capability,
		(_state, current) => ({
			kind: "commit",
			writes,
			operationState: {
				...runScopeOf(current),
				at: "run.failure_drain",
				error,
				provenance: { kind: "configuration" },
			},
			materialize: () => ({ kind: "continue" }) as const,
		}),
		drive.context,
	);
	return result.kind === "cancel_requested" ? { kind: "continue" } : result.value;
}

function uuidV7Timestamp(id: string): number {
	const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
	if (!Number.isSafeInteger(timestamp)) throw new SessionInvariantError(`Invalid reserved UUIDv7 ${id}`);
	return timestamp;
}

function providerError(source: "assistant" | "deferred", message: SettledAssistantMessage): OperationError {
	return {
		code: "assistant_error",
		message:
			message.errorMessage ??
			`${source === "assistant" ? "Assistant" : "Deferred"} request ended with ${message.stopReason}`,
	};
}

function normalizeError(message: SettledAssistantMessage, errorMessage: string): SettledAssistantMessage {
	return { ...message, stopReason: "error", errorMessage };
}

function normalizeAborted(source: "assistant" | "deferred", message: SettledAssistantMessage): SettledAssistantMessage {
	return {
		...message,
		stopReason: "aborted",
		errorMessage:
			message.errorMessage ?? `${source === "assistant" ? "Assistant" : "Deferred"} request was cancelled`,
	};
}

function deferredHandleIsValid(
	message: SettledAssistantMessage,
	generation: RunAssistantEffectPendingOperation,
): boolean {
	const handle = message.deferred;
	const identity = generation.generationContext.configuration.model;
	return (
		message.stopReason === "deferred" &&
		handle !== undefined &&
		handle.id.length !== 0 &&
		handle.provider === identity.provider &&
		handle.modelId === identity.modelId &&
		handle.api === message.api
	);
}

/** Classify and atomically settle one assistant-generation or deferred-poll response. */
export async function publishResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	intent: ResponseIntent,
	response: SettledAssistantMessage,
	options: { recovery?: true } = {},
): Promise<ProcedureResult> {
	const overflow =
		intent.at === "run.assistant.effect_pending" &&
		(isContextOverflow(response, intent.contextWindow) || isRecoverableLength(response, intent.intendedOutputLimit));
	const overflowPreparation =
		overflow && !intent.generationContext.overflowRecoveryUsed
			? await prepareOverflowCompaction(lane, drive, intent)
			: undefined;
	return lane.settleOperation(
		intent,
		(state, current) => {
			const source = current.at === "run.assistant.effect_pending" ? "assistant" : "deferred";
			const responseEntryId = intent.responseEntryId;
			const configuration =
				current.at === "run.assistant.effect_pending"
					? current.generationContext.configuration
					: current.configuration;
			const turnId =
				current.at === "run.assistant.effect_pending"
					? current.generationContext.stepId
					: `${current.stepId}:poll:${current.poll}`;
			const scope = { ...runScopeOf(current), latestAssistantEntryId: responseEntryId };
			let committed = response;
			let settled: OperationState;

			if (current.control.status === "cancel_requested") {
				committed = normalizeAborted(source, response);
				settled = {
					...scope,
					at: "run.checkpoint",
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: responseEntryId,
				};
			} else if (response.stopReason === "aborted") {
				throw new SessionInvariantError(
					`${source === "assistant" ? "Assistant" : "Deferred"} response is aborted while durable control is running`,
				);
			} else if (current.at === "run.assistant.effect_pending" && overflow) {
				committed = normalizeError(
					response,
					response.errorMessage ?? "Assistant request exceeded the context window",
				);
				if (current.generationContext.overflowRecoveryUsed || overflowPreparation === undefined) {
					settled = {
						...scope,
						at: "run.failure_drain",
						error: providerError(source, committed),
						provenance: { kind: "response", entryId: responseEntryId },
					};
				} else {
					const structural: RunCompactionDecidingOperation = {
						...scope,
						at: "run.compaction.deciding",
						reason: "overflow",
						resumeAfter: {
							continuation: { kind: "need_assistant", overflowRecoveryUsed: true },
							triggerEntryId: current.generationContext.triggerEntryId,
							thresholdCheckedTriggerEntryId: current.generationContext.triggerEntryId,
						},
						taskId: overflowPreparation.taskId,
					};
					settled = structural;
				}
			} else if (response.stopReason === "deferred") {
				if (current.at === "run.assistant.effect_pending") {
					if (deferredHandleIsValid(response, current)) {
						settled = {
							...scope,
							at: "run.deferred.suspended",
							stepId: current.generationContext.stepId,
							sourceEntryId: responseEntryId,
							poll: 0,
							configuration,
							streamOptions: current.generationContext.streamOptions,
						};
					} else {
						committed = normalizeError(response, "Provider returned an invalid deferred handle");
						settled = {
							...scope,
							at: "run.failure_drain",
							error: providerError(source, committed),
							provenance: { kind: "response", entryId: responseEntryId },
						};
					}
				} else {
					settled = {
						...scope,
						at: "run.deferred.suspended",
						stepId: current.stepId,
						sourceEntryId: responseEntryId,
						poll: current.poll,
						configuration,
						streamOptions: current.streamOptions,
					};
				}
			} else if (response.stopReason === "error") {
				if (
					current.at === "run.assistant.effect_pending" &&
					(options.recovery === true || isRetryableAssistantError(response)) &&
					current.attempt < current.generationContext.retryPolicy.maxAttempts
				) {
					settled = {
						...scope,
						at: "run.assistant.retry_wait",
						generationContext: current.generationContext,
						nextAttempt: current.attempt + 1,
						notBefore: retryNotBefore(current.generationContext.retryPolicy.baseDelayMs, current.attempt),
						errorMessage: response.errorMessage ?? "Assistant request failed",
					};
				} else {
					settled = {
						...scope,
						at: "run.failure_drain",
						error: providerError(source, response),
						provenance: { kind: "response", entryId: responseEntryId },
					};
				}
			} else {
				const calls = response.content.flatMap((content, sourceIndex) =>
					content.type === "toolCall" ? [{ sourceIndex }] : [],
				);
				if (calls.length !== 0) {
					const timestamp = uuidV7Timestamp(responseEntryId);
					const planned: ToolCall[] = calls.map(({ sourceIndex }) => ({
						status: "planned",
						sourceIndex,
						resultEntryId: lane.session.idGenerator.next(timestamp),
					}));
					settled = {
						...scope,
						at: "run.tools",
						batch: { assistantEntryId: responseEntryId, configuration, turnId, calls: planned },
					};
				} else if (response.stopReason === "toolUse") {
					committed = normalizeError(response, "Provider reported tool use without any tool calls");
					settled = {
						...scope,
						at: "run.failure_drain",
						error: providerError(source, committed),
						provenance: { kind: "response", entryId: responseEntryId },
					};
				} else {
					settled = {
						...scope,
						at: "run.checkpoint",
						continuation: { kind: "may_finish", includeFinalAssistant: true },
						triggerEntryId: responseEntryId,
					};
				}
			}

			const responseEntry: NewEntry<MessageEntry> = {
				id: responseEntryId,
				parentId: state.tipId,
				type: "message",
				message: committed,
			};
			const usageRow: Omit<UsageRow, "seq"> = {
				id: intent.usageId,
				usage: committed.usage,
				entryId: responseEntryId,
				adjustment: false,
			};
			return {
				kind: "commit",
				writes: [
					insertEntry(responseEntry),
					insertUsage(usageRow),
					setValue(branchTip(lane.name), responseEntryId),
					deleteList(pendingAssistantFrames(drive.operationId, responseEntryId)),
					...(settled.at === "run.compaction.deciding" && overflowPreparation !== undefined
						? [
								setValue(
									operationPreparation(drive.operationId, overflowPreparation.taskId),
									overflowPreparation.preparation,
								),
							]
						: []),
				],
				operationState: settled,
				lane: { tipId: responseEntryId },
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
					if (current.at === "run.assistant.effect_pending") {
						if (options.recovery !== true && current.attempt > 1 && settled.at !== "run.assistant.retry_wait") {
							const success = committed.stopReason !== "error" && committed.stopReason !== "aborted";
							events.push({
								type: "retry_end",
								lane: lane.name,
								runId: drive.operationId,
								step: turnId,
								attempt: current.attempt,
								success,
								...(success
									? {}
									: {
											finalError:
												committed.errorMessage ?? `Assistant request ended with ${committed.stopReason}`,
										}),
							});
						}
						if (options.recovery !== true && settled.at === "run.assistant.retry_wait") {
							events.push({
								type: "retry_scheduled",
								lane: lane.name,
								runId: drive.operationId,
								step: turnId,
								attempt: settled.nextAttempt,
								maxAttempts: settled.generationContext.retryPolicy.maxAttempts,
								delayMs: retryDelay(current.generationContext.retryPolicy.baseDelayMs, current.attempt),
								errorMessage: settled.errorMessage,
							});
						}
						if (
							options.recovery !== true &&
							settled.at !== "run.tools" &&
							settled.at !== "run.assistant.retry_wait"
						) {
							events.push({
								type: "turn_end",
								lane: lane.name,
								runId: drive.operationId,
								turnId,
								message: committed,
								toolResults: [],
							});
						}
						if (settled.at === "run.compaction.deciding") {
							events.push({
								type: "compaction_start",
								lane: lane.name,
								runId: drive.operationId,
								reason: "overflow",
							});
						}
					} else if (settled.at !== "run.tools") {
						events.push({
							type: "turn_end",
							lane: lane.name,
							runId: drive.operationId,
							turnId,
							message: committed,
							toolResults: [],
							...options,
						});
					}
					if (
						(current.at === "run.deferred.effect_pending" || options.recovery !== true) &&
						settled.at === "run.deferred.suspended" &&
						committed.deferred !== undefined
					) {
						events.push({
							type: "run_suspend",
							lane: lane.name,
							runId: drive.operationId,
							reason: "deferred",
							deferred: committed.deferred,
							...(current.at === "run.deferred.effect_pending" ? options : {}),
						});
					}
					return events;
				},
			};
		},
		drive.context,
	);
}
