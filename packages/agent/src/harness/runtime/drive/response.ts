import { isRetryableAssistantError } from "@draht/ai";
import type { HarnessEvent } from "../../agent-harness.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type MessageEntry,
	type NewEntry,
	type OperationError,
	type OperationState,
	type RunAssistantEffectPendingOperation,
	type RunDeferredEffectPendingOperation,
	runScopeOf,
	type SettledAssistantMessage,
	type ToolCall,
	type UsageRow,
} from "../../session/types.ts";
import { branchTip, deleteList, pendingAssistantFrames, setValue } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import type { Drive, ProcedureResult } from "../types.ts";

type ResponseIntent = RunAssistantEffectPendingOperation | RunDeferredEffectPendingOperation;

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
export function settleResponse<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	intent: ResponseIntent,
	response: SettledAssistantMessage,
	options: { recovery?: true } = {},
): Promise<ProcedureResult> {
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
					const delayMs = retryDelay(current.generationContext.retryPolicy.baseDelayMs, current.attempt);
					settled = {
						...scope,
						at: "run.assistant.retry_wait",
						generationContext: current.generationContext,
						nextAttempt: current.attempt + 1,
						notBefore: saturatingAdd(Date.now(), delayMs),
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
