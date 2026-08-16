import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "../types.ts";
import { parseStreamingJson } from "./json-parse.ts";

/**
 * Compact, replayable representation of an assistant-message streaming event.
 * Terminal settlement is intentionally excluded and must be persisted separately.
 */
export type AssistantMessageFrame =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; content: TextContent }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; textSignature?: string }
	| { type: "thinking_start"; contentIndex: number; content: ThinkingContent }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			thinkingSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; toolCall: ToolCall }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| {
			type: "toolcall_end";
			contentIndex: number;
			id: string;
			name: string;
			arguments: ToolCall["arguments"];
			thoughtSignature?: string;
			namespace?: string;
	  };

type BlockState =
	| { kind: "text"; ended: boolean }
	| { kind: "thinking"; ended: boolean }
	| { kind: "toolCall"; ended: boolean; json: string };

function cloneTextContent(content: TextContent): TextContent {
	return {
		type: "text",
		text: content.text,
		...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
	};
}

function cloneThinkingContent(content: ThinkingContent): ThinkingContent {
	return {
		type: "thinking",
		thinking: content.thinking,
		...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
		...(content.redacted === undefined ? {} : { redacted: content.redacted }),
	};
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return {
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: structuredClone(toolCall.arguments),
		...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: toolCall.thoughtSignature }),
		...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
	};
}

function cloneContentBlock(content: AssistantMessage["content"][number]): AssistantMessage["content"][number] {
	switch (content.type) {
		case "text":
			return cloneTextContent(content);
		case "thinking":
			return cloneThinkingContent(content);
		case "toolCall":
			return cloneToolCall(content);
	}
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: message.content.map(cloneContentBlock),
		api: message.api,
		provider: message.provider,
		model: message.model,
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		...(message.diagnostics === undefined ? {} : { diagnostics: structuredClone(message.diagnostics) }),
		usage: structuredClone(message.usage),
		stopReason: message.stopReason,
		...(message.deferred === undefined ? {} : { deferred: structuredClone(message.deferred) }),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
		...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
		timestamp: message.timestamp,
	};
}

function assertContentIndex(contentIndex: number): void {
	if (!Number.isSafeInteger(contentIndex) || contentIndex < 0) {
		throw new Error(`Invalid assistant message frame contentIndex: ${contentIndex}`);
	}
}

function eventBlock(event: Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }>) {
	assertContentIndex(event.contentIndex);
	const block = event.partial.content[event.contentIndex];
	if (!block) {
		throw new Error(`${event.type} event has no content block at index ${event.contentIndex}`);
	}
	return block;
}

/** Convert a streaming event to a compact frame. `done` and `error` settle separately. */
export function assistantMessageEventToFrame(event: AssistantMessageEvent): AssistantMessageFrame | undefined {
	switch (event.type) {
		case "start":
			return { type: "start", partial: cloneAssistantMessage(event.partial) };
		case "text_start": {
			const content = eventBlock(event);
			if (content.type !== "text") {
				throw new Error(`text_start event points to ${content.type} block at index ${event.contentIndex}`);
			}
			return { type: "text_start", contentIndex: event.contentIndex, content: cloneTextContent(content) };
		}
		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "text_end": {
			const content = eventBlock(event);
			if (content.type !== "text") {
				throw new Error(`text_end event points to ${content.type} block at index ${event.contentIndex}`);
			}
			return {
				type: "text_end",
				contentIndex: event.contentIndex,
				content: event.content,
				...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
			};
		}
		case "thinking_start": {
			const content = eventBlock(event);
			if (content.type !== "thinking") {
				throw new Error(`thinking_start event points to ${content.type} block at index ${event.contentIndex}`);
			}
			return {
				type: "thinking_start",
				contentIndex: event.contentIndex,
				content: cloneThinkingContent(content),
			};
		}
		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end": {
			const content = eventBlock(event);
			if (content.type !== "thinking") {
				throw new Error(`thinking_end event points to ${content.type} block at index ${event.contentIndex}`);
			}
			return {
				type: "thinking_end",
				contentIndex: event.contentIndex,
				content: event.content,
				...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
				...(content.redacted === undefined ? {} : { redacted: content.redacted }),
			};
		}
		case "toolcall_start": {
			const content = eventBlock(event);
			if (content.type !== "toolCall") {
				throw new Error(`toolcall_start event points to ${content.type} block at index ${event.contentIndex}`);
			}
			return { type: "toolcall_start", contentIndex: event.contentIndex, toolCall: cloneToolCall(content) };
		}
		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end": {
			const content = eventBlock(event);
			if (content.type !== "toolCall") {
				throw new Error(`toolcall_end event points to ${content.type} block at index ${event.contentIndex}`);
			}
			if (event.toolCall.type !== "toolCall") {
				throw new Error(`toolcall_end event has invalid tool call at index ${event.contentIndex}`);
			}
			return {
				type: "toolcall_end",
				contentIndex: event.contentIndex,
				id: event.toolCall.id,
				name: event.toolCall.name,
				arguments: structuredClone(event.toolCall.arguments),
				...(event.toolCall.thoughtSignature === undefined
					? {}
					: { thoughtSignature: event.toolCall.thoughtSignature }),
				...(event.toolCall.namespace === undefined ? {} : { namespace: event.toolCall.namespace }),
			};
		}
		case "done":
		case "error":
			return undefined;
	}
}

function appendBlock(
	message: AssistantMessage,
	states: Map<number, BlockState>,
	contentIndex: number,
	block: TextContent | ThinkingContent | ToolCall,
	state: BlockState,
): void {
	assertContentIndex(contentIndex);
	if (contentIndex !== message.content.length) {
		const reason = contentIndex < message.content.length ? "already exists" : "would leave a gap";
		throw new Error(`Cannot start assistant message block at index ${contentIndex}: ${reason}`);
	}
	message.content.push(structuredClone(block));
	states.set(contentIndex, state);
}

function activeBlock(
	message: AssistantMessage,
	states: Map<number, BlockState>,
	contentIndex: number,
	expectedKind: BlockState["kind"],
	frameType: AssistantMessageFrame["type"],
): { block: TextContent | ThinkingContent | ToolCall; state: BlockState } {
	assertContentIndex(contentIndex);
	const state = states.get(contentIndex);
	const block = message.content[contentIndex];
	if (!state || !block) {
		throw new Error(`${frameType} frame has no started block at index ${contentIndex}`);
	}
	if (state.kind !== expectedKind || block.type !== expectedKind) {
		throw new Error(
			`${frameType} frame expected ${expectedKind} block at index ${contentIndex}, found ${block.type}`,
		);
	}
	if (state.ended) {
		throw new Error(`${frameType} frame follows the end of block at index ${contentIndex}`);
	}
	return { block, state };
}

/**
 * Replay compact frames into an assistant message without mutating the frames.
 * Returns undefined when the iterable has no start frame. Frames for different
 * content indexes may be interleaved, but every block must have a valid start sequence.
 */
export function reduceAssistantMessageFrames(frames: Iterable<AssistantMessageFrame>): AssistantMessage | undefined {
	const replayFrames = [...frames];
	if (!replayFrames.some((frame) => frame.type === "start")) return undefined;

	let message: AssistantMessage | undefined;
	const states = new Map<number, BlockState>();

	for (const frame of replayFrames) {
		if (frame.type === "start") {
			if (message) {
				throw new Error("Assistant message frame sequence contains more than one start frame");
			}
			message = structuredClone(frame.partial);
			continue;
		}
		if (!message) {
			throw new Error(`${frame.type} frame appears before the start frame`);
		}

		switch (frame.type) {
			case "text_start":
				if (frame.content.type !== "text") {
					throw new Error(`text_start frame contains ${frame.content.type} content`);
				}
				appendBlock(message, states, frame.contentIndex, frame.content, { kind: "text", ended: false });
				break;
			case "text_delta": {
				const { block } = activeBlock(message, states, frame.contentIndex, "text", frame.type);
				if (block.type !== "text") throw new Error("Unreachable text frame state");
				block.text += frame.delta;
				break;
			}
			case "text_end": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "text", frame.type);
				if (block.type !== "text") throw new Error("Unreachable text frame state");
				block.text = frame.content;
				delete block.textSignature;
				if (frame.textSignature !== undefined) block.textSignature = frame.textSignature;
				state.ended = true;
				break;
			}
			case "thinking_start":
				if (frame.content.type !== "thinking") {
					throw new Error(`thinking_start frame contains ${frame.content.type} content`);
				}
				appendBlock(message, states, frame.contentIndex, frame.content, {
					kind: "thinking",
					ended: false,
				});
				break;
			case "thinking_delta": {
				const { block } = activeBlock(message, states, frame.contentIndex, "thinking", frame.type);
				if (block.type !== "thinking") throw new Error("Unreachable thinking frame state");
				block.thinking += frame.delta;
				break;
			}
			case "thinking_end": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "thinking", frame.type);
				if (block.type !== "thinking") throw new Error("Unreachable thinking frame state");
				block.thinking = frame.content;
				delete block.thinkingSignature;
				delete block.redacted;
				if (frame.thinkingSignature !== undefined) block.thinkingSignature = frame.thinkingSignature;
				if (frame.redacted !== undefined) block.redacted = frame.redacted;
				state.ended = true;
				break;
			}
			case "toolcall_start":
				if (frame.toolCall.type !== "toolCall") {
					throw new Error(`toolcall_start frame contains ${frame.toolCall.type} content`);
				}
				appendBlock(message, states, frame.contentIndex, frame.toolCall, {
					kind: "toolCall",
					ended: false,
					json: "",
				});
				break;
			case "toolcall_delta": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "toolCall", frame.type);
				if (block.type !== "toolCall" || state.kind !== "toolCall") {
					throw new Error("Unreachable tool-call frame state");
				}
				state.json += frame.delta;
				break;
			}
			case "toolcall_end": {
				const { block, state } = activeBlock(message, states, frame.contentIndex, "toolCall", frame.type);
				if (block.type !== "toolCall") throw new Error("Unreachable tool-call frame state");
				block.id = frame.id;
				block.name = frame.name;
				block.arguments = structuredClone(frame.arguments);
				delete block.thoughtSignature;
				delete block.namespace;
				if (frame.thoughtSignature !== undefined) block.thoughtSignature = frame.thoughtSignature;
				if (frame.namespace !== undefined) block.namespace = frame.namespace;
				state.ended = true;
				break;
			}
		}
	}

	if (!message) return undefined;
	for (const [contentIndex, state] of states) {
		if (state.kind !== "toolCall" || state.ended || state.json.length === 0) continue;
		const block = message.content[contentIndex];
		if (block?.type !== "toolCall") throw new Error("Unreachable tool-call frame state");
		block.arguments = parseStreamingJson<ToolCall["arguments"]>(state.json);
	}

	return message;
}
