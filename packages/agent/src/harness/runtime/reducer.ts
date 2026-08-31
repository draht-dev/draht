import type { HarnessEvent, LaneSnapshot, LaneWatchEvent } from "../agent-harness.ts";
import type { OperationResultRecord } from "../session/types.ts";

export type LaneSnapshotReduction = LaneSnapshot | { rebase: true };

function matchingOperation(
	snapshot: LaneSnapshot,
	operationId: string,
): NonNullable<LaneSnapshot["operation"]> | undefined {
	return snapshot.operation?.id === operationId ? snapshot.operation : undefined;
}

/** Apply one harness event to a replicated lane snapshot. Navigation completion requires a fresh snapshot. */
export function reduceLaneSnapshot(
	snapshot: LaneSnapshot,
	event: HarnessEvent | LaneWatchEvent,
): LaneSnapshotReduction {
	if ("lane" in event && event.lane !== undefined && event.lane !== snapshot.lane && event.type !== "usage") {
		return snapshot;
	}
	const next = structuredClone(snapshot);
	switch (event.type) {
		case "run_start":
			next.operation = {
				id: event.runId,
				kind: "run",
				startedAt: event.startedAt,
				fromTipId: next.tipId,
				status: "open",
				runningTools: [],
			};
			return next;
		case "compaction_start":
			if (next.operation !== null) return next;
			next.operation = {
				id: event.runId,
				kind: "compaction",
				startedAt: event.startedAt,
				fromTipId: next.tipId,
				status: "open",
				runningTools: [],
			};
			return next;
		case "navigation_start":
			next.operation = {
				id: event.runId,
				kind: "navigation",
				startedAt: event.startedAt,
				fromTipId: next.tipId,
				status: "open",
				runningTools: [],
			};
			return next;
		case "operation_abort":
			if (next.operation?.id === event.operationId) next.operation.status = "aborting";
			return next;
		case "run_resume":
			if (next.operation?.id === event.runId) delete next.operation.deferred;
			return next;
		case "run_suspend":
			if (next.operation?.id === event.runId) {
				next.operation.deferred = { handle: event.deferred, poll: event.poll };
				delete next.operation.streamingMessage;
			}
			return next;
		case "retry_scheduled":
			if (next.operation?.id === event.runId) {
				next.operation.retry = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					nextAttemptAt: event.notBefore,
				};
			}
			return next;
		case "retry_start":
		case "retry_end":
			if (next.operation?.id === event.runId) delete next.operation.retry;
			return next;
		case "message_start":
			if (
				event.runId !== undefined &&
				next.operation?.id === event.runId &&
				event.message.role === "assistant" &&
				event.message.stopReason === "pending"
			) {
				next.operation.streamingMessage = event.message;
			}
			return next;
		case "message_update":
			if (next.operation?.id === event.runId && event.message.role === "assistant") {
				next.operation.streamingMessage = event.message;
			}
			return next;
		case "message_end":
			if (event.runId !== undefined && next.operation?.id === event.runId) {
				delete next.operation.streamingMessage;
			}
			return next;
		case "tool_start":
			if (next.operation?.id === event.runId) {
				next.operation.runningTools.push({
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
			}
			return next;
		case "tool_update": {
			const tool = next.operation?.runningTools.find((candidate) => candidate.toolCallId === event.toolCallId);
			if (tool !== undefined) tool.partialResult = event.partialResult;
			return next;
		}
		case "tool_end":
			if (next.operation?.id === event.runId) {
				next.operation.runningTools = next.operation.runningTools.filter(
					(candidate) => candidate.toolCallId !== event.toolCallId,
				);
			}
			return next;
		case "entry_added": {
			const alreadyPresent = next.transcript.some((entry) => entry.id === event.entry.id);
			if (!alreadyPresent) {
				next.transcript = event.entry.type === "compaction" ? [event.entry] : [...next.transcript, event.entry];
				next.tipId = event.entry.id;
				if (event.entry.type === "message") next.stats.messageCount++;
			}
			return next;
		}
		case "queue_update":
			next.queues = event.queues;
			return next;
		case "usage":
			next.stats.usage = event.totals;
			return next;
		case "config_update":
			if (!("lane" in event) || event.lane !== next.lane) return next;
			switch (event.property) {
				case "model":
					next.configuration.model = event.value;
					break;
				case "thinkingLevel":
					next.configuration.thinkingLevel = event.value;
					break;
				case "activeTools":
					next.configuration.activeToolNames = event.value;
					break;
			}
			return next;
		case "run_end": {
			const operation = matchingOperation(next, event.runId);
			if (operation?.kind !== "run") return next;
			const record: OperationResultRecord = {
				operationId: event.runId,
				kind: "run",
				status: event.status,
				...(event.status === "failed" ? { error: event.error } : {}),
				fromTipId: event.fromTipId,
				tipId: event.tipId,
				startedAt: operation.startedAt,
				endedAt: event.endedAt,
			};
			next.lastResult = record;
			next.operation = null;
			next.tipId = event.tipId;
			return next;
		}
		case "compaction_end": {
			const operation = matchingOperation(next, event.runId);
			if (operation?.kind !== "compaction") return next;
			const record: OperationResultRecord = {
				operationId: event.runId,
				kind: "compaction",
				status: event.status,
				...(event.status === "failed" ? { error: event.error } : {}),
				fromTipId: operation.fromTipId,
				tipId: next.tipId,
				startedAt: operation.startedAt,
				endedAt: event.endedAt,
			};
			next.lastResult = record;
			next.operation = null;
			return next;
		}
		case "navigation_end":
			return { rebase: true };
		case "fault":
			next.faulted = true;
			return next;
		case "handler_error":
		case "turn_start":
		case "turn_end":
		case "value_update":
		case "lane_created":
			return next;
	}
}
