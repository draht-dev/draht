import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@draht/ai";
import { describe, expect, it } from "vitest";
import {
	RecordLogCorruption,
	type RecordLogCorruptionReason,
	type RecordLogSlice,
	validateRecordLog,
} from "../../src/harness/reducer.ts";
import type {
	AbortRequestedRecord,
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	LaneRecord,
	MessageEntry,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueCancelledRecord,
	QueueEnqueuedRecord,
	SessionStopReason,
	StepAttemptRecord,
	ToolStartedRecord,
	UsageRecord,
	WriteDeferredRecord,
} from "../../src/harness/session/types.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage,
		stopReason,
		timestamp: 1,
		...(stopReason === "deferred"
			? { deferred: { provider: "openai", modelId: "test-model", api: "openai-responses", id: "deferred-1" } }
			: {}),
	};
}

function toolResultMessage(toolCallId = "call-1", toolName = "tool-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 1,
	};
}

function messageTarget(
	id: string,
	message: UserMessage | AssistantMessage | ToolResultMessage,
): ProvisionedEntry<MessageEntry> {
	return { type: "message", id, message };
}

function persistedEntry<TEntry extends Entry>(
	target: ProvisionedEntry<TEntry>,
	seq: number,
	parentId: string | null = null,
): TEntry {
	return { ...target, parentId, seq, timestamp: seq } as unknown as TEntry;
}

function runStarted(
	seq = 1,
	options: { id?: string; initialMessages?: ProvisionedEntry[] } = {},
): OperationStartedRecord {
	return {
		type: "operation_started",
		id: options.id ?? "run-1",
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: options.initialMessages ?? [] },
	};
}

function compactionStarted(seq: number, resultEntryId = "compaction-1"): OperationStartedRecord {
	return {
		type: "operation_started",
		id: "compact-1",
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: "source",
		intent: { kind: "compaction", resultEntryId },
	};
}

function navigationStarted(seq: number, summaryEntryId = "summary-1"): OperationStartedRecord {
	return {
		type: "operation_started",
		id: "navigate-1",
		lane: "main",
		seq,
		timestamp: seq,
		sourceLeafId: "source",
		intent: { kind: "navigation", targetId: "target", summarize: true, summaryEntryId },
	};
}

function attempt(
	seq: number,
	runId: string,
	step: StepAttemptRecord["step"],
	attemptNumber: number,
	resultEntryId: string,
	compactionReason?: "manual" | "threshold" | "overflow",
): StepAttemptRecord {
	const base = {
		type: "step_attempt" as const,
		id: `attempt-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		runId,
		attempt: attemptNumber,
		resultEntryId,
	};
	return step === "compaction" ? { ...base, step, compactionReason: compactionReason ?? "manual" } : { ...base, step };
}

function abortRequested(seq: number, runId = "run-1"): AbortRequestedRecord {
	return { type: "abort_requested", id: `abort-${seq}`, lane: "main", seq, timestamp: seq, runId };
}

function operationFinished(
	seq: number,
	runId = "run-1",
	outcome: OperationFinishedRecord["outcome"] = "completed",
): OperationFinishedRecord {
	return { type: "operation_finished", id: `finish-${seq}`, lane: "main", seq, timestamp: seq, runId, outcome };
}

function toolStarted(
	seq: number,
	overrides: Partial<
		Pick<ToolStartedRecord, "assistantEntryId" | "toolIndex" | "toolCallId" | "toolName" | "resultEntryId">
	> = {},
): ToolStartedRecord {
	return {
		type: "tool_started",
		id: `tool-start-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		runId: "run-1",
		assistantEntryId: overrides.assistantEntryId ?? "assistant-tools",
		toolIndex: overrides.toolIndex ?? 0,
		toolCallId: overrides.toolCallId ?? "call-1",
		toolName: overrides.toolName ?? "tool-1",
		effectiveArgs: {},
		resultEntryId: overrides.resultEntryId ?? "tool-result-1",
		replay: "never",
	};
}

function queueEnqueued(
	seq: number,
	target: ProvisionedEntry = messageTarget("queue-1", userMessage("queued")),
	queue: QueueEnqueuedRecord["queue"] = "steer",
): QueueEnqueuedRecord {
	const base = { type: "queue_enqueued" as const, id: `queue-${seq}`, lane: "main", seq, timestamp: seq, target };
	return queue === "nextRun" ? { ...base, queue } : { ...base, queue, runId: "run-1" };
}

function queueCancelled(seq: number, entryId = "queue-1", runId: string | null = "run-1"): QueueCancelledRecord {
	return {
		type: "queue_cancelled",
		id: `cancel-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		entryId,
		...(runId === null ? {} : { runId }),
	};
}

function writeDeferred(
	seq: number,
	target: ProvisionedEntry = messageTarget("write-1", userMessage("deferred write")),
): WriteDeferredRecord {
	return { type: "write_deferred", id: `write-${seq}`, lane: "main", seq, timestamp: seq, runId: "run-1", target };
}

function usageRecord(
	seq: number,
	resultEntryId: string,
	stopReason: SessionStopReason = "error",
	attemptNumber = 1,
): UsageRecord {
	return {
		type: "usage",
		id: `usage-${seq}`,
		lane: "main",
		seq,
		timestamp: seq,
		cause: "assistant",
		runId: "run-1",
		entryId: resultEntryId,
		attempt: attemptNumber,
		stopReason,
		usage,
	};
}

function compactionEntry(id: string, seq: number): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		seq,
		timestamp: seq,
		summary: "summary",
		retainedTail: [],
		tokensBefore: 10,
	};
}

function branchSummaryEntry(id: string, seq: number): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id,
		parentId: "target",
		seq,
		timestamp: seq,
		fromId: "source",
		summary: "summary",
	};
}

function recoverySlice(records: readonly LaneRecord[], entries: readonly Entry[] = []): RecordLogSlice {
	const finished = new Set(
		records
			.filter((record): record is OperationFinishedRecord => record.type === "operation_finished")
			.map((record) => record.runId),
	);
	const openOperations = records
		.filter(
			(record): record is OperationStartedRecord => record.type === "operation_started" && !finished.has(record.id),
		)
		.sort((left, right) => right.seq - left.seq);
	return { lane: "main", openOperations, records, entries };
}

function expectCorruption(input: RecordLogSlice, reason: RecordLogCorruptionReason): void {
	try {
		validateRecordLog(input);
		expect.fail(`Expected ${reason}`);
	} catch (error) {
		expect(error).toBeInstanceOf(RecordLogCorruption);
		expect(error).toMatchObject({ reason });
	}
}

const assistantToolsEntry = persistedEntry(
	messageTarget(
		"assistant-tools",
		assistantMessage([{ type: "toolCall", id: "call-1", name: "tool-1", arguments: {} }], "toolUse"),
	),
	3,
);

interface CorruptionCase {
	name: string;
	reason: RecordLogCorruptionReason;
	input: RecordLogSlice;
}

const corruptionCases: CorruptionCase[] = [
	{
		name: "multiple operations are open",
		reason: "multiple_open_operations",
		input: recoverySlice([runStarted(1), runStarted(2, { id: "run-2" })]),
	},
	{
		name: "a record references an operation that does not exist",
		reason: "unknown_operation",
		input: recoverySlice([abortRequested(1, "missing")]),
	},
	{
		name: "a record follows its operation finish",
		reason: "record_after_finish",
		input: recoverySlice([runStarted(1), operationFinished(2), abortRequested(3)]),
	},
	{
		name: "attempt numbers skip within one assistant step",
		reason: "non_consecutive_attempt",
		input: recoverySlice([
			runStarted(1),
			attempt(2, "run-1", "assistant", 1, "assistant-1"),
			attempt(3, "run-1", "assistant", 3, "assistant-2"),
		]),
	},
	{
		name: "a non-compaction attempt carries compactionReason",
		reason: "invalid_compaction_reason",
		input: recoverySlice([
			runStarted(1),
			{ ...attempt(2, "run-1", "assistant", 1, "assistant-1"), compactionReason: "manual" } as unknown as LaneRecord,
		]),
	},
	{
		name: "a compaction attempt omits compactionReason",
		reason: "invalid_compaction_reason",
		input: recoverySlice([
			runStarted(1),
			{
				...attempt(2, "run-1", "compaction", 1, "compaction-1"),
				compactionReason: undefined,
			} as unknown as LaneRecord,
		]),
	},
	{
		name: "steering is enqueued after abort",
		reason: "queue_after_abort",
		input: recoverySlice([runStarted(1), abortRequested(2), queueEnqueued(3)]),
	},
	{
		name: "a queue cancellation has no enqueue",
		reason: "invalid_queue_cancellation",
		input: recoverySlice([runStarted(1), queueCancelled(2)]),
	},
	{
		name: "a queue cancellation targets an entry that exists",
		reason: "invalid_queue_cancellation",
		input: recoverySlice(
			[runStarted(1), queueEnqueued(2), queueCancelled(4)],
			[persistedEntry(messageTarget("queue-1", userMessage("queued")), 3)],
		),
	},
	{
		name: "structural attempts disagree on resultEntryId",
		reason: "inconsistent_step",
		input: recoverySlice([
			runStarted(1),
			attempt(2, "run-1", "compaction", 1, "compaction-1", "threshold"),
			attempt(3, "run-1", "compaction", 2, "compaction-2", "threshold"),
		]),
	},
	{
		name: "structural attempts disagree on compactionReason",
		reason: "inconsistent_step",
		input: recoverySlice([
			runStarted(1),
			attempt(2, "run-1", "compaction", 1, "compaction-1", "threshold"),
			attempt(3, "run-1", "compaction", 2, "compaction-1", "overflow"),
		]),
	},
	{
		name: "tool_started does not match the assistant tool call",
		reason: "tool_call_mismatch",
		input: recoverySlice([runStarted(1), toolStarted(4, { toolCallId: "different-call" })], [assistantToolsEntry]),
	},
	{
		name: "two tool_started records share an invocation identity",
		reason: "duplicate_tool_invocation",
		input: recoverySlice(
			[
				runStarted(1),
				toolStarted(4),
				{ ...toolStarted(5, { resultEntryId: "tool-result-2" }), id: "tool-start-duplicate" },
			],
			[assistantToolsEntry],
		),
	},
	{
		name: "a provisioned id exists with different content",
		reason: "provisioned_entry_mismatch",
		input: recoverySlice(
			[runStarted(1, { initialMessages: [messageTarget("prompt-1", userMessage("expected"))] })],
			[persistedEntry(messageTarget("prompt-1", userMessage("different")), 2)],
		),
	},
];

describe("record-log validity", () => {
	it.each(corruptionCases)("rejects $name", ({ input, reason }) => {
		expectCorruption(input, reason);
	});

	it("does not mutate its bounded recovery inputs", () => {
		const target = messageTarget("prompt-1", userMessage("hello"));
		const start = Object.freeze(runStarted(1, { initialMessages: [target] }));
		const entry = Object.freeze(persistedEntry(target, 2));
		const input = Object.freeze({
			lane: "main",
			openOperations: Object.freeze([start]),
			records: Object.freeze([start]),
			entries: Object.freeze([entry]),
		});

		expect(validateRecordLog(input)).toBeUndefined();
		expect(input.records).toEqual([start]);
		expect(input.entries).toEqual([entry]);
	});
});

type DurableAction = { record: LaneRecord } | { entry: Entry };

function validPrefixes(trace: string, actions: readonly DurableAction[]): { name: string; input: RecordLogSlice }[] {
	return actions.map((_, index) => {
		const prefix = actions.slice(0, index + 1);
		return {
			name: `${trace} after action ${index + 1}`,
			input: recoverySlice(
				prefix.flatMap((action) => ("record" in action ? [action.record] : [])),
				prefix.flatMap((action) => ("entry" in action ? [action.entry] : [])),
			),
		};
	});
}

const promptTarget = messageTarget("prompt-1", userMessage("fix the bug"));
const assistantToolTarget = messageTarget(
	"assistant-tools",
	assistantMessage([{ type: "toolCall", id: "call-1", name: "tool-1", arguments: {} }], "toolUse"),
);
const toolResultTarget = messageTarget("tool-result-1", toolResultMessage());
const assistantFinalTarget = messageTarget("assistant-final", assistantMessage([{ type: "text", text: "done" }]));

const validPrefixCases = [
	...validPrefixes("one-tool run X1-X5", [
		{ record: runStarted(1, { initialMessages: [promptTarget] }) },
		{ entry: persistedEntry(promptTarget, 2) },
		{ record: attempt(3, "run-1", "assistant", 1, "assistant-tools") },
		{ entry: persistedEntry(assistantToolTarget, 4, "prompt-1") },
		{ record: toolStarted(5) },
		{ entry: persistedEntry(toolResultTarget, 6, "assistant-tools") },
		{ record: attempt(7, "run-1", "assistant", 1, "assistant-final") },
		{ entry: persistedEntry(assistantFinalTarget, 8, "tool-result-1") },
		{ record: operationFinished(9) },
	]),
	...validPrefixes("assistant retry", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-attempt-1") },
		{ record: usageRecord(3, "assistant-attempt-1") },
		{ record: attempt(4, "run-1", "assistant", 2, "assistant-attempt-2") },
		{ record: usageRecord(5, "assistant-attempt-2", "stop", 2) },
		{
			entry: persistedEntry(
				messageTarget("assistant-attempt-2", assistantMessage([{ type: "text", text: "ok" }])),
				6,
			),
		},
	]),
	...validPrefixes("terminal assistant failure", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-error") },
		{
			entry: persistedEntry(
				messageTarget("assistant-error", { ...assistantMessage([], "error"), errorMessage: "failed" }),
				3,
			),
		},
		{ record: operationFinished(4, "run-1", "failed") },
	]),
	...validPrefixes("overflow compaction and retry", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "discarded-overflow") },
		{ record: usageRecord(3, "discarded-overflow", "length") },
		{ record: attempt(4, "run-1", "compaction", 1, "overflow-compaction", "overflow") },
		{ entry: compactionEntry("overflow-compaction", 5) },
		{ record: attempt(6, "run-1", "assistant", 1, "assistant-after-compaction") },
		{
			entry: persistedEntry(
				messageTarget("assistant-after-compaction", assistantMessage([{ type: "text", text: "fits" }])),
				7,
			),
		},
	]),
	...validPrefixes("steering acceptance and consumption", [
		{ record: runStarted(1) },
		{ record: queueEnqueued(2) },
		{ entry: persistedEntry(messageTarget("queue-1", userMessage("queued")), 3) },
	]),
	...validPrefixes("queue cancellation", [
		{ record: runStarted(1) },
		{ record: queueEnqueued(2) },
		{ record: queueCancelled(3) },
	]),
	...validPrefixes("deferred write acceptance and application", [
		{ record: runStarted(1) },
		{ record: writeDeferred(2) },
		{ entry: persistedEntry(messageTarget("write-1", userMessage("deferred write")), 3) },
	]),
	...validPrefixes("abort during a tool", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-tools") },
		{ entry: persistedEntry(assistantToolTarget, 3) },
		{ record: toolStarted(4) },
		{ record: abortRequested(5) },
		{
			entry: persistedEntry(
				messageTarget("tool-result-1", {
					...toolResultMessage(),
					content: [{ type: "text", text: "interrupted" }],
					isError: true,
				}),
				6,
			),
		},
	]),
	...validPrefixes("threshold auto-compaction", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "compaction", 1, "threshold-compaction", "threshold") },
		{ entry: compactionEntry("threshold-compaction", 3) },
		{ record: attempt(4, "run-1", "assistant", 1, "assistant-after-threshold") },
	]),
	...validPrefixes("manual compaction", [
		{ record: compactionStarted(1) },
		{ record: attempt(2, "compact-1", "compaction", 1, "compaction-1", "manual") },
		{ entry: compactionEntry("compaction-1", 3) },
		{ record: operationFinished(4, "compact-1") },
	]),
	...validPrefixes("move-first navigation summary", [
		{ record: navigationStarted(1) },
		{ record: attempt(2, "navigate-1", "branch_summary", 1, "summary-1") },
		{ entry: branchSummaryEntry("summary-1", 3) },
		{ record: operationFinished(4, "navigate-1") },
	]),
	...validPrefixes("blocked tool without an intent record", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-tools") },
		{ entry: persistedEntry(assistantToolTarget, 3) },
		{
			entry: persistedEntry(
				messageTarget("blocked-result", {
					...toolResultMessage(),
					content: [{ type: "text", text: "blocked" }],
					isError: true,
				}),
				4,
			),
		},
	]),
	...validPrefixes("idle next-run cancellation", [
		{ record: queueEnqueued(1, messageTarget("next-1", userMessage("later")), "nextRun") },
		{ record: queueCancelled(2, "next-1", null) },
	]),
	...validPrefixes("next-run enqueue after abort", [
		{ record: runStarted(1) },
		{ record: abortRequested(2) },
		{ record: queueEnqueued(3, messageTarget("next-1", userMessage("later")), "nextRun") },
	]),
	...validPrefixes("deferred write applied during abort reconciliation", [
		{ record: runStarted(1) },
		{ record: writeDeferred(2) },
		{ record: abortRequested(3) },
		{ entry: persistedEntry(messageTarget("write-1", userMessage("deferred write")), 4) },
	]),
	...validPrefixes("accepted steering killed by abort", [
		{ record: runStarted(1) },
		{ record: queueEnqueued(2) },
		{ record: abortRequested(3) },
	]),
	...validPrefixes("compaction retry", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "compaction", 1, "threshold-compaction", "threshold") },
		{ record: attempt(3, "run-1", "compaction", 2, "threshold-compaction", "threshold") },
		{ entry: compactionEntry("threshold-compaction", 4) },
	]),
	...validPrefixes("hook-supplied manual compaction", [
		{ record: compactionStarted(1) },
		{ entry: compactionEntry("compaction-1", 2) },
		{ record: operationFinished(3, "compact-1") },
	]),
	...validPrefixes("hook-supplied navigation summary", [
		{ record: navigationStarted(1) },
		{ entry: branchSummaryEntry("summary-1", 2) },
		{ record: operationFinished(3, "navigate-1") },
	]),
	...validPrefixes("deferred provider suspension and redemption", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-deferred") },
		{ entry: persistedEntry(messageTarget("assistant-deferred", assistantMessage([], "deferred")), 3) },
		{
			entry: persistedEntry(
				messageTarget("assistant-redeemed", assistantMessage([{ type: "text", text: "ready" }])),
				4,
			),
		},
	]),
	...validPrefixes("abort of a deferred provider request", [
		{ record: runStarted(1) },
		{ record: attempt(2, "run-1", "assistant", 1, "assistant-deferred") },
		{ entry: persistedEntry(messageTarget("assistant-deferred", assistantMessage([], "deferred")), 3) },
		{ record: abortRequested(4) },
	]),
];

describe("valid section 6 durable prefixes", () => {
	it.each(validPrefixCases)("accepts $name", ({ input }) => {
		expect(validateRecordLog(input)).toBeUndefined();
	});
});
