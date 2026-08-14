import { SessionInvariantError } from "./session/session.ts";
import type {
	Entry,
	LaneConfiguration,
	LaneLastResult,
	LaneState,
	Operation,
	OperationState,
	RunState,
	SessionReader,
} from "./session/types.ts";

export interface RestoredOperation {
	operation: Operation;
	state: OperationState;
	entries: Map<string, Entry>;
}

export interface RestoredLane {
	lane: string;
	leafId: string | null;
	configuration: LaneConfiguration;
	laneState: LaneState;
	lastResult?: LaneLastResult;
	current?: RestoredOperation;
}

interface RestoreOptions {
	includeLastResult?: boolean;
}

/** Load and validate the lane and operation ownership needed by the R1 shell. */
export async function restoreLane(
	reader: SessionReader,
	lane: string,
	options: RestoreOptions = {},
): Promise<RestoredLane> {
	const [configuration, laneState, leaf, lastResult] = await Promise.all([
		reader.getRegister("lane.config", lane),
		reader.getRegister("lane.state", lane),
		reader.getRegister("lane.leaf", lane),
		options.includeLastResult ? reader.getRegister("lane.lastResult", lane) : Promise.resolve(undefined),
	]);
	if (configuration === undefined) invariant(lane, "is missing lane.config");
	if (laneState === undefined) invariant(lane, "is missing lane.state");
	if (leaf === undefined) invariant(lane, "is missing lane.leaf");

	const operationId = laneState.value.currentOperationId;
	const [operation, operationState] =
		operationId === null
			? [undefined, undefined]
			: await Promise.all([reader.getRegister("op.meta", operationId), reader.getRegister("op.state", operationId)]);
	if (operationId !== null && operation === undefined) {
		invariant(lane, `names operation ${operationId}, which is missing op.meta`);
	}
	if (operationId !== null && operationState === undefined) {
		invariant(lane, `names operation ${operationId}, which is missing op.state`);
	}

	const expectations = new Map<string, "any" | "message" | "assistant">();
	const forbiddenEntries = new Set<string>();
	const pendingExpectations = new Map<string, "any" | "message">();
	if (leaf.value !== null) expectations.set(leaf.value, "any");
	for (const id of laneState.value.pendingNextRun) addPendingExpectation(pendingExpectations, id, "message", lane);
	if (operation !== undefined && operationState !== undefined) {
		if (operation.value.operationId !== operationId) {
			invariant(lane, `op.meta/${operationId} has another operation id`);
		}
		if (operation.value.lane !== lane) {
			invariant(lane, `operation ${operationId} belongs to lane ${operation.value.lane}`);
		}
		if (operation.value.intent.kind !== operationState.value.kind) {
			invariant(
				lane,
				`operation ${operationId} intent ${operation.value.intent.kind} does not match state ${operationState.value.kind}`,
			);
		}
		if (operation.value.sourceLeafId !== null) expectations.set(operation.value.sourceLeafId, "any");
		if (operation.value.intent.kind === "run") {
			for (const id of operation.value.intent.promptEntryIds) expectations.set(id, "message");
			validateRunState(
				operationState.value as RunState,
				expectations,
				forbiddenEntries,
				pendingExpectations,
				leaf.value,
				lane,
			);
		} else if (operation.value.intent.kind === "navigation" && operation.value.intent.targetId !== null) {
			expectations.set(operation.value.intent.targetId, "any");
		}
	}

	const entryIds = [...new Set([...expectations.keys(), ...forbiddenEntries, ...pendingExpectations.keys()])];
	const [entries, pendingRegisters] = await Promise.all([
		reader.getEntries(entryIds),
		Promise.all(
			[...pendingExpectations].map(async ([id, expected]) => ({
				id,
				expected,
				register: await reader.getRegister("pending.entry", id),
			})),
		),
	]);
	for (const [id, expected] of expectations) {
		const entry = entries.get(id);
		if (entry === undefined) invariant(lane, `references missing entry ${id}`);
		if (expected !== "any" && entry.type !== "message") invariant(lane, `entry ${id} is not a message`);
		if (expected === "assistant" && entry.type === "message" && entry.message.role !== "assistant") {
			invariant(lane, `entry ${id} is not an assistant message`);
		}
	}
	if (operationState?.value.kind === "run") {
		const state = operationState.value;
		if (
			state.control.status === "running" &&
			state.phase.kind === "checkpoint" &&
			state.phase.continuation.kind === "may_finish" &&
			state.phase.continuation.includeFinalAssistant &&
			state.latestAssistantEntryId !== null
		) {
			const latest = entries.get(state.latestAssistantEntryId);
			if (
				latest?.type !== "message" ||
				latest.message.role !== "assistant" ||
				(latest.message.stopReason !== "stop" && latest.message.stopReason !== "length")
			) {
				invariant(lane, "finish checkpoint latest assistant has an invalid stop reason");
			}
		}
	}
	for (const id of forbiddenEntries) {
		if (entries.has(id)) invariant(lane, `reserved entry ${id} already exists`);
	}
	for (const pending of pendingRegisters) {
		if (pending.register === undefined) invariant(lane, `references missing pending entry ${pending.id}`);
		if (entries.has(pending.id)) invariant(lane, `pending entry ${pending.id} is already placed`);
		if (pending.expected === "message" && pending.register.value.type !== "message") {
			invariant(lane, `pending entry ${pending.id} is not a message`);
		}
		if (
			pending.register.value.type === "message" &&
			pending.register.value.payload.role === "assistant" &&
			pending.register.value.payload.stopReason === "pending"
		) {
			invariant(lane, `pending entry ${pending.id} contains a pending assistant`);
		}
	}

	return {
		lane,
		leafId: leaf.value,
		configuration: configuration.value,
		laneState: laneState.value,
		...(lastResult === undefined ? {} : { lastResult: lastResult.value }),
		...(operation === undefined || operationState === undefined
			? {}
			: { current: { operation: operation.value, state: operationState.value, entries } }),
	};
}

function validateRunState(
	state: RunState,
	expectations: Map<string, "any" | "message" | "assistant">,
	forbiddenEntries: Set<string>,
	pendingExpectations: Map<string, "any" | "message">,
	leafId: string | null,
	lane: string,
): void {
	if (state.latestAssistantEntryId !== null)
		addEntryExpectation(expectations, state.latestAssistantEntryId, "assistant");
	for (const id of state.inbox.steer) addPendingExpectation(pendingExpectations, id, "message", lane);
	for (const id of state.inbox.followUp) addPendingExpectation(pendingExpectations, id, "message", lane);
	for (const id of state.inbox.writes) addPendingExpectation(pendingExpectations, id, "any", lane);
	if (state.control.status === "cancel_requested") {
		for (const id of state.control.drainedSteer) addPendingExpectation(pendingExpectations, id, "message", lane);
		for (const id of state.control.drainedFollowUp) addPendingExpectation(pendingExpectations, id, "message", lane);
	}

	const phase = state.phase;
	if (phase.kind === "checkpoint") {
		addEntryExpectation(expectations, phase.triggerEntryId, "any");
		if (phase.continuation.kind === "need_assistant" && leafId !== phase.triggerEntryId) {
			invariant(lane, "need-assistant checkpoint trigger is not the lane leaf");
		}
		if (phase.continuation.kind === "may_finish" && phase.continuation.includeFinalAssistant) {
			if (state.latestAssistantEntryId === null) invariant(lane, "finish checkpoint has no latest assistant");
			if (phase.triggerEntryId !== state.latestAssistantEntryId) {
				invariant(lane, "finish checkpoint trigger is not the latest assistant");
			}
		}
		return;
	}
	if (phase.kind === "assistant") {
		const generation = phase.generation;
		addEntryExpectation(expectations, generation.context.triggerEntryId, "any");
		validatePositiveInteger(generation.context.retryPolicy.maxAttempts, lane, "generation maxAttempts");
		validateNonNegativeInteger(generation.context.retryPolicy.baseDelayMs, lane, "generation baseDelayMs");
		if (generation.status === "ready") {
			validatePositiveInteger(generation.nextAttempt, lane, "generation nextAttempt");
			if (generation.nextAttempt === 1 && leafId !== generation.context.triggerEntryId) {
				invariant(lane, "initial generation trigger is not the lane leaf");
			}
			if (generation.nextAttempt > generation.context.retryPolicy.maxAttempts) {
				invariant(lane, "generation nextAttempt exceeds maxAttempts");
			}
			return;
		}
		if (generation.status === "retry_wait") {
			validatePositiveInteger(generation.nextAttempt, lane, "generation nextAttempt");
			validateNonNegativeInteger(generation.notBefore, lane, "generation notBefore");
			return;
		}
		validatePositiveInteger(generation.attempt, lane, "generation attempt");
		if (generation.attempt > generation.context.retryPolicy.maxAttempts) {
			invariant(lane, "generation attempt exceeds maxAttempts");
		}
		if (generation.attempt === 1 && leafId !== generation.context.triggerEntryId) {
			invariant(lane, "initial generation trigger is not the lane leaf");
		}
		validateNonNegativeInteger(generation.intendedOutputLimit, lane, "generation intendedOutputLimit");
		validateNonNegativeInteger(generation.contextWindow, lane, "generation contextWindow");
		if (generation.responseEntryId === generation.usageId)
			invariant(lane, "generation response and usage ids collide");
		forbiddenEntries.add(generation.responseEntryId);
		return;
	}
	if (phase.kind === "failure_drain" && phase.provenance.kind === "response") {
		addEntryExpectation(expectations, phase.provenance.entryId, "assistant");
		if (state.latestAssistantEntryId !== phase.provenance.entryId) {
			invariant(lane, "response failure provenance is not the latest assistant");
		}
	}
}

function addEntryExpectation(
	expectations: Map<string, "any" | "message" | "assistant">,
	id: string,
	expected: "any" | "message" | "assistant",
): void {
	const current = expectations.get(id);
	if (current === "assistant" || current === expected) return;
	if (current === "message" && expected === "any") return;
	expectations.set(id, expected);
}

function addPendingExpectation(
	expectations: Map<string, "any" | "message">,
	id: string,
	expected: "any" | "message",
	lane: string,
): void {
	if (expectations.has(id)) invariant(lane, `queues pending entry ${id} more than once`);
	expectations.set(id, expected);
}

function validatePositiveInteger(value: number, lane: string, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) invariant(lane, `${field} is invalid`);
}

function validateNonNegativeInteger(value: number, lane: string, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) invariant(lane, `${field} is invalid`);
}

function invariant(lane: string, message: string): never {
	throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} ${message}`);
}
