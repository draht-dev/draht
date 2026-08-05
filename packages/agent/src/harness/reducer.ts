import { Guard } from "typebox/guard";
import type {
	Entry,
	LaneRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	StepAttemptRecord,
} from "./session/types.ts";

/**
 * Machine-readable category for a contradiction in a lane's durable recovery
 * slice. These indicate states the single-writer record protocol cannot
 * produce, not ordinary operation failures or incomplete-but-recoverable
 * intent/result prefixes. Restore must reject such states rather than repair or
 * continue it; the accompanying error message supplies human-readable detail.
 */
export type RecordLogCorruptionReason =
	| "multiple_open_operations"
	| "unknown_operation"
	| "record_after_finish"
	| "non_consecutive_attempt"
	| "invalid_compaction_reason"
	| "queue_after_abort"
	| "invalid_queue_cancellation"
	| "inconsistent_step"
	| "tool_call_mismatch"
	| "duplicate_tool_invocation"
	| "provisioned_entry_mismatch";

export class RecordLogCorruption extends Error {
	readonly reason: RecordLogCorruptionReason;

	constructor(reason: RecordLogCorruptionReason, message: string) {
		super(message);
		this.name = "RecordLogCorruption";
		this.reason = reason;
	}
}

export interface RecordLogSlice {
	lane: string;
	openOperations: readonly OperationStartedRecord[];
	records: readonly LaneRecord[];
	/** Operation-owned entries plus entries fetched directly by provisioned or referenced ids. */
	entries: readonly Entry[];
}

interface AttemptSeries {
	record: StepAttemptRecord;
}

function corrupt(reason: RecordLogCorruptionReason, message: string): never {
	throw new RecordLogCorruption(reason, message);
}

function hasRunId(record: LaneRecord): record is Exclude<LaneRecord, OperationStartedRecord> & { runId: string } {
	return "runId" in record && typeof record.runId === "string";
}

function matchesProvisionedEntry(entry: Entry, target: ProvisionedEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...payload } = entry;
	return Guard.IsDeepEqual(payload, target);
}

function validateExactProvisionedEntry(entriesById: ReadonlyMap<string, Entry>, target: ProvisionedEntry): void {
	const entry = entriesById.get(target.id);
	if (entry && !matchesProvisionedEntry(entry, target)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned entry ${target.id} exists with content different from its intent`,
		);
	}
}

function validateResultEntry(
	entriesById: ReadonlyMap<string, Entry>,
	resultEntryId: string,
	matches: (entry: Entry) => boolean,
	description: string,
): void {
	const entry = entriesById.get(resultEntryId);
	if (entry && !matches(entry)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned ${description} entry ${resultEntryId} exists with different content`,
		);
	}
}

function validateAttemptReason(record: StepAttemptRecord): void {
	const reason = (record as { compactionReason?: unknown }).compactionReason;
	if (record.step === "compaction") {
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") {
			corrupt("invalid_compaction_reason", `Compaction attempt ${record.id} has no valid compaction reason`);
		}
	} else if (reason !== undefined) {
		corrupt("invalid_compaction_reason", `${record.step} attempt ${record.id} has a compaction reason`);
	}
}

function validateAttemptSequence(
	record: StepAttemptRecord,
	previous: AttemptSeries | undefined,
	entriesById: ReadonlyMap<string, Entry>,
): void {
	const previousRecord = previous?.record;
	const previousResult = previousRecord ? entriesById.get(previousRecord.resultEntryId) : undefined;
	const continuesSeries =
		previousRecord !== undefined &&
		previousRecord.step === record.step &&
		(previousResult === undefined || previousResult.seq >= record.seq);
	const expectedAttempt = continuesSeries ? previousRecord.attempt + 1 : 1;
	if (record.attempt !== expectedAttempt) {
		corrupt(
			"non_consecutive_attempt",
			`${record.step} attempt ${record.id} is ${record.attempt}; expected ${expectedAttempt}`,
		);
	}
	if (!continuesSeries || record.step === "assistant" || previousRecord === undefined) return;
	if (record.resultEntryId !== previousRecord.resultEntryId) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their result entry id`);
	}
	if (record.compactionReason !== previousRecord.compactionReason) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their compaction reason`);
	}
}

function validateAttemptResult(entriesById: ReadonlyMap<string, Entry>, record: StepAttemptRecord): void {
	switch (record.step) {
		case "assistant":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "message" && entry.message.role === "assistant",
				"assistant result",
			);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "compaction",
				"compaction result",
			);
			break;
		case "branch_summary":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "branch_summary",
				"branch-summary result",
			);
			break;
	}
}

function validateToolStart(
	record: Extract<LaneRecord, { type: "tool_started" }>,
	entriesById: ReadonlyMap<string, Entry>,
	invocations: Set<string>,
): void {
	const invocation = `${record.assistantEntryId}\u0000${record.toolIndex}`;
	if (invocations.has(invocation)) {
		corrupt(
			"duplicate_tool_invocation",
			`Tool invocation ${record.assistantEntryId}:${record.toolIndex} is duplicated`,
		);
	}
	invocations.add(invocation);

	const assistantEntry = entriesById.get(record.assistantEntryId);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not reference an assistant entry`);
	}
	const toolCalls = assistantEntry.message.content.filter((content) => content.type === "toolCall");
	const toolCall = toolCalls[record.toolIndex];
	if (!toolCall || toolCall.id !== record.toolCallId || toolCall.name !== record.toolName) {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not match its assistant tool-call ordinal`);
	}

	validateResultEntry(
		entriesById,
		record.resultEntryId,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === record.toolCallId &&
			entry.message.toolName === record.toolName,
		"tool result",
	);
}

function validateOperationResult(entriesById: ReadonlyMap<string, Entry>, record: OperationStartedRecord): void {
	switch (record.intent.kind) {
		case "run":
			for (const target of record.intent.initialMessages) validateExactProvisionedEntry(entriesById, target);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.intent.resultEntryId,
				(entry) => entry.type === "compaction",
				"manual compaction",
			);
			break;
		case "navigation":
			if (record.intent.summaryEntryId) {
				validateResultEntry(
					entriesById,
					record.intent.summaryEntryId,
					(entry) => entry.type === "branch_summary",
					"navigation summary",
				);
			}
			break;
	}
}

/** Validates a bounded lane recovery slice without reading or mutating session state. */
export function validateRecordLog(input: RecordLogSlice): void {
	if (input.openOperations.length > 1) {
		corrupt("multiple_open_operations", `Lane ${input.lane} has at least two open operations`);
	}

	const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
	const starts = new Map<string, OperationStartedRecord>();
	const finishedAt = new Map<string, number>();
	const abortedAt = new Map<string, number>();
	const queueEnqueues = new Map<string, Extract<LaneRecord, { type: "queue_enqueued" }>>();
	const latestAttempt = new Map<string, AttemptSeries>();
	const toolInvocations = new Set<string>();
	const records = [...input.records].sort((left, right) => left.seq - right.seq);

	for (const record of records) {
		if (record.type === "operation_started") {
			starts.set(record.id, record);
			validateOperationResult(entriesById, record);
			continue;
		}

		if (hasRunId(record)) {
			if (!starts.has(record.runId)) {
				corrupt("unknown_operation", `Record ${record.id} references unknown operation ${record.runId}`);
			}
			const finishSeq = finishedAt.get(record.runId);
			if (finishSeq !== undefined && record.seq > finishSeq) {
				corrupt("record_after_finish", `Record ${record.id} follows the finish of operation ${record.runId}`);
			}
		}

		switch (record.type) {
			case "operation_finished":
				finishedAt.set(record.runId, record.seq);
				break;
			case "abort_requested":
				abortedAt.set(record.runId, record.seq);
				break;
			case "step_attempt":
				validateAttemptReason(record);
				validateAttemptSequence(record, latestAttempt.get(record.runId), entriesById);
				validateAttemptResult(entriesById, record);
				latestAttempt.set(record.runId, { record });
				break;
			case "tool_started":
				validateToolStart(record, entriesById, toolInvocations);
				break;
			case "queue_enqueued":
				if (
					record.queue !== "nextRun" &&
					abortedAt.get(record.runId) !== undefined &&
					record.seq > abortedAt.get(record.runId)!
				) {
					corrupt("queue_after_abort", `${record.queue} item ${record.target.id} was enqueued after abort`);
				}
				queueEnqueues.set(record.target.id, record);
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			case "queue_cancelled": {
				const enqueue = queueEnqueues.get(record.entryId);
				if (
					!enqueue ||
					enqueue.seq >= record.seq ||
					enqueue.runId !== record.runId ||
					entriesById.has(record.entryId)
				) {
					corrupt("invalid_queue_cancellation", `Queue cancellation ${record.id} has no pending matching enqueue`);
				}
				break;
			}
			case "write_deferred":
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			case "usage":
				break;
		}
	}
}
