import type { TelemetryContext } from "@draht/telemetry";
import { type DriveOptions, type DriveResult, OperationMismatch } from "../agent-harness.ts";
import type { RestoredLane } from "../restore.ts";
import { Result } from "../result.ts";
import { SessionInvariantError } from "../session/session.ts";
import { startHarnessSpan } from "../telemetry.ts";
import {
	driveAssistantRetryWait,
	executeAssistantGeneration,
	recoverAssistantAtActivation,
	waitForDeferred,
} from "./assistant-procedure.ts";
import { driveCheckpoint, driveFailureDrain } from "./checkpoint-procedure.ts";
import { loadExpected } from "./run-mutation.ts";
import { executeOrdinaryToolBatch, recoverToolBatchAtActivation } from "./tool-batch-procedure.ts";
import { deadlineReached, hydrateTerminalOutcome } from "./transitions.ts";
import {
	type ActiveOperation,
	type RuntimeLane,
	type RuntimeProcedureContext,
	RuntimeSliceNotImplemented,
	type ToolBatchExecutionResult,
} from "./types.ts";

export async function executeDrivePass<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	options: DriveOptions,
): Promise<DriveResult> {
	const initial = await loadExpected(runtime, lane.name, active.operationId, false);
	if (initial.current === undefined) return settledOrMismatch(runtime, lane.name, active.operationId, initial);
	const resultAtDeadline = (): DriveResult => {
		const current = initial.current;
		const state = current?.state;
		if (
			state?.kind === "run" &&
			state.phase.kind === "assistant" &&
			state.phase.generation.status === "retry_wait" &&
			Date.now() < state.phase.generation.notBefore
		) {
			return Result.ok({
				kind: "waiting",
				operationId: active.operationId,
				reason: "retry",
				notBefore: state.phase.generation.notBefore,
			});
		}
		if (state?.kind === "run" && state.phase.kind === "deferred" && state.phase.deferred.status === "suspended") {
			const source = current?.entries.get(state.phase.deferred.sourceEntryId);
			if (
				source?.type !== "message" ||
				source.message.role !== "assistant" ||
				source.message.deferred === undefined
			) {
				throw new SessionInvariantError("Deferred suspension source is invalid");
			}
			return Result.ok({
				kind: "waiting",
				operationId: active.operationId,
				reason: "deferred",
				deferred: source.message.deferred,
			});
		}
		return Result.ok({ kind: "yielded", operationId: active.operationId });
	};
	if (deadlineReached(options)) return resultAtDeadline();

	await lane.breakpoint.hit({
		kind: "runtime.dispatch",
		description: "Advance durable operation",
		details: { operationId: active.operationId, operationKind: initial.current.state.kind },
	});
	if (deadlineReached(options)) return resultAtDeadline();
	if (initial.current.state.kind !== "run") {
		throw new RuntimeSliceNotImplemented(`drive(${initial.current.state.kind})`);
	}

	const recovery = !runtime.attachedOperationIds.has(active.operationId);
	const recoveryPreludeRequired =
		initial.current.state.kind === "run" &&
		((initial.current.state.phase.kind === "assistant" &&
			initial.current.state.phase.generation.status === "effect_pending") ||
			initial.current.state.phase.kind === "tools");
	const recoveryLifecycle =
		recovery && (!runtime.resumeEventOperationIds.has(active.operationId) || recoveryPreludeRequired);
	return startHarnessSpan(
		runtime.telemetryContext,
		"pi.harness.run",
		{
			"pi.session.id": runtime.sessionStorage.metadata.id,
			"pi.lane.name": lane.name,
			"pi.operation.id": active.operationId,
			"pi.operation.recovery": recoveryLifecycle,
			"pi.operation.kind": "run",
		},
		async (runSpan) => {
			const resultAtRunDeadline = (): DriveResult => {
				const result = resultAtDeadline();
				if (result.ok && result.value.kind === "waiting") {
					runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
				}
				return result;
			};
			if (recovery) {
				if (!runtime.resumedOperationIds.has(active.operationId)) {
					const resumed = await resumeRun(runtime, lane, active, initial, options);
					if (!resumed) return resultAtRunDeadline();
					runtime.resumedOperationIds.add(active.operationId);
				}
				if (deadlineReached(options)) {
					if (!recoveryPreludeRequired) {
						runtime.attachedOperationIds.add(active.operationId);
						runtime.restoredSuspensions.delete(lane.name);
					}
					return resultAtRunDeadline();
				}
				const recovered = await recoverRunAtActivation(runtime, lane, active, runSpan, options);
				if (recovered.kind === "yielded") {
					return Result.ok({ kind: "yielded", operationId: active.operationId });
				}
				if (recovered.kind === "missing_identities") {
					runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
					return Result.ok({
						kind: "waiting",
						operationId: active.operationId,
						reason: "missing_identities",
						missing: recovered.missing,
					});
				}
				runtime.attachedOperationIds.add(active.operationId);
				runtime.restoredSuspensions.delete(lane.name);
			}
			while (true) {
				const restored = await loadExpected(runtime, lane.name, active.operationId, true);
				if (restored.current === undefined) {
					const terminal = await settledOrMismatch(runtime, lane.name, active.operationId, restored);
					if (terminal.ok && terminal.value.kind === "settled" && terminal.value.outcome.operation === "run") {
						const outcome = terminal.value.outcome;
						runSpan.setAttributes({
							"pi.operation.outcome": outcome.kind,
							...(outcome.kind === "failed" ? { "pi.error.code": outcome.error.code } : {}),
						});
						if (outcome.kind === "failed") runSpan.setStatus({ status: "error" });
					}
					return terminal;
				}
				const state = restored.current.state;
				if (state.kind !== "run") throw new SessionInvariantError("Run operation changed state kind");
				if (state.control.status !== "running") {
					throw new RuntimeSliceNotImplemented("drive(cancel_requested)");
				}
				if (state.phase.kind === "assistant" && state.phase.generation.status === "retry_wait") {
					const retry = await driveAssistantRetryWait(runtime, lane, active, state, runSpan, options);
					if (retry !== "advanced") {
						if (retry.ok && retry.value.kind === "waiting") {
							runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
						}
						return retry;
					}
					continue;
				}
				if (state.phase.kind === "deferred") {
					if (state.phase.deferred.status !== "suspended") {
						throw new RuntimeSliceNotImplemented("drive(deferred.effect_pending)");
					}
					const waiting = await waitForDeferred(runtime, lane, active, restored, state, recoveryLifecycle);
					runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
					return waiting;
				}
				if (deadlineReached(options)) return Result.ok({ kind: "yielded", operationId: active.operationId });

				switch (state.phase.kind) {
					case "checkpoint": {
						const disposition = await driveCheckpoint(
							runtime,
							lane,
							active,
							state,
							runSpan,
							options,
							recoveryLifecycle,
						);
						if (disposition.kind === "advanced") continue;
						if (disposition.kind === "yielded") {
							return Result.ok({ kind: "yielded", operationId: active.operationId });
						}
						runSpan.setAttributes({ "pi.operation.outcome": "completed" });
						return Result.ok({
							kind: "settled",
							operationId: active.operationId,
							outcome: disposition.outcome,
						});
					}
					case "assistant": {
						if (state.phase.generation.status !== "ready") {
							throw new SessionInvariantError("Ordinary dispatch reached an unowned assistant effect");
						}
						const result = await executeAssistantGeneration(
							runtime,
							lane,
							active,
							restored,
							state,
							runSpan,
							options,
							recoveryLifecycle,
						);
						if (result.kind === "yielded") {
							return Result.ok({ kind: "yielded", operationId: active.operationId });
						}
						if (result.kind === "missing_identities") {
							runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
							return Result.ok({
								kind: "waiting",
								operationId: active.operationId,
								reason: "missing_identities",
								missing: result.missing,
							});
						}
						continue;
					}
					case "tools": {
						const result = await startHarnessSpan(
							runSpan,
							"pi.harness.turn",
							{
								"pi.lane.name": lane.name,
								"pi.operation.id": active.operationId,
								"pi.turn.id": state.phase.batch.turnId,
							},
							(turnSpan) =>
								executeOrdinaryToolBatch(runtime, lane, active, restored, state, turnSpan, options, {
									eventOrigin: recoveryLifecycle ? "recovery" : "live",
									turn: "not_started",
								}),
						);
						if (result.kind === "yielded") {
							return Result.ok({ kind: "yielded", operationId: active.operationId });
						}
						if (result.kind === "missing_identities") {
							runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
							return Result.ok({
								kind: "waiting",
								operationId: active.operationId,
								reason: "missing_identities",
								missing: result.missing,
							});
						}
						continue;
					}
					case "failure_drain": {
						const failure = state.phase.error;
						const disposition = await driveFailureDrain(
							runtime,
							lane,
							active,
							state,
							runSpan,
							options,
							recoveryLifecycle,
						);
						if (disposition.kind === "yielded") {
							return Result.ok({ kind: "yielded", operationId: active.operationId });
						}
						if (disposition.kind === "advanced") {
							throw new SessionInvariantError("R4 failure drain advanced unexpectedly");
						}
						runSpan.setAttributes({ "pi.operation.outcome": "failed", "pi.error.code": failure.code });
						runSpan.setStatus({ status: "error" });
						return Result.ok({
							kind: "settled",
							operationId: active.operationId,
							outcome: disposition.outcome,
						});
					}
					case "compaction":
						throw new RuntimeSliceNotImplemented("drive(run.compaction)");
				}
			}
		},
	);
}

async function resumeRun<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	options: DriveOptions,
): Promise<boolean> {
	const current = restored.current;
	if (current === undefined || current.operation.intent.kind !== "run") {
		throw new SessionInvariantError("Run resume is missing run metadata");
	}
	if (!runtime.resumeEventOperationIds.has(active.operationId)) {
		await runtime.events.emit({ type: "run_resume", runId: active.operationId, lane: lane.name, recovery: true });
		runtime.resumeEventOperationIds.add(active.operationId);
	}
	if (!runtime.hooks.has("before_resume")) return true;
	await lane.breakpoint.hit({
		kind: "hook.before_resume",
		description: "Run resume hooks",
		details: { operationId: active.operationId },
	});
	if (deadlineReached(options)) return false;
	const prompt = current.operation.intent.promptEntryIds.map((id) => {
		const entry = current.entries.get(id);
		if (entry?.type !== "message") throw new SessionInvariantError(`Prompt entry ${id} is missing`);
		return entry.message;
	});
	await runtime.hooks.runBeforeResumeWithGate(
		{
			kind: "run",
			lane: lane.name,
			runId: active.operationId,
			prompt,
			...(current.operation.intent.systemPromptOverride === undefined
				? {}
				: { systemPromptOverride: current.operation.intent.systemPromptOverride }),
		},
		current.operation.intent.resumeData ?? {},
		active.effectGate,
	);
	return true;
}

async function recoverRunAtActivation<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
): Promise<ToolBatchExecutionResult> {
	const restored = await loadExpected(runtime, lane.name, active.operationId, true);
	const current = restored.current;
	if (current === undefined || current.state.kind !== "run") return { kind: "advanced" };
	const runState = current.state;
	if (runState.control.status !== "running") return { kind: "advanced" };

	switch (runState.phase.kind) {
		case "tools":
			return startHarnessSpan(
				runTelemetry,
				"pi.harness.turn",
				{
					"pi.lane.name": lane.name,
					"pi.operation.id": active.operationId,
					"pi.turn.id": runState.phase.batch.turnId,
				},
				(turnSpan) => recoverToolBatchAtActivation(runtime, lane, active, restored, runState, turnSpan, options),
			);
		case "assistant":
			if (runState.phase.generation.status !== "effect_pending") return { kind: "advanced" };
			return recoverAssistantAtActivation(runtime, lane, active, runState, runTelemetry, options);
		default:
			return { kind: "advanced" };
	}
}

async function settledOrMismatch<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: string,
	operationId: string,
	restored: RestoredLane,
): Promise<DriveResult> {
	if (restored.lastResult?.operationId !== operationId) {
		return Result.err(mismatch(lane, operationId, restored));
	}
	try {
		const outcome = await runtime.sessionStorage.mutate(lane, (reader) =>
			hydrateTerminalOutcome(reader, restored.lastResult!),
		);
		return Result.ok({ kind: "settled", operationId, outcome });
	} catch (error) {
		throw runtime.fault(error);
	}
}

function mismatch(lane: string, expectedOperationId: string, restored: RestoredLane): OperationMismatch {
	const currentOperationId = restored.laneState.currentOperationId ?? undefined;
	const lastOperationId = restored.lastResult?.operationId;
	return new OperationMismatch({
		lane,
		expectedOperationId,
		...(currentOperationId === undefined ? {} : { currentOperationId }),
		...(lastOperationId === undefined ? {} : { lastOperationId }),
		message: `Operation ${expectedOperationId} does not own lane ${JSON.stringify(lane)}`,
	});
}
