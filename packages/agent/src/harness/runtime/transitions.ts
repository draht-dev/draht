import type { Api, AssistantMessage, Models, RetryPolicy, Usage } from "@draht/ai";
import { isContextOverflow, isRecoverableLength, isRetryableAssistantError } from "@draht/ai";
import type { AgentMessage, AgentToolCall } from "../../types.ts";
import type { DriveOptions, SuspendedOperation, TerminalOperationOutcome } from "../agent-harness.ts";
import type { RestoredLane } from "../restore.ts";
import { SessionInvariantError } from "../session/session.ts";
import type {
	LaneConfiguration,
	LaneLastResult,
	RunState,
	SessionMutator,
	SettledAssistantMessage,
} from "../session/types.ts";
import type { AssistantSettlementDecision, RuntimeSettings } from "./types.ts";
import { RuntimeSliceNotImplemented } from "./types.ts";

export function uuidV7Timestamp(id: string): number {
	const timestamp = Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new SessionInvariantError(`Invalid UUIDv7 id: ${id}`);
	}
	return timestamp;
}

export function classifyAssistantSettlement(
	message: SettledAssistantMessage,
	pending: Extract<RunState["phase"], { kind: "assistant" }>["generation"] & { status: "effect_pending" },
	controlStatus: RunState["control"]["status"],
	responseEntryId: string,
	requestApi: Api,
	now: number,
	sourceCalls: AgentToolCall[],
	resultEntryIds: string[],
): AssistantSettlementDecision {
	if (controlStatus === "cancel_requested") {
		const normalized: SettledAssistantMessage = {
			...message,
			stopReason: "aborted",
			errorMessage: message.errorMessage ?? "Assistant request was cancelled",
		};
		return {
			message: normalized,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseEntryId,
			},
			outcome: { kind: "aborted" },
		};
	}
	if (message.stopReason === "aborted") {
		throw new SessionInvariantError("Assistant response is aborted without durable cancellation");
	}
	if (isContextOverflow(message, pending.contextWindow) || isRecoverableLength(message, pending.intendedOutputLimit)) {
		throw new RuntimeSliceNotImplemented("assistant settlement(overflow)");
	}
	if (message.stopReason === "deferred") {
		const normalized = normalizeInvalidDeferredResponse(message, pending.context.configuration, requestApi);
		if (normalized.stopReason === "deferred" && normalized.deferred !== undefined) {
			return {
				message: normalized,
				phase: {
					kind: "deferred",
					deferred: {
						status: "suspended",
						stepId: pending.context.stepId,
						sourceEntryId: responseEntryId,
						poll: 0,
						configuration: cloneConfiguration(pending.context.configuration),
						streamOptions: { ...pending.context.streamOptions },
					},
				},
				outcome: { kind: "deferred", handle: normalized.deferred },
			};
		}
		const errorMessage = normalized.errorMessage ?? "Invalid deferred response handle for the captured model";
		const error = { code: "assistant_error", message: errorMessage };
		return {
			message: normalized,
			phase: { kind: "failure_drain", error, provenance: { kind: "response", entryId: responseEntryId } },
			outcome: { kind: "failed", error },
		};
	}
	if (message.stopReason === "error") {
		const errorMessage = message.errorMessage ?? "Assistant request failed";
		if (pending.attempt < pending.context.retryPolicy.maxAttempts && isRetryableAssistantError(message)) {
			const delayMs = calculateRetryDelay(pending.context.retryPolicy.baseDelayMs, pending.attempt);
			const notBefore = saturatingAdd(now, delayMs);
			return {
				message,
				phase: {
					kind: "assistant",
					generation: {
						status: "retry_wait",
						context: pending.context,
						nextAttempt: pending.attempt + 1,
						notBefore,
						errorMessage,
					},
				},
				outcome: { kind: "retry", nextAttempt: pending.attempt + 1, delayMs, notBefore, errorMessage },
			};
		}
		const error = { code: "assistant_error", message: errorMessage };
		return {
			message,
			phase: { kind: "failure_drain", error, provenance: { kind: "response", entryId: responseEntryId } },
			outcome: { kind: "failed", error },
		};
	}
	if (message.stopReason === "toolUse" || sourceCalls.length !== 0) {
		if (sourceCalls.length === 0) {
			throw new SessionInvariantError("Assistant tool-use response contains no tool calls");
		}
		if (sourceCalls.length !== resultEntryIds.length) {
			throw new SessionInvariantError("Assistant tool plan reservation is incomplete");
		}
		return {
			message,
			phase: {
				kind: "tools",
				batch: {
					assistantEntryId: responseEntryId,
					configuration: cloneConfiguration(pending.context.configuration),
					turnId: pending.context.stepId,
					calls: sourceCalls.map((_call, sourceIndex) => ({
						status: "planned",
						sourceIndex,
						resultEntryId: resultEntryIds[sourceIndex]!,
					})),
				},
			},
			outcome: { kind: "tools", genuineLength: message.stopReason === "length" },
		};
	}
	return {
		message,
		phase: {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: true },
			triggerEntryId: responseEntryId,
		},
		outcome: { kind: "completed" },
	};
}

export function normalizeInvalidDeferredResponse(
	message: SettledAssistantMessage,
	configuration: LaneConfiguration,
	requestApi: Api,
): SettledAssistantMessage {
	if (message.stopReason !== "deferred") return message;
	const handle = message.deferred;
	if (
		handle !== undefined &&
		handle.id.length !== 0 &&
		handle.provider === configuration.model.provider &&
		handle.modelId === configuration.model.modelId &&
		handle.api === requestApi
	) {
		return message;
	}
	const { deferred: _invalidHandle, ...rest } = message;
	return {
		...rest,
		stopReason: "error",
		errorMessage: "Invalid deferred response handle for the captured model",
	};
}

export function predictAssistantStepOutcome(
	message: SettledAssistantMessage,
	attempt: number,
	context: Extract<RunState["phase"], { kind: "assistant" }>["generation"]["context"],
	requestApi: Api,
): "succeeded" | "retry" | "failed" | "aborted" | "deferred" {
	if (message.stopReason === "deferred") {
		return normalizeInvalidDeferredResponse(message, context.configuration, requestApi).stopReason === "deferred"
			? "deferred"
			: "failed";
	}
	if (message.stopReason === "aborted") return "aborted";
	if (message.stopReason === "error") {
		return attempt < context.retryPolicy.maxAttempts && isRetryableAssistantError(message) ? "retry" : "failed";
	}
	if (
		message.stopReason === "stop" ||
		message.stopReason === "length" ||
		message.stopReason === "toolUse" ||
		message.content.some((block) => block.type === "toolCall")
	) {
		return "succeeded";
	}
	return "failed";
}

export function calculateRetryDelay(baseDelayMs: number, failedAttempt: number): number {
	if (baseDelayMs === 0) return 0;
	const exponent = failedAttempt - 1;
	if (exponent >= 53) return Number.MAX_SAFE_INTEGER;
	const multiplier = 2 ** exponent;
	return baseDelayMs > Number.MAX_SAFE_INTEGER / multiplier ? Number.MAX_SAFE_INTEGER : baseDelayMs * multiplier;
}

export function saturatingAdd(left: number, right: number): number {
	return left >= Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

export function suspensionBase(restored: RestoredLane): Omit<SuspendedOperation, "reason" | "deferred" | "missing"> {
	const current = restored.current;
	if (current === undefined) throw new SessionInvariantError(`Lane ${restored.lane} is not suspended`);
	return {
		lane: restored.lane,
		operationId: current.operation.operationId,
		kind: current.operation.intent.kind,
		startedAt: current.operation.startedAt,
		...(current.operation.intent.kind !== "run"
			? {}
			: {
					prompt: current.operation.intent.promptEntryIds.map((id) => {
						const entry = current.entries.get(id);
						if (entry?.type !== "message") throw new SessionInvariantError(`Prompt entry ${id} is missing`);
						return entry.message;
					}),
				}),
	};
}

export function missingIdentities<TContext extends object | undefined>(
	models: Models,
	configuration: LaneConfiguration,
	settings: RuntimeSettings<TContext>,
): { tools: string[]; models: string[] } {
	const model = models.getModel(configuration.model.provider, configuration.model.modelId);
	const availableTools = new Set(settings.tools.map((tool) => tool.name));
	return {
		tools: configuration.activeToolNames.filter((name) => !availableTools.has(name)),
		models: model === undefined ? [`${configuration.model.provider}/${configuration.model.modelId}`] : [],
	};
}

export function missingToolIdentities<TContext extends object | undefined>(
	configuration: LaneConfiguration,
	settings: RuntimeSettings<TContext>,
): string[] {
	const availableTools = new Set(settings.tools.map((tool) => tool.name));
	return configuration.activeToolNames.filter((name) => !availableTools.has(name));
}

export function cloneUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

export function cloneConfiguration(configuration: LaneConfiguration): LaneConfiguration {
	return { ...configuration, model: { ...configuration.model }, activeToolNames: [...configuration.activeToolNames] };
}

export function deadlineReached(options: DriveOptions): boolean {
	return options.deadline !== undefined && Date.now() >= options.deadline;
}

export function normalizeRetryPolicy(policy: RetryPolicy): { maxAttempts: number; baseDelayMs: number } {
	return { maxAttempts: policy.enabled ? policy.maxRetries + 1 : 1, baseDelayMs: policy.baseDelayMs };
}

export function isPendingAssistant(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "pending";
}

export async function hydrateTerminalOutcome(
	reader: Pick<SessionMutator, "getEntries">,
	lastResult: LaneLastResult,
): Promise<TerminalOperationOutcome> {
	const referencedIds = [
		...(lastResult.leafId === null ? [] : [lastResult.leafId]),
		...(lastResult.kind === "run" && lastResult.finalAssistantEntryId !== undefined
			? [lastResult.finalAssistantEntryId]
			: []),
		...(lastResult.kind === "navigation" &&
		lastResult.outcome === "completed" &&
		lastResult.summaryEntryId !== undefined
			? [lastResult.summaryEntryId]
			: []),
	];
	const entries = await reader.getEntries([...new Set(referencedIds)]);
	if (lastResult.leafId !== null && !entries.has(lastResult.leafId)) {
		throw new SessionInvariantError(`Terminal leaf ${lastResult.leafId} is missing`);
	}
	if (lastResult.kind === "run") {
		const final =
			lastResult.finalAssistantEntryId === undefined ? undefined : entries.get(lastResult.finalAssistantEntryId);
		if (lastResult.finalAssistantEntryId !== undefined && final === undefined) {
			throw new SessionInvariantError(`Final assistant ${lastResult.finalAssistantEntryId} is missing`);
		}
		if (final !== undefined && (final.type !== "message" || final.message.role !== "assistant")) {
			throw new SessionInvariantError(`Final assistant ${lastResult.finalAssistantEntryId} is invalid`);
		}
		const finalMessage = final?.message as AssistantMessage | undefined;
		if (lastResult.outcome === "completed" && lastResult.runCompletion === "assistant") {
			if (final === undefined || finalMessage === undefined) {
				throw new SessionInvariantError("Completed assistant run has no final assistant");
			}
			if (lastResult.finalAssistantEntryId !== lastResult.leafId) {
				throw new SessionInvariantError("Completed assistant run final entry is not its leaf");
			}
			if (finalMessage.stopReason !== "stop" && finalMessage.stopReason !== "length") {
				throw new SessionInvariantError("Completed assistant run has an invalid stop reason");
			}
		}
		const finalFields =
			final === undefined || finalMessage === undefined ? {} : { finalEntryId: final.id, finalMessage };
		if (lastResult.outcome === "failed") {
			return {
				operation: "run",
				runId: lastResult.operationId,
				kind: "failed",
				leafId: lastResult.leafId,
				error: lastResult.error,
				...finalFields,
			};
		}
		return {
			operation: "run",
			runId: lastResult.operationId,
			kind: lastResult.outcome,
			leafId: lastResult.leafId,
			...finalFields,
		};
	}
	if (lastResult.kind === "compaction") {
		if (lastResult.outcome === "completed") {
			const entry = entries.get(lastResult.leafId);
			if (entry?.type !== "compaction") throw new SessionInvariantError("Completed compaction leaf is invalid");
			return {
				operation: "compaction",
				runId: lastResult.operationId,
				kind: "completed",
				leafId: lastResult.leafId,
				entry,
			};
		}
		if (lastResult.outcome === "failed") {
			return {
				operation: "compaction",
				runId: lastResult.operationId,
				kind: "failed",
				leafId: lastResult.leafId,
				error: lastResult.error,
			};
		}
		return {
			operation: "compaction",
			runId: lastResult.operationId,
			kind: lastResult.outcome,
			leafId: lastResult.leafId,
		};
	}
	if (lastResult.outcome === "completed") {
		const summary = lastResult.summaryEntryId === undefined ? undefined : entries.get(lastResult.summaryEntryId);
		if (lastResult.summaryEntryId !== undefined && summary === undefined) {
			throw new SessionInvariantError(`Navigation summary ${lastResult.summaryEntryId} is missing`);
		}
		if (summary !== undefined && summary.type !== "branch_summary") {
			throw new SessionInvariantError(`Navigation summary ${lastResult.summaryEntryId} is invalid`);
		}
		return {
			operation: "navigation",
			runId: lastResult.operationId,
			kind: "completed",
			oldLeafId: lastResult.oldLeafId,
			newLeafId: lastResult.leafId,
			...(summary === undefined ? {} : { summaryEntry: summary }),
		};
	}
	if (lastResult.outcome === "failed") {
		return {
			operation: "navigation",
			runId: lastResult.operationId,
			kind: "failed",
			leafId: lastResult.leafId,
			error: lastResult.error,
		};
	}
	return {
		operation: "navigation",
		runId: lastResult.operationId,
		kind: lastResult.outcome,
		leafId: lastResult.leafId,
	};
}
