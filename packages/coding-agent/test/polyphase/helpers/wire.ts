import type { ThinkingLevel } from "@draht/agent-core";
import type { JsonObject, StopReason, Usage } from "@draht/ai";
import type { ChildWireRecord, SessionHeaderRecord } from "../../../src/core/polyphase/child-events.ts";
import { NO_UI_APPROVAL_SUFFIX, POLYPHASE_RESULT_TOOL_NAME } from "../../../src/core/polyphase/types.ts";

/** Builders for the JSON wire records `child-events.ts` consumes, for tests only. */

export function usage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

export function sessionHeader(overrides: Partial<SessionHeaderRecord> = {}): SessionHeaderRecord {
	return { type: "session", id: "sess-1", ...overrides };
}

export function agentStart(): ChildWireRecord {
	return { type: "agent_start" };
}

export function assistantStart(provider: string, model: string): ChildWireRecord {
	return {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider,
			model,
			usage: usage(0, 0, 0),
			stopReason: "pending",
			timestamp: Date.now(),
		},
	};
}

export function thinkingStart(contentIndex = 0): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "thinking_start", contentIndex },
	};
}

export function thinkingDelta(contentIndex: number, delta: string): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "thinking_delta", contentIndex, delta },
	};
}

export function thinkingEnd(contentIndex: number, content: string): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "thinking_end", contentIndex, content },
	};
}

export function textStart(contentIndex = 0): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "text_start", contentIndex },
	};
}

export function textDelta(contentIndex: number, delta: string): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "text_delta", contentIndex, delta },
	};
}

export function textEnd(contentIndex: number, content: string): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "text_end", contentIndex, content },
	};
}

export function toolcallStart(id: string, name: string, contentIndex = 0): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: { type: "toolcall_start", contentIndex, id, toolName: name },
	};
}

export function toolcallEnd(id: string, name: string, args: JsonObject, contentIndex = 0): ChildWireRecord {
	return {
		type: "message_update",
		usage: usage(0, 0, 0),
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex,
			toolCall: { type: "toolCall", id, name, arguments: args },
		},
	};
}

export function assistantEnd(
	options: {
		provider?: string;
		model?: string;
		usage?: Usage;
		thinkingLevel?: ThinkingLevel;
		stopReason?: StopReason;
		text?: string;
		errorMessage?: string;
	} = {},
): ChildWireRecord {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: options.text === undefined ? [] : [{ type: "text", text: options.text }],
			api: "anthropic-messages",
			provider: options.provider ?? "anthropic",
			model: options.model ?? "claude-sonnet-5",
			thinkingLevel: options.thinkingLevel,
			usage: options.usage ?? usage(10, 5, 0.001),
			stopReason: options.stopReason ?? "stop",
			errorMessage: options.errorMessage,
			timestamp: Date.now(),
		},
	};
}

export function toolStart(id: string, name: string, args: JsonObject): ChildWireRecord {
	return { type: "tool_execution_start", toolCallId: id, toolName: name, args };
}

export function toolEnd(id: string, name: string, text: string, isError = false): ChildWireRecord {
	return {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: name,
		result: { content: [{ type: "text", text }], isError },
		isError,
	};
}

export function blockedToolEnd(id: string, name: string, reason: string): ChildWireRecord {
	return toolEnd(id, name, `${reason} ${NO_UI_APPROVAL_SUFFIX}`, true);
}

export function resultToolCall(id: string, args: JsonObject): ChildWireRecord[] {
	return [
		toolStart(id, POLYPHASE_RESULT_TOOL_NAME, args),
		toolEnd(id, POLYPHASE_RESULT_TOOL_NAME, JSON.stringify(args), false),
	];
}

export function autoRetryStart(
	attempt: number,
	maxAttempts: number,
	delayMs: number,
	errorMessage: string,
): ChildWireRecord {
	return { type: "auto_retry_start", attempt, maxAttempts, delayMs, errorMessage };
}

export function autoRetryEnd(success: boolean, attempt: number, finalError?: string): ChildWireRecord {
	return { type: "auto_retry_end", success, attempt, finalError };
}

export function compactionStart(reason: "manual" | "threshold" | "overflow" = "manual"): ChildWireRecord {
	return { type: "compaction_start", reason };
}

export function compactionEnd(
	options: { reason?: "manual" | "threshold" | "overflow"; errorMessage?: string } = {},
): ChildWireRecord {
	return {
		type: "compaction_end",
		reason: options.reason ?? "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
		errorMessage: options.errorMessage,
	};
}

export function thinkingLevelChanged(level: ThinkingLevel): ChildWireRecord {
	return { type: "thinking_level_changed", level };
}

export function settled(): ChildWireRecord {
	return { type: "agent_settled" };
}

/** `record` serialized exactly as the child writes it: compact JSON plus a trailing newline. */
export function toLine(record: ChildWireRecord): string {
	return `${JSON.stringify(record)}\n`;
}

export function toLines(records: readonly ChildWireRecord[]): string {
	return records.map(toLine).join("");
}
