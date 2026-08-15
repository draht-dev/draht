import { isRetryableAssistantError } from "@draht/ai";
import { SessionInvariantError } from "./session/session.ts";
import type {
	Entry,
	JsonValue,
	LaneConfiguration,
	LaneLastResult,
	LaneState,
	OperationMeta,
	OperationState,
	RunState,
	SessionReader,
	ToolBatch,
} from "./session/types.ts";

export interface RestoredOperation {
	operation: OperationMeta;
	state: OperationState;
	entries: Map<string, Entry>;
	toolArguments: Map<string, Record<string, JsonValue>>;
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

	const expectations = new Map<string, EntryExpectation>();
	const forbiddenEntries = new Set<string>();
	const pendingExpectations = new Map<string, "any" | "message">();
	const toolArgumentKeys = new Set<string>();
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
				operationId,
				expectations,
				forbiddenEntries,
				pendingExpectations,
				toolArgumentKeys,
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
	const [entries, pendingRegisters, reservedPendingRegisters, toolArgumentRegisters] = await Promise.all([
		reader.getEntries(entryIds),
		Promise.all(
			[...pendingExpectations].map(async ([id, expected]) => ({
				id,
				expected,
				register: await reader.getRegister("pending.entry", id),
			})),
		),
		Promise.all(
			[...forbiddenEntries].map(async (id) => ({
				id,
				register: await reader.getRegister("pending.entry", id),
			})),
		),
		Promise.all(
			[...toolArgumentKeys].map(async (key) => ({
				key,
				register: await reader.getRegister("op.tool_args", key),
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
		if (expected === "toolResult" && entry.type === "message" && entry.message.role !== "toolResult") {
			invariant(lane, `entry ${id} is not a tool result message`);
		}
	}
	if (operationState?.value.kind === "run") {
		await hydrateTerminatedToolChain(reader, operationState.value, entries, lane);
	}
	const toolArguments = new Map<string, Record<string, JsonValue>>();
	for (const item of toolArgumentRegisters) {
		if (item.register === undefined) invariant(lane, `references missing tool arguments ${item.key}`);
		toolArguments.set(item.key, item.register.value);
	}
	if (operationState?.value.kind === "run") {
		validateRunEntries(operationState.value, entries, leaf.value, lane);
	}
	for (const id of forbiddenEntries) {
		if (entries.has(id)) invariant(lane, `reserved entry ${id} already exists`);
	}
	for (const pending of reservedPendingRegisters) {
		if (pending.register !== undefined) invariant(lane, `reserved settlement id ${pending.id} is a pending entry`);
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
			: { current: { operation: operation.value, state: operationState.value, entries, toolArguments } }),
	};
}

type EntryExpectation = "any" | "message" | "assistant" | "toolResult";

function validateRunState(
	state: RunState,
	operationId: string,
	expectations: Map<string, EntryExpectation>,
	forbiddenEntries: Set<string>,
	pendingExpectations: Map<string, "any" | "message">,
	toolArgumentKeys: Set<string>,
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
		if (phase.continuation.kind === "may_finish") {
			if (leafId !== phase.triggerEntryId) invariant(lane, "finish checkpoint trigger is not the lane leaf");
			if (state.latestAssistantEntryId === null) invariant(lane, "finish checkpoint has no latest assistant");
			if (phase.continuation.includeFinalAssistant) {
				if (phase.triggerEntryId !== state.latestAssistantEntryId) {
					invariant(lane, "finish checkpoint trigger is not the latest assistant");
				}
			} else {
				if (phase.triggerEntryId === state.latestAssistantEntryId) {
					invariant(lane, "terminated-tools checkpoint trigger is the latest assistant");
				}
				addEntryExpectation(expectations, phase.triggerEntryId, "toolResult");
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
	if (phase.kind === "tools") {
		validateToolBatchState(state, phase.batch, operationId, expectations, forbiddenEntries, toolArgumentKeys, lane);
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

async function hydrateTerminatedToolChain(
	reader: SessionReader,
	state: RunState,
	entries: Map<string, Entry>,
	lane: string,
): Promise<void> {
	const phase = state.phase;
	if (
		phase.kind !== "checkpoint" ||
		phase.continuation.kind !== "may_finish" ||
		phase.continuation.includeFinalAssistant
	) {
		return;
	}
	const assistantId = state.latestAssistantEntryId;
	const assistant = assistantId === null ? undefined : entries.get(assistantId);
	const newest = entries.get(phase.triggerEntryId);
	if (
		assistantId === null ||
		assistant?.type !== "message" ||
		assistant.message.role !== "assistant" ||
		newest?.type !== "message" ||
		newest.message.role !== "toolResult"
	) {
		invariant(lane, "terminated-tools checkpoint has invalid result provenance");
	}
	if (assistant.message.stopReason !== "toolUse" && assistant.message.stopReason !== "stop") {
		invariant(lane, "terminated-tools checkpoint assistant has an incompatible stop reason");
	}
	const sourceCalls = assistant.message.content.filter((part) => part.type === "toolCall");
	if (sourceCalls.length === 0) invariant(lane, "terminated-tools checkpoint assistant has no tool calls");
	let result = newest;
	for (let sourceIndex = sourceCalls.length - 1; sourceIndex >= 0; sourceIndex--) {
		const source = sourceCalls[sourceIndex]!;
		if (
			result.type !== "message" ||
			result.message.role !== "toolResult" ||
			result.message.toolCallId !== source.id ||
			result.message.toolName !== source.name ||
			result.terminate !== true
		) {
			invariant(lane, `terminated-tools result ${sourceIndex} is invalid`);
		}
		if (sourceIndex === 0) {
			if (result.parentId !== assistantId)
				invariant(lane, "terminated-tools results do not descend from the assistant");
			continue;
		}
		if (result.parentId === null) invariant(lane, "terminated-tools result chain reaches the root");
		let parent = entries.get(result.parentId);
		if (parent === undefined) {
			parent = (await reader.getEntries([result.parentId])).get(result.parentId);
			if (parent !== undefined) entries.set(parent.id, parent);
		}
		if (parent === undefined) invariant(lane, `terminated-tools result parent ${result.parentId} is missing`);
		if (parent.type !== "message" || parent.message.role !== "toolResult") {
			invariant(lane, `terminated-tools result ${sourceIndex - 1} is invalid`);
		}
		result = parent;
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
		state.latestAssistantEntryId !== null
	) {
		const latest = entries.get(state.latestAssistantEntryId);
		if (phase.continuation.includeFinalAssistant) {
			if (
				latest?.type !== "message" ||
				latest.message.role !== "assistant" ||
				(latest.message.stopReason !== "stop" && latest.message.stopReason !== "length")
			) {
				invariant(lane, "finish checkpoint latest assistant has an invalid stop reason");
			}
		} else {
			const trigger = entries.get(phase.triggerEntryId);
			if (
				latest?.type !== "message" ||
				latest.message.role !== "assistant" ||
				trigger?.type !== "message" ||
				trigger.message.role !== "toolResult"
			) {
				invariant(lane, "terminated-tools checkpoint has invalid result provenance");
			}
			const sourceCalls = latest.message.content.filter((part) => part.type === "toolCall");
			const lastSource = sourceCalls.at(-1);
			if (
				lastSource === undefined ||
				trigger.message.toolCallId !== lastSource.id ||
				trigger.message.toolName !== lastSource.name ||
				trigger.terminate !== true
			) {
				invariant(lane, "terminated-tools checkpoint has invalid newest result");
			}
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
	if (phase.kind === "tools") {
		validateToolBatchEntries(phase.batch, entries, leafId, lane);
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

function validateToolBatchState(
	state: RunState,
	batch: ToolBatch,
	operationId: string,
	expectations: Map<string, EntryExpectation>,
	forbiddenEntries: Set<string>,
	toolArgumentKeys: Set<string>,
	lane: string,
): void {
	addEntryExpectation(expectations, batch.assistantEntryId, "assistant");
	if (state.latestAssistantEntryId !== batch.assistantEntryId) {
		invariant(lane, "tool batch assistant is not the latest assistant");
	}
	if (batch.calls.length === 0) invariant(lane, "tool batch has no calls");

	const resultIds = new Set<string>([batch.assistantEntryId]);
	let sawUncompleted = false;
	let pendingCount = 0;
	for (let index = 0; index < batch.calls.length; index++) {
		const call = batch.calls[index]!;
		if (!Number.isSafeInteger(call.sourceIndex) || call.sourceIndex !== index) {
			invariant(lane, "tool batch source indices are not complete and ordered");
		}
		if (resultIds.has(call.resultEntryId)) invariant(lane, `tool result id ${call.resultEntryId} is duplicated`);
		resultIds.add(call.resultEntryId);
		if (!sameUuidV7Timestamp(batch.assistantEntryId, call.resultEntryId)) {
			invariant(lane, `tool result id ${call.resultEntryId} is not a follower of the assistant`);
		}
		if (call.status === "completed") {
			if (sawUncompleted) invariant(lane, "completed tool calls do not form a prefix");
			addEntryExpectation(expectations, call.resultEntryId, "toolResult");
			continue;
		}
		sawUncompleted = true;
		if (forbiddenEntries.has(call.resultEntryId)) {
			invariant(lane, `reserved tool result id ${call.resultEntryId} is duplicated`);
		}
		forbiddenEntries.add(call.resultEntryId);
		if (call.status === "effect_pending") {
			pendingCount++;
			toolArgumentKeys.add(toolArgumentsKey(operationId, batch.turnId, call.sourceIndex));
		}
	}
	if (!sawUncompleted) invariant(lane, "tool batch is fully completed instead of checkpointed");
	if (state.settings.toolExecution === "sequential") {
		if (pendingCount > 1) invariant(lane, "sequential tool batch has multiple pending effects");
		const firstUncompleted = batch.calls.findIndex((call) => call.status !== "completed");
		const suffix = firstUncompleted === -1 ? [] : batch.calls.slice(firstUncompleted);
		const pendingIndex = suffix.findIndex((call) => call.status === "effect_pending");
		if (pendingIndex > 0 || (pendingIndex === 0 && suffix.slice(1).some((call) => call.status !== "planned"))) {
			invariant(lane, "sequential tool batch progress is invalid");
		}
	}
}

function validateToolBatchEntries(
	batch: ToolBatch,
	entries: Map<string, Entry>,
	leafId: string | null,
	lane: string,
): void {
	const assistant = entries.get(batch.assistantEntryId);
	if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
		invariant(lane, "tool batch assistant entry is invalid");
	}
	if (
		assistant.message.stopReason !== "toolUse" &&
		assistant.message.stopReason !== "stop" &&
		assistant.message.stopReason !== "length"
	) {
		invariant(lane, "tool batch assistant has an incompatible stop reason");
	}
	const sourceCalls = assistant.message.content.filter((block) => block.type === "toolCall");
	if (sourceCalls.length !== batch.calls.length) {
		invariant(lane, "tool batch does not cover the assistant tool calls");
	}

	let expectedParentId = batch.assistantEntryId;
	let completedCount = 0;
	for (const call of batch.calls) {
		const source = sourceCalls[call.sourceIndex];
		if (source === undefined) invariant(lane, `tool source index ${call.sourceIndex} is out of range`);
		if (call.status === "effect_pending") {
			if (assistant.message.stopReason === "length") {
				invariant(lane, "genuine-length tool batch has a pending effect");
			}
			if (!batch.configuration.activeToolNames.includes(source.name)) {
				invariant(lane, "pending tool effect is outside the captured active-tool set");
			}
		}
		if (call.status !== "completed") continue;
		const result = entries.get(call.resultEntryId);
		if (result?.type !== "message" || result.message.role !== "toolResult") {
			invariant(lane, `completed tool result ${call.resultEntryId} is invalid`);
		}
		if (result.message.toolCallId !== source.id || result.message.toolName !== source.name) {
			invariant(lane, `completed tool result ${call.resultEntryId} does not match its source call`);
		}
		if ((result.terminate === true) !== call.terminate) {
			invariant(lane, `completed tool result ${call.resultEntryId} has a terminate mismatch`);
		}
		if (assistant.message.stopReason === "length" && (result.message.isError !== true || call.terminate)) {
			invariant(lane, `genuine-length completed result ${call.resultEntryId} is invalid`);
		}
		if (result.parentId !== expectedParentId) {
			invariant(lane, `completed tool result ${call.resultEntryId} has an invalid parent`);
		}
		expectedParentId = result.id;
		completedCount++;
	}
	if (leafId !== expectedParentId) {
		invariant(
			lane,
			completedCount === 0 ? "tool batch assistant is not the lane leaf" : "tool result prefix is not the lane leaf",
		);
	}
}

function toolArgumentsKey(operationId: string, turnId: string, sourceIndex: number): string {
	return `${operationId}:${turnId}:${sourceIndex}`;
}

function sameUuidV7Timestamp(leader: string, follower: string): boolean {
	return leader.length >= 13 && follower.length >= 13 && leader.slice(0, 13) === follower.slice(0, 13);
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
	expectations: Map<string, EntryExpectation>,
	id: string,
	expected: EntryExpectation,
): void {
	const current = expectations.get(id);
	if (current === expected) return;
	if (current === "assistant" || current === "toolResult") return;
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
