import type { ToolResultMessage } from "@draht/ai";
import type { TelemetryContext } from "@draht/telemetry";
import type { AgentTool, AgentToolCall, AgentToolResult } from "../../types.ts";
import type { DriveOptions } from "../agent-harness.ts";
import {
	type AfterToolPatch,
	applyBeforeToolDecision,
	type BeforeToolDecision,
	type ClearedToolCall,
	createToolResultMessage,
	executeToolCall,
	type FinalizedToolCall,
	finalizeToolCall,
	type ImmediateToolOutcome,
	type PreparedToolCall,
	prepareToolCall,
} from "../execution/tools.ts";
import type { RestoredLane } from "../restore.ts";
import { materializeCommittedEntry } from "../session/commit.ts";
import { SessionInvariantError } from "../session/session.ts";
import type {
	ToolCall as DurableToolCall,
	JsonValue,
	RunState,
	SettledAssistantMessage,
	ToolBatch,
} from "../session/types.ts";
import { startHarnessSpan } from "../telemetry.ts";
import type { AgentHarnessTool, AgentHarnessToolInvocation } from "../types.ts";
import { loadExpected, mutateRun } from "./run-mutation.ts";
import { deadlineReached, suspensionBase } from "./transitions.ts";
import type {
	ActiveOperation,
	CommittedToolSettlement,
	RuntimeLane,
	RuntimeProcedureContext,
	StartedToolCall,
	ToolBatchExecutionResult,
} from "./types.ts";

type ToolEventOrigin = "live" | "recovery";
type ToolTurnState = "not_started" | "already_started";

type ToolBatchMode =
	| { kind: "ordinary"; eventOrigin: ToolEventOrigin; turn: ToolTurnState }
	| { kind: "recovery"; turn: ToolTurnState };

type ToolCallStartMode =
	| { kind: "ordinary"; eventOrigin: ToolEventOrigin }
	| { kind: "recovery" }
	| { kind: "truncated"; eventOrigin: ToolEventOrigin };

export function executeOrdinaryToolBatch<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	state: RunState,
	turnTelemetry: TelemetryContext,
	options: DriveOptions,
	entry: { eventOrigin: ToolEventOrigin; turn: ToolTurnState },
): Promise<ToolBatchExecutionResult> {
	return executeToolBatch(runtime, lane, active, restored, state, turnTelemetry, options, {
		kind: "ordinary",
		...entry,
	});
}

export function recoverToolBatchAtActivation<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	state: RunState,
	turnTelemetry: TelemetryContext,
	options: DriveOptions,
): Promise<ToolBatchExecutionResult> {
	return executeToolBatch(runtime, lane, active, restored, state, turnTelemetry, options, {
		kind: "recovery",
		turn: "not_started",
	});
}

async function executeToolBatch<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	state: RunState,
	turnTelemetry: TelemetryContext,
	options: DriveOptions,
	mode: ToolBatchMode,
): Promise<ToolBatchExecutionResult> {
	const eventOrigin = mode.kind === "recovery" ? "recovery" : mode.eventOrigin;
	let turn = mode.turn;
	if (state.phase.kind !== "tools") throw new SessionInvariantError("Tool batch is not current");
	const batch = state.phase.batch;
	const assistantEntry = restored.current?.entries.get(batch.assistantEntryId);
	if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") {
		throw new SessionInvariantError("Tool batch assistant is missing");
	}
	if (assistantEntry.message.stopReason === "pending") {
		throw new SessionInvariantError("Tool batch assistant is still pending");
	}
	const assistantMessage = assistantEntry.message as SettledAssistantMessage;
	const sourceCalls = assistantToolCalls(assistantMessage);
	if (sourceCalls.length !== batch.calls.length) {
		throw new SessionInvariantError("Tool batch source calls changed");
	}

	const settings = await runtime.snapshotSettings();
	const toolsByName = new Map(settings.tools.map((tool) => [tool.name, tool]));
	const sequential =
		state.settings.toolExecution === "sequential" ||
		sourceCalls.some(
			(source) =>
				batch.configuration.activeToolNames.includes(source.name) &&
				toolsByName.get(source.name)?.executionMode === "sequential",
		);
	const hasPlanned = batch.calls.some((call) => call.status === "planned");
	const genuineLength = assistantMessage.stopReason === "length";
	const plannedMissingTools = new Set<string>();
	const replayMissingTools = new Set<string>();
	if (!genuineLength && hasPlanned) {
		for (const name of batch.configuration.activeToolNames) {
			if (!toolsByName.has(name)) plannedMissingTools.add(name);
		}
	}
	if (mode.kind === "recovery") {
		for (const durableCall of batch.calls) {
			if (durableCall.status !== "effect_pending" || durableCall.replay !== "safe") continue;
			const source = sourceCalls[durableCall.sourceIndex]!;
			if (!batch.configuration.activeToolNames.includes(source.name)) {
				throw new SessionInvariantError("Pending tool effect is outside the captured active-tool set");
			}
			if (!toolsByName.has(source.name)) replayMissingTools.add(source.name);
		}
	}
	const missingTools = new Set([...replayMissingTools, ...plannedMissingTools]);
	const toolResults: ToolResultMessage[] = [];
	for (const durableCall of batch.calls) {
		if (durableCall.status !== "completed") break;
		const entry = restored.current?.entries.get(durableCall.resultEntryId);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new SessionInvariantError("Completed tool result is missing");
		}
		toolResults.push(entry.message);
	}
	if (mode.kind === "recovery") {
		const pendingPrefix = batch.calls.filter(
			(call, index): call is Extract<DurableToolCall, { status: "effect_pending" }> => {
				if (call.status === "completed") return false;
				return (
					batch.calls.slice(0, index).every((prior) => prior.status !== "planned") &&
					call.status === "effect_pending"
				);
			},
		);
		const identityFreePrefix: typeof pendingPrefix = [];
		for (const durableCall of pendingPrefix) {
			const currentTool = toolsByName.get(sourceCalls[durableCall.sourceIndex]!.name);
			if (durableCall.replay === "safe" && (currentTool === undefined || currentTool.replay === "safe")) break;
			identityFreePrefix.push(durableCall);
		}
		if (identityFreePrefix.length !== 0) {
			if (turn === "not_started") {
				await runtime.events.emit({
					type: "turn_start",
					runId: active.operationId,
					turnId: batch.turnId,
					lane: lane.name,
					recovery: true,
				});
				turn = "already_started";
			}
			let batchCompleted = false;
			for (const durableCall of identityFreePrefix) {
				const started = await startToolCall(
					runtime,
					lane,
					active,
					batch,
					durableCall,
					sourceCalls[durableCall.sourceIndex]!,
					batch.configuration.activeToolNames,
					toolsByName,
					undefined as TContext,
					turnTelemetry,
					options,
					{ kind: "recovery" },
				);
				if (started === "yielded") {
					await runtime.events.emit({
						type: "turn_end",
						runId: active.operationId,
						turnId: batch.turnId,
						message: assistantMessage,
						toolResults,
						lane: lane.name,
						recovery: true,
					});
					return { kind: "yielded" };
				}
				const committed = await settleStartedToolCall(
					runtime,
					lane,
					active,
					batch,
					started,
					turnTelemetry,
					"recovery",
				);
				toolResults.push(committed.message);
				batchCompleted = committed.batchCompleted;
			}
			if (batchCompleted) {
				await runtime.events.emit({
					type: "turn_end",
					runId: active.operationId,
					turnId: batch.turnId,
					message: assistantMessage,
					toolResults,
					lane: lane.name,
					recovery: true,
				});
				return { kind: "advanced" };
			}
			const next = await loadExpected(runtime, lane.name, active.operationId, false);
			const nextCurrent = next.current;
			if (nextCurrent?.state.kind !== "run" || nextCurrent.state.phase.kind !== "tools") {
				throw new SessionInvariantError("Interrupted tool prefix lost its durable batch");
			}
			return executeToolBatch(runtime, lane, active, next, nextCurrent.state, turnTelemetry, options, {
				kind: "recovery",
				turn: "already_started",
			});
		}
	}
	if (missingTools.size !== 0) {
		if (mode.kind === "recovery") {
			const pendingPrefix = batch.calls.filter(
				(call, index): call is Extract<DurableToolCall, { status: "effect_pending" }> => {
					if (call.status === "completed") return false;
					return (
						batch.calls.slice(0, index).every((prior) => prior.status !== "planned") &&
						call.status === "effect_pending"
					);
				},
			);
			const executablePendingPrefix: typeof pendingPrefix = [];
			for (const durableCall of pendingPrefix) {
				const source = sourceCalls[durableCall.sourceIndex]!;
				if (durableCall.replay === "safe" && toolsByName.get(source.name) === undefined) break;
				executablePendingPrefix.push(durableCall);
			}
			const replayNeedsContext = executablePendingPrefix.some((durableCall) => {
				const currentTool = toolsByName.get(sourceCalls[durableCall.sourceIndex]!.name);
				return durableCall.replay === "safe" && currentTool?.replay === "safe";
			});
			const recoveryContext = replayNeedsContext ? await resolveToolContext(runtime) : undefined;
			const startedPrefix: StartedToolCall[] = [];
			let recoveryTurn = turn;
			let yielded = false;
			for (const durableCall of executablePendingPrefix) {
				const source = sourceCalls[durableCall.sourceIndex]!;
				if (recoveryTurn === "not_started") {
					await runtime.events.emit({
						type: "turn_start",
						runId: active.operationId,
						turnId: batch.turnId,
						lane: lane.name,
						recovery: true,
					});
					recoveryTurn = "already_started";
				}
				const started = await startToolCall(
					runtime,
					lane,
					active,
					batch,
					durableCall,
					source,
					batch.configuration.activeToolNames,
					toolsByName,
					recoveryContext as TContext,
					turnTelemetry,
					options,
					{ kind: "recovery" },
				);
				if (started === "yielded") {
					yielded = true;
					break;
				}
				if (sequential) {
					const committed = await settleStartedToolCall(
						runtime,
						lane,
						active,
						batch,
						started,
						turnTelemetry,
						"recovery",
					);
					toolResults.push(committed.message);
				} else {
					startedPrefix.push(started);
				}
			}
			for (const started of startedPrefix) {
				const committed = await settleStartedToolCall(
					runtime,
					lane,
					active,
					batch,
					started,
					turnTelemetry,
					"recovery",
				);
				toolResults.push(committed.message);
			}
			if (recoveryTurn === "already_started") {
				await runtime.events.emit({
					type: "turn_end",
					runId: active.operationId,
					turnId: batch.turnId,
					message: assistantMessage,
					toolResults,
					lane: lane.name,
					recovery: true,
				});
			}
			if (yielded) return { kind: "yielded" };
		}
		return suspendToolBatchForMissingIdentities(runtime, lane, active, restored, [...missingTools], eventOrigin);
	}

	const needsContext =
		!genuineLength &&
		batch.calls.some((durableCall) => {
			if (durableCall.status === "planned") return true;
			if (durableCall.status !== "effect_pending" || durableCall.replay !== "safe") return false;
			return toolsByName.get(sourceCalls[durableCall.sourceIndex]!.name)?.replay === "safe";
		});
	const context = needsContext ? await resolveToolContext(runtime) : undefined;
	const callMode: ToolCallStartMode = genuineLength
		? { kind: "truncated", eventOrigin }
		: mode.kind === "recovery"
			? { kind: "recovery" }
			: { kind: "ordinary", eventOrigin };
	const opensRecoveryTurn = eventOrigin === "recovery" && turn === "not_started";
	if (opensRecoveryTurn) {
		await runtime.events.emit({
			type: "turn_start",
			runId: active.operationId,
			turnId: batch.turnId,
			lane: lane.name,
			recovery: true,
		});
	}
	const closeRecoveryTurn = async (): Promise<void> => {
		if (eventOrigin !== "recovery") return;
		await runtime.events.emit({
			type: "turn_end",
			runId: active.operationId,
			turnId: batch.turnId,
			message: assistantMessage,
			toolResults,
			lane: lane.name,
			recovery: true,
		});
	};

	let progressed = false;
	let batchCompleted = false;
	if (sequential) {
		for (const durableCall of batch.calls) {
			if (durableCall.status === "completed") continue;
			if (deadlineReached(options)) {
				await closeRecoveryTurn();
				return mode.kind === "recovery" || !progressed ? { kind: "yielded" } : { kind: "advanced" };
			}
			const started = await startToolCall(
				runtime,
				lane,
				active,
				batch,
				durableCall,
				sourceCalls[durableCall.sourceIndex]!,
				batch.configuration.activeToolNames,
				toolsByName,
				context as TContext,
				turnTelemetry,
				options,
				callMode,
			);
			if (started === "yielded") {
				await closeRecoveryTurn();
				return mode.kind === "recovery" || !progressed ? { kind: "yielded" } : { kind: "advanced" };
			}
			const committed = await settleStartedToolCall(
				runtime,
				lane,
				active,
				batch,
				started,
				turnTelemetry,
				eventOrigin,
			);
			toolResults.push(committed.message);
			progressed = true;
			batchCompleted = committed.batchCompleted;
		}
	} else {
		const started = new Map<number, StartedToolCall>();
		for (const durableCall of batch.calls) {
			if (durableCall.status === "completed") continue;
			if (deadlineReached(options)) break;
			const local = await startToolCall(
				runtime,
				lane,
				active,
				batch,
				durableCall,
				sourceCalls[durableCall.sourceIndex]!,
				batch.configuration.activeToolNames,
				toolsByName,
				context as TContext,
				turnTelemetry,
				options,
				callMode,
			);
			if (local === "yielded") break;
			started.set(durableCall.sourceIndex, local);
		}
		for (const durableCall of batch.calls) {
			if (durableCall.status === "completed") continue;
			const local = started.get(durableCall.sourceIndex);
			if (local === undefined) break;
			const committed = await settleStartedToolCall(runtime, lane, active, batch, local, turnTelemetry, eventOrigin);
			toolResults.push(committed.message);
			progressed = true;
			batchCompleted = committed.batchCompleted;
		}
		if (
			mode.kind === "recovery" &&
			batch.calls.some((call) => call.status === "effect_pending" && !started.has(call.sourceIndex))
		) {
			await closeRecoveryTurn();
			return { kind: "yielded" };
		}
	}

	if (batchCompleted) {
		await runtime.events.emit({
			type: "turn_end",
			runId: active.operationId,
			turnId: batch.turnId,
			message: assistantMessage,
			toolResults,
			lane: lane.name,
			...(eventOrigin === "recovery" ? { recovery: true as const } : {}),
		});
	} else {
		await closeRecoveryTurn();
		if (mode.kind === "recovery") return { kind: "yielded" };
	}
	return progressed ? { kind: "advanced" } : { kind: "yielded" };
}

async function startToolCall<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	batch: ToolBatch,
	durableCall: DurableToolCall,
	sourceCall: AgentToolCall,
	activeToolNames: string[],
	toolsByName: Map<string, AgentHarnessTool<TContext>>,
	context: TContext,
	turnTelemetry: TelemetryContext,
	options: DriveOptions,
	mode: ToolCallStartMode,
): Promise<StartedToolCall | "yielded"> {
	const eventOrigin = mode.kind === "recovery" ? "recovery" : mode.eventOrigin;
	const recovery = eventOrigin === "recovery";
	if (mode.kind === "truncated") {
		if (durableCall.status !== "planned") {
			throw new SessionInvariantError("Genuine-length tool batch has a non-planned call");
		}
		return {
			kind: "immediate",
			sourceIndex: durableCall.sourceIndex,
			finalized: createSyntheticFinalizedToolCall(
				sourceCall,
				`Tool call "${sourceCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			recovery,
			durableStatus: "planned",
		};
	}
	if (durableCall.status === "effect_pending") {
		if (mode.kind !== "recovery") {
			throw new SessionInvariantError("Ordinary dispatch reached an orphaned tool effect");
		}
		const currentTool = toolsByName.get(sourceCall.name);
		if (durableCall.replay !== "safe" || currentTool?.replay !== "safe") {
			await lane.breakpoint.hit({
				kind: "tool.recover_interruption",
				description: "Interrupt an uncertain tool effect",
				details: {
					operationId: active.operationId,
					turnId: batch.turnId,
					sourceIndex: durableCall.sourceIndex,
					toolCallId: sourceCall.id,
					toolName: sourceCall.name,
				},
			});
			if (deadlineReached(options)) return "yielded";
			return {
				kind: "immediate",
				sourceIndex: durableCall.sourceIndex,
				finalized: createSyntheticFinalizedToolCall(
					sourceCall,
					`Tool ${sourceCall.name} was interrupted before its result became durable and is not safe to replay`,
				),
				recovery: true,
				durableStatus: "effect_pending",
			};
		}
		const args = (await loadExpected(runtime, lane.name, active.operationId, false)).current?.toolArguments.get(
			toolArgumentsKey(active.operationId, batch.turnId, durableCall.sourceIndex),
		);
		if (args === undefined) throw new SessionInvariantError("Pending tool arguments are missing");
		const cleared: ClearedToolCall = {
			toolCall: sourceCall,
			tool: bindTool(currentTool, context, {
				invocationId: durableCall.resultEntryId,
				operationId: active.operationId,
				turnId: batch.turnId,
			}),
			args,
		};
		return startRealToolCall(runtime, lane, active, batch, durableCall, cleared, turnTelemetry, "recovery");
	}
	if (durableCall.status !== "planned") throw new SessionInvariantError("Completed tool call was restarted");
	const applicationTool = activeToolNames.includes(sourceCall.name) ? toolsByName.get(sourceCall.name) : undefined;
	const invocation: AgentHarnessToolInvocation = {
		invocationId: durableCall.resultEntryId,
		operationId: active.operationId,
		turnId: batch.turnId,
	};
	const prepared = prepareToolCall(
		sourceCall,
		applicationTool === undefined ? [] : [bindTool(applicationTool, context, invocation)],
	);
	if (isImmediateToolOutcome(prepared)) {
		return {
			kind: "immediate",
			sourceIndex: durableCall.sourceIndex,
			finalized: finalizeImmediateToolOutcome(prepared),
			recovery,
			durableStatus: "planned",
		};
	}
	let decision: BeforeToolDecision | undefined;
	if (runtime.hooks.has("before_tool")) {
		await lane.breakpoint.hit({
			kind: "hook.before_tool",
			description: "Run tool clearance hooks",
			details: {
				operationId: active.operationId,
				turnId: batch.turnId,
				sourceIndex: durableCall.sourceIndex,
				toolCallId: sourceCall.id,
				toolName: sourceCall.name,
			},
		});
		if (deadlineReached(options)) return "yielded";
		decision = await runtime.hooks.runToolWithGate(
			"before_tool",
			{
				lane: lane.name,
				runId: active.operationId,
				toolCallId: sourceCall.id,
				toolName: sourceCall.name,
				args: prepared.args,
			},
			active.effectGate,
			turnTelemetry,
		);
		if (deadlineReached(options)) return "yielded";
	}
	const cleared = applyBeforeToolDecision(prepared, decision);
	if (isImmediateToolOutcome(cleared)) {
		return {
			kind: "immediate",
			sourceIndex: durableCall.sourceIndex,
			finalized: finalizeImmediateToolOutcome(cleared),
			recovery,
			durableStatus: "planned",
		};
	}
	await lane.breakpoint.hit({
		kind: "tool.intent",
		description: "Commit tool execution intent",
		details: {
			operationId: active.operationId,
			turnId: batch.turnId,
			sourceIndex: durableCall.sourceIndex,
			toolCallId: sourceCall.id,
			toolName: sourceCall.name,
		},
	});
	if (deadlineReached(options)) return "yielded";
	const intent = await commitToolIntent(runtime, lane.name, active.operationId, batch, durableCall, cleared);
	if (intent === "cancelled") {
		return {
			kind: "immediate",
			sourceIndex: durableCall.sourceIndex,
			finalized: createSyntheticFinalizedToolCall(sourceCall, "Operation aborted before tool execution"),
			recovery,
			durableStatus: "planned",
		};
	}
	return startRealToolCall(runtime, lane, active, batch, durableCall, cleared, turnTelemetry, eventOrigin);
}

async function startRealToolCall<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	batch: ToolBatch,
	durableCall: Exclude<DurableToolCall, { status: "completed" }>,
	cleared: ClearedToolCall,
	turnTelemetry: TelemetryContext,
	eventOrigin: ToolEventOrigin,
): Promise<StartedToolCall> {
	const recovery = eventOrigin === "recovery";
	await runtime.events.emit({
		type: "tool_start",
		runId: active.operationId,
		turnId: batch.turnId,
		toolCallId: cleared.toolCall.id,
		toolName: cleared.toolCall.name,
		args: cleared.args,
		lane: lane.name,
		...(recovery ? { recovery: true as const } : {}),
	});
	await lane.breakpoint.hit({
		kind: "tool.execute",
		description: "Execute tool",
		details: {
			operationId: active.operationId,
			turnId: batch.turnId,
			sourceIndex: durableCall.sourceIndex,
			toolCallId: cleared.toolCall.id,
			toolName: cleared.toolCall.name,
			recovery,
		},
	});
	const updateDeliveries: Promise<void>[] = [];
	active.effectGate.signal.addEventListener("abort", () => updateDeliveries.splice(0), { once: true });
	const replay = cleared.tool.replay ?? "never";
	const instrumented: ClearedToolCall = {
		...cleared,
		tool: {
			...cleared.tool,
			execute: (toolCallId, args, signal, onUpdate) =>
				startHarnessSpan(
					turnTelemetry,
					"pi.harness.tool",
					{
						"pi.lane.name": lane.name,
						"pi.operation.id": active.operationId,
						"pi.turn.id": batch.turnId,
						"pi.tool.name": cleared.toolCall.name,
						"pi.tool.call_id": cleared.toolCall.id,
						"pi.tool.replay": replay,
						"pi.tool.recovery": recovery,
					},
					async (toolSpan) => {
						try {
							const result = await cleared.tool.execute(toolCallId, args, signal, onUpdate);
							toolSpan.setAttributes({ "pi.tool.is_error": false });
							return result;
						} catch (error) {
							toolSpan.setAttributes({ "pi.tool.is_error": true });
							toolSpan.setStatus({ status: "error" });
							throw error;
						}
					},
				),
		},
	};
	const execution = (async () => {
		const executed = await executeToolCall(
			instrumented,
			active.effectGate,
			(partialResult) => {
				if (!runtime.isOpen() || active.effectGate.signal.aborted) return;
				const delivery = runtime.events.emit({
					type: "tool_update",
					runId: active.operationId,
					turnId: batch.turnId,
					toolCallId: cleared.toolCall.id,
					toolName: cleared.toolCall.name,
					partialResult,
					lane: lane.name,
					...(recovery ? { recovery: true as const } : {}),
				});
				void delivery.catch(() => {});
				updateDeliveries.push(delivery);
			},
			turnTelemetry,
		);
		await Promise.all(updateDeliveries);
		return executed;
	})();
	void execution.catch(() => {});
	return { kind: "running", sourceIndex: durableCall.sourceIndex, cleared, execution, recovery };
}

async function commitToolIntent<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: string,
	operationId: string,
	batch: ToolBatch,
	durableCall: Extract<DurableToolCall, { status: "planned" }>,
	cleared: ClearedToolCall,
): Promise<"committed" | "cancelled"> {
	return mutateRun(runtime, lane, async ({ mutator, restored }) => {
		const state = restored.current?.state;
		if (restored.current?.operation.operationId !== operationId || state?.kind !== "run") {
			throw new SessionInvariantError("Tool intent lost run ownership");
		}
		const latest = requireMatchingToolBatch(state, batch);
		if (state.control.status !== "running") return "cancelled";
		const call = latest.calls[durableCall.sourceIndex];
		if (
			call?.status !== "planned" ||
			call.resultEntryId !== durableCall.resultEntryId ||
			call.sourceIndex !== durableCall.sourceIndex
		) {
			throw new SessionInvariantError("Tool intent found another call restart point");
		}
		const calls = [...latest.calls];
		calls[durableCall.sourceIndex] = {
			status: "effect_pending",
			sourceIndex: durableCall.sourceIndex,
			resultEntryId: durableCall.resultEntryId,
			replay: cleared.tool.replay ?? "never",
		};
		await mutator.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.tool_args",
					key: toolArgumentsKey(operationId, batch.turnId, durableCall.sourceIndex),
					value: cleared.args,
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: { ...state, phase: { kind: "tools", batch: { ...latest, calls } } },
				},
			],
		});
		return "committed";
	});
}

async function settleStartedToolCall<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	batch: ToolBatch,
	started: StartedToolCall,
	turnTelemetry: TelemetryContext,
	eventOrigin: ToolEventOrigin,
): Promise<CommittedToolSettlement> {
	let finalized: FinalizedToolCall;
	if (started.kind === "immediate") {
		finalized = started.finalized;
	} else {
		const executed = await started.execution;
		let patch: AfterToolPatch | undefined;
		if (runtime.hooks.has("after_tool")) {
			await lane.breakpoint.hit({
				kind: "hook.after_tool",
				description: "Run tool result hooks",
				details: {
					operationId: active.operationId,
					turnId: batch.turnId,
					sourceIndex: started.sourceIndex,
					toolCallId: started.cleared.toolCall.id,
					toolName: started.cleared.toolCall.name,
					recovery: started.recovery,
				},
			});
			patch = await runtime.hooks.runToolWithGate(
				"after_tool",
				{
					lane: lane.name,
					runId: active.operationId,
					toolCallId: started.cleared.toolCall.id,
					toolName: started.cleared.toolCall.name,
					args: started.cleared.args,
					content: executed.result.content,
					details: executed.result.details as JsonValue | undefined,
					isError: executed.isError,
					...(executed.result.usage === undefined ? {} : { usage: executed.result.usage }),
				},
				active.effectGate,
				turnTelemetry,
			);
		}
		finalized = finalizeToolCall(started.cleared, executed, patch);
		await runtime.events.emit({
			type: "tool_end",
			runId: active.operationId,
			turnId: batch.turnId,
			toolCallId: finalized.toolCall.id,
			toolName: finalized.toolCall.name,
			result: finalized.result,
			isError: finalized.isError,
			terminate: finalized.terminate,
			lane: lane.name,
			...(started.recovery ? { recovery: true as const } : {}),
		});
	}
	const message = createToolResultMessage(finalized);
	await runtime.events.emit({
		type: "message_start",
		runId: active.operationId,
		message,
		lane: lane.name,
		...(eventOrigin === "recovery" ? { recovery: true as const } : {}),
	});
	await runtime.events.emit({
		type: "message_end",
		runId: active.operationId,
		message,
		entryId: batch.calls[started.sourceIndex]!.resultEntryId,
		lane: lane.name,
		...(eventOrigin === "recovery" ? { recovery: true as const } : {}),
	});
	await lane.breakpoint.hit({
		kind: "tool.settlement",
		description: "Commit tool result",
		details: {
			operationId: active.operationId,
			turnId: batch.turnId,
			sourceIndex: started.sourceIndex,
			toolCallId: finalized.toolCall.id,
			toolName: finalized.toolCall.name,
			recovery: started.recovery,
		},
	});
	const committed = await commitToolSettlement(
		runtime,
		lane.name,
		active.operationId,
		batch,
		started,
		finalized,
		message,
	);
	await runtime.events.emit({ type: "entry_added", entry: committed.entry, lane: lane.name });
	if (committed.row !== undefined && committed.totals !== undefined) {
		await runtime.events.emit({ type: "usage", lane: lane.name, row: committed.row, totals: committed.totals });
	}
	return committed;
}

async function commitToolSettlement<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: string,
	operationId: string,
	batch: ToolBatch,
	started: StartedToolCall,
	finalized: FinalizedToolCall,
	message: ToolResultMessage,
): Promise<CommittedToolSettlement> {
	runtime.assertOpen();
	const usageId = finalized.result.usage === undefined ? undefined : runtime.sessionStorage.idGenerator.next();
	const committed = await mutateRun(runtime, lane, async ({ mutator, restored }) => {
		const state = restored.current?.state;
		if (restored.current?.operation.operationId !== operationId || state?.kind !== "run") {
			throw new SessionInvariantError("Tool settlement lost run ownership");
		}
		const latest = requireMatchingToolBatch(state, batch);
		const call = latest.calls[started.sourceIndex];
		const expectedStatus = started.kind === "running" ? "effect_pending" : started.durableStatus;
		if (
			call?.status !== expectedStatus ||
			call.resultEntryId !== batch.calls[started.sourceIndex]!.resultEntryId ||
			call.sourceIndex !== started.sourceIndex
		) {
			throw new SessionInvariantError("Tool settlement found another call restart point");
		}
		if (latest.calls.slice(0, started.sourceIndex).some((candidate) => candidate.status !== "completed")) {
			throw new SessionInvariantError("Tool settlement would overtake an earlier call");
		}
		const terminate = state.control.status === "running" ? finalized.terminate : false;
		const calls = [...latest.calls];
		calls[started.sourceIndex] = {
			status: "completed",
			sourceIndex: started.sourceIndex,
			resultEntryId: call.resultEntryId,
			terminate,
		};
		const batchCompleted = calls.every((candidate) => candidate.status === "completed");
		const toolArgumentRegisters = batchCompleted
			? await mutator.listRegisters("op.tool_args", `${operationId}:${latest.turnId}:`)
			: [];
		const nextPhase: RunState["phase"] = batchCompleted
			? {
					kind: "checkpoint",
					continuation: calls.every((candidate) => candidate.status === "completed" && candidate.terminate)
						? { kind: "may_finish", includeFinalAssistant: false }
						: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: call.resultEntryId,
				}
			: { kind: "tools", batch: { ...latest, calls } };
		const resultEntry = {
			id: call.resultEntryId,
			parentId: restored.leafId,
			type: "message" as const,
			message,
			...(terminate ? { terminate: true as const } : {}),
		};
		const writes = [
			{ kind: "entry" as const, entry: resultEntry },
			{
				kind: "register" as const,
				op: "set" as const,
				namespace: "lane.leaf" as const,
				key: lane,
				value: call.resultEntryId,
			},
			...(usageId === undefined || finalized.result.usage === undefined
				? []
				: [
						{
							kind: "usage" as const,
							row: {
								id: usageId,
								usage: finalized.result.usage,
								entryId: call.resultEntryId,
								adjustment: false,
							},
						},
					]),
			...toolArgumentRegisters.map((register) => ({
				kind: "register" as const,
				op: "delete" as const,
				namespace: "op.tool_args" as const,
				key: register.key,
			})),
			{
				kind: "register" as const,
				op: "set" as const,
				namespace: "op.state" as const,
				key: operationId,
				value: { ...state, phase: nextPhase },
			},
		];
		const result = await mutator.commit({ writes });
		const usageIndex = usageId === undefined ? -1 : 2;
		return {
			entry: materializeCommittedEntry(resultEntry, result.seqs[0]!, result.timestamp),
			message,
			batchCompleted,
			...(usageId === undefined || finalized.result.usage === undefined
				? {}
				: {
						row: {
							id: usageId,
							seq: result.seqs[usageIndex]!,
							usage: finalized.result.usage,
							entryId: call.resultEntryId,
							adjustment: false,
						},
					}),
		};
	});
	return committed.row === undefined
		? committed
		: { ...committed, totals: (await runtime.sessionStorage.getStats()).usage };
}

async function suspendToolBatchForMissingIdentities<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	restored: RestoredLane,
	tools: string[],
	eventOrigin: ToolEventOrigin,
): Promise<ToolBatchExecutionResult> {
	const missing = { tools };
	runtime.restoredSuspensions.set(lane.name, {
		...suspensionBase(restored),
		reason: "missing_identities",
		missing,
	});
	await runtime.events.emit({
		type: "run_suspend",
		runId: active.operationId,
		reason: "missing_identities",
		missing,
		lane: lane.name,
		...(eventOrigin === "recovery" ? { recovery: true as const } : {}),
	});
	return { kind: "missing_identities", missing };
}

async function resolveToolContext<TContext extends object | undefined>(
	runtime: RuntimeProcedureContext<TContext>,
): Promise<TContext> {
	const source = runtime.toolContext;
	return (typeof source === "function" ? await source() : source) as TContext;
}

function bindTool<TContext extends object | undefined>(
	tool: AgentHarnessTool<TContext>,
	context: TContext,
	invocation: AgentHarnessToolInvocation,
): AgentTool {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate, context, invocation),
	};
}

function assistantToolCalls(message: SettledAssistantMessage): AgentToolCall[] {
	return message.content.filter((block): block is AgentToolCall => block.type === "toolCall");
}

function toolArgumentsKey(operationId: string, turnId: string, sourceIndex: number): string {
	return `${operationId}:${turnId}:${sourceIndex}`;
}

function requireMatchingToolBatch(state: RunState, expected: ToolBatch): ToolBatch {
	if (
		state.phase.kind !== "tools" ||
		state.phase.batch.assistantEntryId !== expected.assistantEntryId ||
		state.phase.batch.turnId !== expected.turnId ||
		state.phase.batch.calls.length !== expected.calls.length
	) {
		throw new SessionInvariantError("Tool operation found another batch restart point");
	}
	return state.phase.batch;
}

function isImmediateToolOutcome(
	value: PreparedToolCall | ClearedToolCall | ImmediateToolOutcome,
): value is ImmediateToolOutcome {
	return "kind" in value && value.kind === "immediate";
}

function finalizeImmediateToolOutcome(outcome: ImmediateToolOutcome): FinalizedToolCall {
	return {
		toolCall: outcome.toolCall,
		result: outcome.result,
		isError: true,
		terminate: outcome.terminate,
	};
}

function createSyntheticFinalizedToolCall(
	toolCall: AgentToolCall,
	message: string,
	terminate = false,
): FinalizedToolCall {
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: message }],
		details: {},
		...(terminate ? { terminate: true } : {}),
	};
	return { toolCall, result, isError: true, terminate };
}
