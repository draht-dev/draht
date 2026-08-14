import { isRetryableAssistantError } from "@draht/ai";
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

	for (const id of forbiddenEntries) {
		if (pendingExpectations.has(id)) invariant(lane, `reserved settlement id ${id} is also a pending entry`);
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
		validateRunEntries(operationState.value, entries, leaf.value, lane);
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
			if (generation.nextAttempt <= 1) invariant(lane, "generation retry nextAttempt is not later");
			if (generation.nextAttempt > generation.context.retryPolicy.maxAttempts) {
				invariant(lane, "generation retry nextAttempt exceeds maxAttempts");
			}
			validateNonNegativeInteger(generation.notBefore, lane, "generation notBefore");
			if (generation.errorMessage.length === 0) invariant(lane, "generation retry errorMessage is empty");
			if (state.latestAssistantEntryId === null) invariant(lane, "generation retry has no latest assistant");
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
		forbiddenEntries.add(generation.usageId);
		return;
	}
	if (phase.kind === "deferred") {
		validateNonNegativeInteger(phase.deferred.poll, lane, "deferred poll");
		addEntryExpectation(expectations, phase.deferred.sourceEntryId, "assistant");
		if (phase.deferred.status === "effect_pending") {
			if (phase.deferred.responseEntryId === phase.deferred.usageId) {
				invariant(lane, "deferred response and usage ids collide");
			}
			forbiddenEntries.add(phase.deferred.responseEntryId);
			forbiddenEntries.add(phase.deferred.usageId);
		}
		return;
	}
	if (phase.kind === "failure_drain" && phase.provenance.kind === "response") {
		addEntryExpectation(expectations, phase.provenance.entryId, "assistant");
		if (state.latestAssistantEntryId !== phase.provenance.entryId) {
			invariant(lane, "response failure provenance is not the latest assistant");
		}
	}
}

function validateRunEntries(state: RunState, entries: Map<string, Entry>, leafId: string | null, lane: string): void {
	const phase = state.phase;
	if (state.control.status === "running" && state.latestAssistantEntryId !== null) {
		const latest = entries.get(state.latestAssistantEntryId);
		if (
			latest?.type === "message" &&
			latest.message.role === "assistant" &&
			latest.message.stopReason === "aborted"
		) {
			invariant(lane, "running operation references an aborted assistant response");
		}
	}
	if (phase.kind === "assistant") {
		const generation = phase.generation;
		const attempt = generation.status === "effect_pending" ? generation.attempt : generation.nextAttempt;
		if (attempt > 1) {
			validateLaterGenerationOrigin(
				state,
				generation.context.triggerEntryId,
				entries,
				leafId,
				generation.status !== "retry_wait",
				generation.status !== "retry_wait",
				lane,
			);
		}
	}
	if (
		state.control.status === "running" &&
		phase.kind === "checkpoint" &&
		phase.continuation.kind === "may_finish" &&
		phase.continuation.includeFinalAssistant &&
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
	if (phase.kind === "assistant" && phase.generation.status === "retry_wait") {
		const latestId = state.latestAssistantEntryId;
		const latest = latestId === null ? undefined : entries.get(latestId);
		if (latestId === null || leafId !== latestId) invariant(lane, "generation retry response is not the lane leaf");
		if (latest?.type !== "message" || latest.message.role !== "assistant" || latest.message.stopReason !== "error") {
			invariant(lane, "generation retry latest assistant is not an error response");
		}
		if (latest.message.errorMessage !== phase.generation.errorMessage) {
			invariant(lane, "generation retry error does not match its response");
		}
		if (!isRetryableAssistantError(latest.message)) {
			invariant(lane, "generation retry latest assistant is not retryable");
		}
	}
	if (phase.kind === "deferred") {
		const sourceId = phase.deferred.sourceEntryId;
		const source = entries.get(sourceId);
		if (state.latestAssistantEntryId !== sourceId) invariant(lane, "deferred source is not the latest assistant");
		if (leafId !== sourceId) invariant(lane, "deferred source is not the lane leaf");
		if (source?.type !== "message" || source.message.role !== "assistant") {
			invariant(lane, "deferred source is not an assistant response");
		}
		const message = source.message;
		const handle = message.deferred;
		if (message.stopReason !== "deferred" || handle === undefined || handle.id.length === 0) {
			invariant(lane, "deferred source has no valid handle");
		}
		if (
			handle.provider !== phase.deferred.configuration.model.provider ||
			handle.modelId !== phase.deferred.configuration.model.modelId
		) {
			invariant(lane, "deferred source identity does not match its captured model");
		}
	}
	if (phase.kind === "failure_drain" && phase.provenance.kind === "response") {
		const response = entries.get(phase.provenance.entryId);
		if (
			response?.type !== "message" ||
			response.message.role !== "assistant" ||
			(state.control.status === "running" && response.message.stopReason !== "error")
		) {
			invariant(lane, "response failure provenance is not an assistant error");
		}
	}
}

function validateLaterGenerationOrigin(
	state: RunState,
	triggerEntryId: string,
	entries: Map<string, Entry>,
	leafId: string | null,
	allowUnknownEffectOrigin: boolean,
	validateRetryableOrigin: boolean,
	lane: string,
): void {
	const trigger = entries.get(triggerEntryId);
	if (trigger === undefined) invariant(lane, "later generation trigger is missing");
	const latestId = state.latestAssistantEntryId;
	if (allowUnknownEffectOrigin && leafId === triggerEntryId) {
		const latest = latestId === null ? undefined : entries.get(latestId);
		if (latest !== undefined && latest.seq > trigger.seq) {
			invariant(lane, "uncertain later generation has a post-trigger assistant response");
		}
		return;
	}
	if (latestId === null || leafId !== latestId) {
		invariant(lane, "later generation has neither an uncertain trigger nor a settled retry response");
	}
	const latest = entries.get(latestId);
	if (latest === undefined || latest.seq <= trigger.seq) {
		invariant(lane, "later generation retry response is not later than its trigger");
	}
	if (
		validateRetryableOrigin &&
		(latest.type !== "message" ||
			latest.message.role !== "assistant" ||
			latest.message.stopReason !== "error" ||
			!isRetryableAssistantError(latest.message))
	) {
		invariant(lane, "later generation retry origin is not a retryable assistant error");
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
