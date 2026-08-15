import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@draht/ai";
import { createAssistantMessageEventStream } from "@draht/ai";
import type { TelemetryContext } from "@draht/telemetry";
import type { AgentTool, AgentToolCall } from "../../types.ts";
import {
	type DriveOptions,
	type DriveResult,
	HarnessClosed,
	HarnessFault,
	type SuspendedOperation,
} from "../agent-harness.ts";
import { streamHarnessAssistant } from "../execution/assistant.ts";
import { applyStreamOptionsPatch } from "../hooks.ts";
import { type RestoredLane, restoreLane } from "../restore.ts";
import { Result } from "../result.ts";
import { materializeCommittedEntry } from "../session/commit.ts";
import { buildSessionContext } from "../session/context.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { OperationError, RunState, SettledAssistantMessage } from "../session/types.ts";
import { startHarnessSpan } from "../telemetry.ts";
import { loadExpected } from "./run-mutation.ts";
import { executeOrdinaryToolBatch } from "./tool-batch-procedure.ts";
import {
	classifyAssistantSettlement,
	cloneConfiguration,
	cloneUsage,
	deadlineReached,
	missingIdentities,
	normalizeInvalidDeferredResponse,
	normalizeRetryPolicy,
	predictAssistantStepOutcome,
	suspensionBase,
	uuidV7Timestamp,
} from "./transitions.ts";
import {
	type ActiveOperation,
	type AssistantExecutionResult,
	type CommittedAssistantSettlement,
	type RuntimeLane,
	type RuntimeProcedureContext,
	RuntimeSliceNotImplemented,
	type ToolBatchExecutionResult,
	ZERO_USAGE,
} from "./types.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export async function recoverAssistantAtActivation<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	runState: RunState,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
): Promise<ToolBatchExecutionResult> {
	const phase = runState.phase;
	if (phase.kind !== "assistant" || phase.generation.status !== "effect_pending") {
		throw new SessionInvariantError("Assistant recovery is not at an orphaned request");
	}
	const pending = phase.generation;
	const context = pending.context;
	if (pending.attempt < context.retryPolicy.maxAttempts) {
		await lane.breakpoint.hit({
			kind: "assistant.recover_retry",
			description: "Recover an uncertain assistant request with a later attempt",
			details: {
				operationId: active.operationId,
				stepId: context.stepId,
				attempt: pending.attempt,
				nextAttempt: pending.attempt + 1,
			},
		});
		if (deadlineReached(options)) return { kind: "yielded" };
		try {
			runtime.assertOpen();
			await runtime.sessionStorage.mutate(lane.name, async (mutator) => {
				const latest = await restoreLane(mutator, lane.name);
				const state = latest.current?.state;
				if (
					latest.current?.operation.operationId !== active.operationId ||
					state?.kind !== "run" ||
					state.control.status !== "running" ||
					state.phase.kind !== "assistant" ||
					state.phase.generation.status !== "effect_pending" ||
					state.phase.generation.context.stepId !== context.stepId ||
					state.phase.generation.attempt !== pending.attempt ||
					state.phase.generation.responseEntryId !== pending.responseEntryId ||
					state.phase.generation.usageId !== pending.usageId
				) {
					throw new SessionInvariantError("Assistant recovery found another restart point");
				}
				await mutator.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: active.operationId,
							value: {
								...state,
								phase: {
									kind: "assistant",
									generation: { status: "ready", context, nextAttempt: pending.attempt + 1 },
								},
							},
						},
					],
				});
			});
		} catch (error) {
			if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
			throw runtime.fault(error);
		}
		return { kind: "advanced" };
	}

	const resolvedModel = runtime.models.getModel(
		context.configuration.model.provider,
		context.configuration.model.modelId,
	);
	const error: OperationError = {
		code: "assistant_error",
		message: `Assistant request outcome is unknown after interruption at attempt ${pending.attempt}`,
	};
	const message: SettledAssistantMessage = {
		role: "assistant",
		content: [],
		api: resolvedModel?.api ?? "unknown",
		provider: context.configuration.model.provider,
		model: context.configuration.model.modelId,
		usage: cloneUsage(ZERO_USAGE),
		stopReason: "error",
		errorMessage: error.message,
		timestamp: Date.now(),
	};
	await runtime.events.emit({
		type: "turn_start",
		runId: active.operationId,
		turnId: context.stepId,
		lane: lane.name,
		recovery: true,
	});
	await runtime.events.emit({
		type: "message_start",
		runId: active.operationId,
		message,
		lane: lane.name,
		recovery: true,
	});
	await runtime.events.emit({
		type: "message_end",
		runId: active.operationId,
		message,
		entryId: pending.responseEntryId,
		lane: lane.name,
		recovery: true,
	});
	await lane.breakpoint.hit({
		kind: "assistant.recover_settlement",
		description: "Settle an uncertain final assistant request",
		details: { operationId: active.operationId, stepId: context.stepId, attempt: pending.attempt },
	});
	if (deadlineReached(options)) return { kind: "yielded" };
	const committed = await startHarnessSpan(
		runTelemetry,
		"pi.harness.turn",
		{
			"pi.lane.name": lane.name,
			"pi.operation.id": active.operationId,
			"pi.turn.id": context.stepId,
		},
		(turnSpan) =>
			startHarnessSpan(
				turnSpan,
				"pi.harness.step",
				{
					"pi.lane.name": lane.name,
					"pi.operation.id": active.operationId,
					"pi.step.kind": "assistant",
					"pi.step.attempt": pending.attempt,
				},
				async (stepSpan) => {
					stepSpan.setAttributes({ "pi.step.outcome": "failed" });
					stepSpan.setStatus({ status: "error" });
					return commitSyntheticAssistantRecovery(runtime, lane.name, active.operationId, pending, message, error);
				},
			),
	);
	await runtime.events.emit({ type: "entry_added", entry: committed.entry, lane: lane.name });
	await runtime.events.emit({ type: "usage", lane: lane.name, row: committed.row, totals: committed.totals });
	await runtime.events.emit({
		type: "turn_end",
		runId: active.operationId,
		turnId: context.stepId,
		message,
		toolResults: [],
		lane: lane.name,
		recovery: true,
	});
	if (pending.attempt > 1) {
		await runtime.events.emit({
			type: "retry_end",
			runId: active.operationId,
			step: context.stepId,
			attempt: pending.attempt,
			success: false,
			finalError: error.message,
			lane: lane.name,
			recovery: true,
		});
	}
	return { kind: "advanced" };
}

async function commitSyntheticAssistantRecovery<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: string,
	operationId: string,
	pending: Extract<RunState["phase"], { kind: "assistant" }>["generation"] & { status: "effect_pending" },
	message: SettledAssistantMessage,
	error: OperationError,
): Promise<Pick<CommittedAssistantSettlement, "entry" | "row" | "totals">> {
	try {
		runtime.assertOpen();
		const committed = await runtime.sessionStorage.mutate(lane, async (mutator) => {
			const restored = await restoreLane(mutator, lane);
			const state = restored.current?.state;
			if (
				restored.current?.operation.operationId !== operationId ||
				state?.kind !== "run" ||
				state.control.status !== "running" ||
				state.phase.kind !== "assistant" ||
				state.phase.generation.status !== "effect_pending" ||
				state.phase.generation.context.stepId !== pending.context.stepId ||
				state.phase.generation.attempt !== pending.attempt ||
				state.phase.generation.responseEntryId !== pending.responseEntryId ||
				state.phase.generation.usageId !== pending.usageId
			) {
				throw new SessionInvariantError("Synthetic assistant recovery found another restart point");
			}
			const responseEntry = {
				id: pending.responseEntryId,
				parentId: restored.leafId,
				type: "message" as const,
				message,
			};
			const result = await mutator.commit({
				writes: [
					{ kind: "entry", entry: responseEntry },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: pending.responseEntryId },
					{
						kind: "usage",
						row: {
							id: pending.usageId,
							usage: message.usage,
							entryId: pending.responseEntryId,
							adjustment: false,
						},
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...state,
							latestAssistantEntryId: pending.responseEntryId,
							phase: {
								kind: "failure_drain",
								error,
								provenance: { kind: "response", entryId: pending.responseEntryId },
							},
						},
					},
				],
			});
			return {
				entry: materializeCommittedEntry(responseEntry, result.seqs[0]!, result.timestamp),
				row: {
					id: pending.usageId,
					seq: result.seqs[2]!,
					usage: message.usage,
					entryId: pending.responseEntryId,
					adjustment: false as const,
				},
			};
		});
		return { ...committed, totals: (await runtime.sessionStorage.getStats()).usage };
	} catch (caught) {
		if (caught instanceof HarnessClosed || caught instanceof HarnessFault) throw caught;
		throw runtime.fault(caught);
	}
}

export async function driveAssistantRetryWait<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	state: RunState,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
): Promise<"advanced" | DriveResult> {
	if (state.phase.kind !== "assistant" || state.phase.generation.status !== "retry_wait") {
		throw new SessionInvariantError("Assistant retry wait is not current");
	}
	const wait = state.phase.generation;
	const now = Date.now();
	const alreadyDue = now >= wait.notBefore;
	let timerAdmitted = false;
	if (!alreadyDue) {
		if (options.waitForRetry !== true || (options.deadline !== undefined && options.deadline < wait.notBefore)) {
			return Result.ok({
				kind: "waiting",
				operationId: active.operationId,
				reason: "retry",
				notBefore: wait.notBefore,
			});
		}
		await lane.breakpoint.hit({
			kind: "assistant.retry_wait",
			description: "Wait for an assistant retry",
			details: {
				operationId: active.operationId,
				stepId: wait.context.stepId,
				attempt: wait.nextAttempt,
				notBefore: wait.notBefore,
			},
		});
		if (options.deadline !== undefined && options.deadline < wait.notBefore) {
			return Result.ok({
				kind: "waiting",
				operationId: active.operationId,
				reason: "retry",
				notBefore: wait.notBefore,
			});
		}
		if (deadlineReached(options)) {
			return Result.ok({ kind: "yielded", operationId: active.operationId });
		}
		timerAdmitted = await startHarnessSpan(
			runTelemetry,
			"pi.harness.sleep",
			{
				"pi.operation.id": active.operationId,
				"pi.sleep.delay_ms": Math.max(0, wait.notBefore - Date.now()),
			},
			async (sleepSpan) => {
				if (deadlineReached(options)) return false;
				try {
					active.effectGate.assertOpen();
					await waitUntil(wait.notBefore, active.effectGate.signal);
					sleepSpan.setAttributes({ "pi.sleep.outcome": "elapsed" });
					return true;
				} catch (error) {
					sleepSpan.setAttributes({ "pi.sleep.outcome": "aborted" });
					throw error;
				}
			},
		);
		if (!timerAdmitted) return Result.ok({ kind: "yielded", operationId: active.operationId });
	}
	if (!timerAdmitted && deadlineReached(options)) {
		return Result.ok({ kind: "yielded", operationId: active.operationId });
	}
	await lane.breakpoint.hit({
		kind: "assistant.retry_ready",
		description: "Make an assistant retry ready",
		details: {
			operationId: active.operationId,
			stepId: wait.context.stepId,
			attempt: wait.nextAttempt,
		},
	});
	if (!timerAdmitted && deadlineReached(options)) {
		return Result.ok({ kind: "yielded", operationId: active.operationId });
	}
	try {
		runtime.assertOpen();
		await runtime.sessionStorage.mutate(lane.name, async (mutator) => {
			const restored = await restoreLane(mutator, lane.name);
			const latest = restored.current?.state;
			if (
				restored.current?.operation.operationId !== active.operationId ||
				latest?.kind !== "run" ||
				latest.control.status !== "running" ||
				latest.phase.kind !== "assistant" ||
				latest.phase.generation.status !== "retry_wait" ||
				latest.phase.generation.context.stepId !== wait.context.stepId ||
				latest.phase.generation.nextAttempt !== wait.nextAttempt ||
				latest.phase.generation.notBefore !== wait.notBefore ||
				latest.phase.generation.errorMessage !== wait.errorMessage
			) {
				throw new SessionInvariantError("Assistant retry found another wait");
			}
			await mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: active.operationId,
						value: {
							...latest,
							phase: {
								kind: "assistant",
								generation: {
									status: "ready",
									context: wait.context,
									nextAttempt: wait.nextAttempt,
								},
							},
						},
					},
				],
			});
		});
	} catch (error) {
		if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
		throw runtime.fault(error);
	}
	return "advanced";
}

export async function waitForDeferred<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	state: RunState,
	recovery: boolean,
): Promise<DriveResult> {
	if (state.phase.kind !== "deferred" || state.phase.deferred.status !== "suspended") {
		throw new SessionInvariantError("Deferred response is not suspended");
	}
	const source = restored.current?.entries.get(state.phase.deferred.sourceEntryId);
	if (source?.type !== "message" || source.message.role !== "assistant" || source.message.deferred === undefined) {
		throw new SessionInvariantError("Deferred source response is invalid");
	}
	const descriptor: SuspendedOperation = {
		...suspensionBase(restored),
		reason: "deferred",
		deferred: source.message.deferred,
	};
	runtime.restoredSuspensions.set(lane.name, descriptor);
	await runtime.events.emit({
		type: "run_suspend",
		runId: active.operationId,
		reason: "deferred",
		deferred: source.message.deferred,
		lane: lane.name,
		...(recovery ? { recovery: true as const } : {}),
	});
	return Result.ok({
		kind: "waiting",
		operationId: active.operationId,
		reason: "deferred",
		deferred: source.message.deferred,
	});
}

export async function startGeneration<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	state: RunState,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
): Promise<boolean> {
	if (state.phase.kind !== "checkpoint" || state.phase.continuation.kind !== "need_assistant") {
		throw new SessionInvariantError("Generation start is not at a need-assistant checkpoint");
	}
	const expectedTriggerEntryId = state.phase.triggerEntryId;
	const settings = await runtime.snapshotSettings();
	await lane.breakpoint.hit({
		kind: "run.generation_ready",
		description: "Prepare an assistant generation",
		details: { operationId: active.operationId },
	});
	if (deadlineReached(options)) return false;
	const stepId = runtime.sessionStorage.idGenerator.next();
	await startHarnessSpan(
		runTelemetry,
		"pi.harness.checkpoint",
		{
			"pi.lane.name": lane.name,
			"pi.operation.id": active.operationId,
			"pi.checkpoint.kind": "normal",
		},
		async () => {
			try {
				runtime.assertOpen();
				await runtime.sessionStorage.mutate(lane.name, async (mutator) => {
					const restored = await restoreLane(mutator, lane.name);
					const current = restored.current;
					if (
						current === undefined ||
						current.operation.operationId !== active.operationId ||
						current.state.kind !== "run"
					) {
						throw new SessionInvariantError("Generation start lost run ownership");
					}
					const latest = current.state;
					if (
						latest.phase.kind !== "checkpoint" ||
						latest.phase.continuation.kind !== "need_assistant" ||
						latest.phase.triggerEntryId !== expectedTriggerEntryId ||
						latest.control.status !== "running"
					) {
						throw new SessionInvariantError("Generation start found another run phase");
					}
					const context = {
						stepId,
						triggerEntryId: latest.phase.triggerEntryId,
						configuration: cloneConfiguration(restored.configuration),
						streamOptions: { ...settings.streamOptions },
						retryPolicy: normalizeRetryPolicy(settings.retryPolicy),
						overflowRecoveryUsed: latest.phase.continuation.overflowRecoveryUsed,
					};
					await mutator.commit({
						writes: [
							{
								kind: "register",
								op: "set",
								namespace: "op.state",
								key: active.operationId,
								value: {
									...latest,
									phase: { kind: "assistant", generation: { status: "ready", context, nextAttempt: 1 } },
								},
							},
						],
					});
				});
			} catch (error) {
				if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
				throw runtime.fault(error);
			}
		},
	);
	return true;
}

export async function executeAssistantGeneration<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	state: RunState,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
	recovery: boolean,
): Promise<AssistantExecutionResult> {
	if (state.phase.kind !== "assistant" || state.phase.generation.status !== "ready") {
		throw new SessionInvariantError("Assistant generation is not ready");
	}
	const ready = state.phase.generation;
	const context = ready.context;
	const settings = await runtime.snapshotSettings();
	const missing = missingIdentities(runtime.models, context.configuration, settings);
	if (missing.tools.length !== 0 || missing.models.length !== 0) {
		const descriptor: SuspendedOperation = {
			...suspensionBase(restored),
			reason: "missing_identities",
			missing,
		};
		runtime.restoredSuspensions.set(lane.name, descriptor);
		await runtime.events.emit({
			type: "run_suspend",
			runId: active.operationId,
			reason: "missing_identities",
			missing,
			lane: lane.name,
			...(recovery ? { recovery: true as const } : {}),
		});
		return { kind: "missing_identities", missing };
	}
	runtime.restoredSuspensions.delete(lane.name);
	const model = runtime.models.getModel(context.configuration.model.provider, context.configuration.model.modelId);
	const providerRegistration = runtime.models.getProvider(context.configuration.model.provider);
	if (model === undefined || providerRegistration === undefined) {
		throw new SessionInvariantError("Assistant model disappeared during identity preflight");
	}

	let streamOptions = { ...context.streamOptions };
	if (runtime.hooks.has("before_request")) {
		await lane.breakpoint.hit({
			kind: "hook.before_request",
			description: "Transform assistant request options",
			details: { operationId: active.operationId, attempt: ready.nextAttempt },
		});
		if (deadlineReached(options)) return { kind: "yielded" };
		const result = await runtime.hooks.runWithGate(
			"before_request",
			{
				lane: lane.name,
				runId: active.operationId,
				model,
				step: "assistant",
				attempt: ready.nextAttempt,
				streamOptions,
			},
			active.effectGate,
		);
		if (result?.streamOptions !== undefined) {
			streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
		}
		if (deadlineReached(options)) return { kind: "yielded" };
	}
	const operation = restored.current?.operation;
	if (operation?.intent.kind !== "run")
		throw new SessionInvariantError("Assistant generation is missing run metadata");
	const systemPrompt = operation.intent.systemPromptOverride ?? (await resolveSystemPrompt(runtime));
	const responseEntryId = runtime.sessionStorage.idGenerator.next();
	const usageId = runtime.sessionStorage.idGenerator.next();
	await lane.breakpoint.hit({
		kind: "assistant.intent",
		description: "Commit assistant request intent",
		details: { operationId: active.operationId, stepId: context.stepId, attempt: ready.nextAttempt },
	});
	if (deadlineReached(options)) return { kind: "yielded" };
	try {
		runtime.assertOpen();
		await runtime.sessionStorage.mutate(lane.name, async (mutator) => {
			const latest = await restoreLane(mutator, lane.name);
			const current = latest.current;
			if (
				current === undefined ||
				current.operation.operationId !== active.operationId ||
				current.state.kind !== "run"
			) {
				throw new SessionInvariantError("Assistant intent lost run ownership");
			}
			const phase = current.state.phase;
			if (
				phase.kind !== "assistant" ||
				phase.generation.status !== "ready" ||
				phase.generation.context.stepId !== context.stepId ||
				phase.generation.nextAttempt !== ready.nextAttempt
			) {
				throw new SessionInvariantError("Assistant intent found another restart point");
			}
			await mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: active.operationId,
						value: {
							...current.state,
							phase: {
								kind: "assistant",
								generation: {
									status: "effect_pending",
									context,
									attempt: ready.nextAttempt,
									responseEntryId,
									usageId,
									intendedOutputLimit: model.maxTokens,
									contextWindow: model.contextWindow,
								},
							},
						},
					},
				],
			});
		});
	} catch (error) {
		if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
		throw runtime.fault(error);
	}
	if (ready.nextAttempt > 1) {
		await runtime.events.emit({
			type: "retry_start",
			runId: active.operationId,
			step: context.stepId,
			attempt: ready.nextAttempt,
			lane: lane.name,
			...(recovery ? { recovery: true as const } : {}),
		});
	}

	const newestFirst = await lane.sessionTree.findEntriesOnBranch({ order: "newestFirst", stopAtType: "compaction" });
	const messages = await buildSessionContext([...newestFirst].reverse(), { entryProjectors: runtime.entryProjectors });
	await runtime.events.emit({
		type: "turn_start",
		runId: active.operationId,
		turnId: context.stepId,
		lane: lane.name,
		...(recovery ? { recovery: true as const } : {}),
	});
	const providerTools = context.configuration.activeToolNames.map(
		(name) => settings.tools.find((tool) => tool.name === name)! as unknown as AgentTool,
	);
	return startHarnessSpan(
		runTelemetry,
		"pi.harness.turn",
		{
			"pi.lane.name": lane.name,
			"pi.operation.id": active.operationId,
			"pi.turn.id": context.stepId,
		},
		async (turnSpan) => {
			const message = await startHarnessSpan(
				turnSpan,
				"pi.harness.step",
				{
					"pi.lane.name": lane.name,
					"pi.operation.id": active.operationId,
					"pi.step.kind": "assistant",
					"pi.step.attempt": ready.nextAttempt,
				},
				async (stepSpan) => {
					const settled = await streamHarnessAssistant(messages, {
						model,
						...(systemPrompt === undefined ? {} : { systemPrompt }),
						...(providerTools.length === 0 ? {} : { tools: providerTools }),
						thinkingLevel: context.configuration.thinkingLevel,
						streamOptions,
						transformContext: runtime.hooks.has("transform_context")
							? async (input) => {
									await lane.breakpoint.hit({
										kind: "hook.transform_context",
										description: "Transform assistant context",
										details: { operationId: active.operationId, stepId: context.stepId },
									});
									const result = await runtime.hooks.runWithGate(
										"transform_context",
										{ lane: lane.name, runId: active.operationId, messages: input },
										active.effectGate,
									);
									return result?.messages ?? input;
								}
							: undefined,
						toProviderMessages: runtime.toProviderMessages,
						beforePayload: runtime.hooks.has("before_payload")
							? async (payload, requestModel) => {
									await lane.breakpoint.hit({
										kind: "hook.before_payload",
										description: "Transform provider payload",
										details: { operationId: active.operationId, stepId: context.stepId },
									});
									return (
										await runtime.hooks.runWithGate(
											"before_payload",
											{ lane: lane.name, runId: active.operationId, model: requestModel, payload },
											active.effectGate,
										)
									)?.payload;
								}
							: undefined,
						afterResponse: async (settledMessage, metadata) => {
							let transformed = settledMessage;
							if (runtime.hooks.has("after_response")) {
								await lane.breakpoint.hit({
									kind: "hook.after_response",
									description: "Transform assistant response",
									details: { operationId: active.operationId, stepId: context.stepId },
								});
								const result = await runtime.hooks.runWithGate(
									"after_response",
									{
										lane: lane.name,
										runId: active.operationId,
										...metadata,
										message: transformed,
									},
									active.effectGate,
								);
								transformed = result?.message ?? transformed;
							}
							return normalizeInvalidDeferredResponse(transformed, context.configuration, model.api);
						},

						request: async (
							providerContext: Context,
							providerOptions: SimpleStreamOptions,
						): Promise<AssistantMessageEventStream> => {
							await lane.breakpoint.hit({
								kind: "assistant.request",
								description: "Request assistant response",
								details: {
									operationId: active.operationId,
									stepId: context.stepId,
									attempt: ready.nextAttempt,
								},
							});
							const requestModel = runtime.models.getModel(
								context.configuration.model.provider,
								context.configuration.model.modelId,
							);
							const requestProvider = runtime.models.getProvider(context.configuration.model.provider);
							if (requestModel !== model || requestProvider !== providerRegistration) {
								active.effectGate.assertOpen();
								return createMissingModelStream(model);
							}
							active.effectGate.assertOpen();
							return runtime.models.streamSimple(requestModel, providerContext, providerOptions);
						},
						observer: {
							start: (draft) =>
								runtime.events.emit({
									type: "message_start",
									runId: active.operationId,
									message: draft,
									lane: lane.name,
									...(recovery ? { recovery: true as const } : {}),
								}),
							update: (draft, event) =>
								runtime.events.emit({
									type: "message_update",
									runId: active.operationId,
									message: draft,
									event,
									lane: lane.name,
									...(recovery ? { recovery: true as const } : {}),
								}),
							end: (finalMessage) =>
								runtime.events.emit({
									type: "message_end",
									runId: active.operationId,
									message: finalMessage,
									entryId: responseEntryId,
									lane: lane.name,
									...(recovery ? { recovery: true as const } : {}),
								}),
						},
						telemetryContext: stepSpan,
						signal: active.effectGate.signal,
					});
					const outcome = predictAssistantStepOutcome(settled, ready.nextAttempt, context, model.api);
					stepSpan.setAttributes({ "pi.step.outcome": outcome });
					if (outcome === "retry" || outcome === "failed") stepSpan.setStatus({ status: "error" });
					return settled;
				},
			);
			if (message.role !== "assistant") {
				throw runtime.fault(new SessionInvariantError("after_response returned an invalid assistant message"));
			}
			runtime.assertOpen();
			await lane.breakpoint.hit({
				kind: "assistant.settlement",
				description: "Commit assistant response",
				details: { operationId: active.operationId, stepId: context.stepId, attempt: ready.nextAttempt },
			});
			const settled = await commitAssistantSettlement(
				runtime,
				lane.name,
				active.operationId,
				context.stepId,
				responseEntryId,
				usageId,
				model.api,
				message,
			);
			await runtime.events.emit({ type: "entry_added", entry: settled.entry, lane: lane.name });
			await runtime.events.emit({ type: "usage", lane: lane.name, row: settled.row, totals: settled.totals });
			if (settled.outcome.kind !== "tools") {
				await runtime.events.emit({
					type: "turn_end",
					runId: active.operationId,
					turnId: context.stepId,
					message: settled.message,
					toolResults: [],
					lane: lane.name,
					...(recovery ? { recovery: true as const } : {}),
				});
			}
			if (settled.outcome.kind === "retry") {
				await runtime.events.emit({
					type: "retry_scheduled",
					runId: active.operationId,
					step: context.stepId,
					attempt: settled.outcome.nextAttempt,
					maxAttempts: context.retryPolicy.maxAttempts,
					delayMs: settled.outcome.delayMs,
					errorMessage: settled.outcome.errorMessage,
					lane: lane.name,
					...(recovery ? { recovery: true as const } : {}),
				});
			} else if (ready.nextAttempt > 1) {
				const success =
					settled.outcome.kind === "completed" ||
					settled.outcome.kind === "deferred" ||
					settled.outcome.kind === "tools";
				await runtime.events.emit({
					type: "retry_end",
					runId: active.operationId,
					step: context.stepId,
					attempt: ready.nextAttempt,
					success,
					...(success || settled.outcome.kind !== "failed" ? {} : { finalError: settled.outcome.error.message }),
					lane: lane.name,
					...(recovery ? { recovery: true as const } : {}),
				});
			}
			if (settled.outcome.kind === "tools") {
				const toolState = await loadExpected(runtime, lane.name, active.operationId, false);
				const current = toolState.current;
				if (current?.state.kind !== "run" || current.state.phase.kind !== "tools") {
					throw runtime.fault(new SessionInvariantError("Assistant tool settlement lost its durable batch"));
				}
				return executeOrdinaryToolBatch(runtime, lane, active, toolState, current.state, turnSpan, options, {
					eventOrigin: recovery ? "recovery" : "live",
					turn: "already_started",
				});
			}
			return { kind: "advanced" };
		},
	);
}

async function commitAssistantSettlement<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: string,
	operationId: string,
	stepId: string,
	responseEntryId: string,
	usageId: string,
	requestApi: Api,
	message: SettledAssistantMessage,
): Promise<CommittedAssistantSettlement> {
	try {
		runtime.assertOpen();
		const sourceCalls = assistantToolCalls(message);
		const followerTimestamp = uuidV7Timestamp(responseEntryId);
		const resultEntryIds = sourceCalls.map(() => runtime.sessionStorage.idGenerator.next(followerTimestamp));
		const committed = await runtime.sessionStorage.mutate(lane, async (mutator) => {
			const restored = await restoreLane(mutator, lane);
			const current = restored.current;
			if (current === undefined || current.operation.operationId !== operationId || current.state.kind !== "run") {
				throw new SessionInvariantError("Assistant settlement lost run ownership");
			}
			const phase = current.state.phase;
			if (
				phase.kind !== "assistant" ||
				phase.generation.status !== "effect_pending" ||
				phase.generation.context.stepId !== stepId ||
				phase.generation.responseEntryId !== responseEntryId ||
				phase.generation.usageId !== usageId
			) {
				throw new SessionInvariantError("Assistant settlement found another pending request");
			}
			const decision = classifyAssistantSettlement(
				message,
				phase.generation,
				current.state.control.status,
				responseEntryId,
				requestApi,
				Date.now(),
				sourceCalls,
				resultEntryIds,
			);
			const responseEntry = {
				id: responseEntryId,
				parentId: restored.leafId,
				type: "message" as const,
				message: decision.message,
			};
			const result = await mutator.commit({
				writes: [
					{ kind: "entry", entry: responseEntry },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: responseEntryId },
					{
						kind: "usage",
						row: {
							id: usageId,
							usage: decision.message.usage,
							entryId: responseEntryId,
							adjustment: false,
						},
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...current.state,
							latestAssistantEntryId: responseEntryId,
							phase: decision.phase,
						},
					},
				],
			});
			return {
				entry: materializeCommittedEntry(responseEntry, result.seqs[0]!, result.timestamp),
				message: decision.message,
				outcome: decision.outcome,
				row: {
					id: usageId,
					seq: result.seqs[2]!,
					usage: decision.message.usage,
					entryId: responseEntryId,
					adjustment: false as const,
				},
			};
		});
		return { ...committed, totals: (await runtime.sessionStorage.getStats()).usage };
	} catch (error) {
		if (
			error instanceof RuntimeSliceNotImplemented ||
			error instanceof HarnessClosed ||
			error instanceof HarnessFault
		) {
			throw error;
		}
		throw runtime.fault(error);
	}
}

async function resolveSystemPrompt<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
): Promise<string | undefined> {
	const source = runtime.systemPromptSource;
	if (source === undefined || typeof source === "string") return source;
	const contextSource = runtime.toolContext;
	const context = typeof contextSource === "function" ? await contextSource() : contextSource;
	return source(context as TContext);
}

function assistantToolCalls(message: SettledAssistantMessage): AgentToolCall[] {
	return message.content.filter((block): block is AgentToolCall => block.type === "toolCall");
}

function waitUntil(notBefore: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason instanceof Error ? signal.reason : new Error("Retry wait was aborted"));
		};
		const schedule = () => {
			if (signal.aborted) {
				onAbort();
				return;
			}
			const remaining = notBefore - Date.now();
			if (remaining <= 0) {
				cleanup();
				resolve();
				return;
			}
			timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		schedule();
	});
}

function createMissingModelStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `Model is no longer available: ${model.provider}/${model.id}`,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}
