import type { TelemetryContext } from "@draht/telemetry";
import type { DriveOptions, TerminalOperationOutcome } from "../agent-harness.ts";
import { HarnessClosed, HarnessFault } from "../agent-harness.ts";
import { restoreLane } from "../restore.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { LaneLastResult, OperationError, RunState } from "../session/types.ts";
import { startHarnessSpan } from "../telemetry.ts";
import { startGeneration } from "./assistant-procedure.ts";
import { deadlineReached, hydrateTerminalOutcome } from "./transitions.ts";
import {
	type ActiveOperation,
	type RuntimeLane,
	type RuntimeProcedureContext,
	RuntimeSliceNotImplemented,
} from "./types.ts";

export type CheckpointDisposition =
	| { kind: "advanced" }
	| { kind: "yielded" }
	| { kind: "settled"; outcome: TerminalOperationOutcome };

export async function driveCheckpoint<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	state: RunState,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
	recovery: boolean,
): Promise<CheckpointDisposition> {
	if (state.phase.kind !== "checkpoint") throw new SessionInvariantError("Checkpoint procedure is not current");
	if (state.phase.continuation.kind === "need_assistant") {
		const advanced = await startGeneration(runtime, lane, active, state, runTelemetry, options);
		return advanced ? { kind: "advanced" } : { kind: "yielded" };
	}
	const outcome = await finishRun(runtime, lane, active, undefined, options, recovery);
	return outcome === undefined ? { kind: "yielded" } : { kind: "settled", outcome };
}

export async function driveFailureDrain<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	state: RunState,
	runTelemetry: TelemetryContext,
	options: DriveOptions,
	recovery: boolean,
): Promise<CheckpointDisposition> {
	if (state.phase.kind !== "failure_drain") {
		throw new SessionInvariantError("Failure-drain procedure is not current");
	}
	const failure = state.phase.error;
	const outcome = await startHarnessSpan(
		runTelemetry,
		"pi.harness.checkpoint",
		{
			"pi.lane.name": lane.name,
			"pi.operation.id": active.operationId,
			"pi.checkpoint.kind": "failure_drain",
		},
		() => finishRun(runtime, lane, active, failure, options, recovery),
	);
	return outcome === undefined ? { kind: "yielded" } : { kind: "settled", outcome };
}

export async function finishRun<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	error: OperationError | undefined,
	options: DriveOptions,
	recovery: boolean,
): Promise<TerminalOperationOutcome | undefined> {
	await lane.breakpoint.hit({
		kind: "run.finish",
		description: "Finish the run",
		details: { operationId: active.operationId, outcome: error === undefined ? "completed" : "failed" },
	});
	if (deadlineReached(options)) return undefined;
	try {
		runtime.assertOpen();
		const lastResult = await runtime.sessionStorage.mutate(lane.name, async (mutator) => {
			const restored = await restoreLane(mutator, lane.name);
			const current = restored.current;
			if (
				current === undefined ||
				current.operation.operationId !== active.operationId ||
				current.state.kind !== "run"
			) {
				throw new SessionInvariantError("Run finish lost operation ownership");
			}
			if (
				current.state.inbox.steer.length !== 0 ||
				current.state.inbox.followUp.length !== 0 ||
				current.state.inbox.writes.length !== 0
			) {
				throw new RuntimeSliceNotImplemented("finish(run with queued input)");
			}
			if (error === undefined) {
				if (current.state.phase.kind !== "checkpoint" || current.state.phase.continuation.kind !== "may_finish") {
					throw new SessionInvariantError("Completed run is not at a finish checkpoint");
				}
			} else if (current.state.phase.kind !== "failure_drain") {
				throw new SessionInvariantError("Failed run is not at failure drain");
			}
			if (restored.leafId === null) throw new SessionInvariantError("Run cannot finish at the root");
			const latestAssistantEntryId = current.state.latestAssistantEntryId ?? undefined;
			const includeFinalAssistant =
				error === undefined &&
				current.state.phase.kind === "checkpoint" &&
				current.state.phase.continuation.kind === "may_finish" &&
				current.state.phase.continuation.includeFinalAssistant;
			const result: LaneLastResult =
				error === undefined
					? {
							operationId: active.operationId,
							kind: "run",
							outcome: "completed",
							leafId: restored.leafId,
							runCompletion: includeFinalAssistant ? "assistant" : "terminated_tools",
							...(includeFinalAssistant && latestAssistantEntryId !== undefined
								? { finalAssistantEntryId: latestAssistantEntryId }
								: {}),
						}
					: {
							operationId: active.operationId,
							kind: "run",
							outcome: "failed",
							leafId: restored.leafId,
							error,
							...(latestAssistantEntryId === undefined ? {} : { finalAssistantEntryId: latestAssistantEntryId }),
						};
			const [toolArgs, preparations] = await Promise.all([
				mutator.listRegisters("op.tool_args", `${active.operationId}:`),
				mutator.listRegisters("op.preparation", `${active.operationId}:`),
			]);
			const pendingIds = [
				...current.state.inbox.steer,
				...current.state.inbox.followUp,
				...current.state.inbox.writes,
				...(current.state.control.status === "cancel_requested"
					? [...current.state.control.drainedSteer, ...current.state.control.drainedFollowUp]
					: []),
			];
			await mutator.commit({
				writes: [
					{ kind: "register", op: "delete", namespace: "op.meta", key: active.operationId },
					{ kind: "register", op: "delete", namespace: "op.state", key: active.operationId },
					...toolArgs.map(
						(register) =>
							({ kind: "register", op: "delete", namespace: "op.tool_args", key: register.key }) as const,
					),
					...preparations.map(
						(register) =>
							({ kind: "register", op: "delete", namespace: "op.preparation", key: register.key }) as const,
					),
					...pendingIds.map(
						(id) => ({ kind: "register", op: "delete", namespace: "pending.entry", key: id }) as const,
					),
					{ kind: "register", op: "set", namespace: "lane.lastResult", key: lane.name, value: result },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: lane.name,
						value: { ...restored.laneState, currentOperationId: null },
					},
				],
			});
			return result;
		});
		const outcome = await runtime.sessionStorage.mutate(lane.name, (reader) =>
			hydrateTerminalOutcome(reader, lastResult),
		);
		if (outcome.operation !== "run") throw new SessionInvariantError("Run terminal result hydrated as another kind");
		runtime.attachedOperationIds.delete(active.operationId);
		runtime.resumedOperationIds.delete(active.operationId);
		runtime.resumeEventOperationIds.delete(active.operationId);
		runtime.restoredSuspensions.delete(lane.name);
		const finalFields =
			outcome.finalEntryId === undefined
				? {}
				: { finalEntryId: outcome.finalEntryId, finalMessage: outcome.finalMessage };
		if (outcome.kind === "failed") {
			await runtime.events.emit({
				type: "run_end",
				runId: active.operationId,
				outcome: "failed",
				leafId: outcome.leafId,
				error: outcome.error,
				...finalFields,
				lane: lane.name,
				...(recovery ? { recovery: true as const } : {}),
			});
		} else {
			await runtime.events.emit({
				type: "run_end",
				runId: active.operationId,
				outcome: outcome.kind,
				leafId: outcome.leafId,
				...finalFields,
				lane: lane.name,
				...(recovery ? { recovery: true as const } : {}),
			});
		}
		return outcome;
	} catch (caught) {
		if (
			caught instanceof RuntimeSliceNotImplemented ||
			caught instanceof HarnessClosed ||
			caught instanceof HarnessFault
		)
			throw caught;
		throw runtime.fault(caught);
	}
}
