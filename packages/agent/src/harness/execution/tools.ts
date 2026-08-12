import { type ToolResultMessage, validateToolArguments } from "@draht/ai";
import type { TelemetryContext } from "@draht/telemetry";
import type { AgentTool, AgentToolCall, AgentToolResult } from "../../types.ts";
import type { JsonValue } from "../session/types.ts";

/** A tool call whose tool exists and whose prepared arguments passed validation. */
export interface PreparedToolCall {
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: Record<string, JsonValue>;
}

/** Synthetic result produced without crossing the external tool-effect boundary. */
export interface ImmediateToolOutcome {
	kind: "immediate";
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: true;
	terminate: boolean;
}

/** Aggregated decision from the before-tool hook pipeline. */
export interface BeforeToolDecision {
	args?: Record<string, JsonValue>;
	block?: { reason: string; terminate?: boolean };
}

/** A prepared call cleared for durable intent publication and execution. */
export interface ClearedToolCall {
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: Record<string, JsonValue>;
}

/** Raw phase-two tool output before after-tool patching. */
export interface ExecutedToolCall {
	result: AgentToolResult<unknown>;
	isError: boolean;
}

/** Aggregated patch from the after-tool hook pipeline. */
export interface AfterToolPatch {
	content?: AgentToolResult<unknown>["content"];
	details?: JsonValue;
	isError?: boolean;
	usage?: AgentToolResult<unknown>["usage"];
	terminate?: boolean;
}

/** Final tool output ready to become a durable tool-result message. */
export interface FinalizedToolCall {
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
	terminate: boolean;
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

function immediateError(toolCall: AgentToolCall, message: string, terminate = false): ImmediateToolOutcome {
	return {
		kind: "immediate",
		toolCall,
		result: createErrorToolResult(message),
		isError: true,
		terminate,
	};
}

/** Resolve a tool, apply its deterministic argument preparation, and validate the result. */
export function prepareToolCall(call: AgentToolCall, tools: AgentTool[]): PreparedToolCall | ImmediateToolOutcome {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) {
		return immediateError(call, `Tool ${call.name} not found`);
	}

	try {
		const preparedArguments = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
		const preparedCall: AgentToolCall =
			preparedArguments === call.arguments
				? call
				: { ...call, arguments: preparedArguments as Record<string, JsonValue> };
		const args = validateToolArguments(tool, preparedCall) as Record<string, JsonValue>;
		return { toolCall: call, tool, args };
	} catch (error) {
		return immediateError(call, error instanceof Error ? error.message : String(error));
	}
}

/** Apply an explicit hook decision and revalidate replacement arguments. */
export function applyBeforeToolDecision(
	prepared: PreparedToolCall,
	decision: BeforeToolDecision | undefined,
): ClearedToolCall | ImmediateToolOutcome {
	if (decision?.block) {
		return immediateError(prepared.toolCall, decision.block.reason, decision.block.terminate === true);
	}

	if (!decision?.args) {
		return { toolCall: prepared.toolCall, tool: prepared.tool, args: prepared.args };
	}

	try {
		const validatedArgs = validateToolArguments(prepared.tool, {
			...prepared.toolCall,
			arguments: decision.args,
		}) as Record<string, JsonValue>;
		return { toolCall: prepared.toolCall, tool: prepared.tool, args: validatedArgs };
	} catch (error) {
		return immediateError(prepared.toolCall, error instanceof Error ? error.message : String(error));
	}
}

/** Execute one cleared external tool effect, converting expected tool throws to error output. */
export async function executeToolCall(
	call: ClearedToolCall,
	signal: AbortSignal,
	onUpdate: (partial: AgentToolResult<unknown>) => void,
	_telemetryContext: TelemetryContext,
): Promise<ExecutedToolCall> {
	let acceptingUpdates = true;
	try {
		const result = await call.tool.execute(call.toolCall.id, call.args, signal, (partial) => {
			if (acceptingUpdates) onUpdate(partial);
		});
		return { result, isError: false };
	} catch (error) {
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

/** Apply an after-tool patch field by field. */
export function finalizeToolCall(
	call: ClearedToolCall,
	executed: ExecutedToolCall,
	patch: AfterToolPatch | undefined,
): FinalizedToolCall {
	const result: AgentToolResult<unknown> = patch
		? {
				...executed.result,
				content: patch.content === undefined ? executed.result.content : patch.content,
				details: patch.details === undefined ? executed.result.details : patch.details,
				usage: patch.usage === undefined ? executed.result.usage : patch.usage,
				terminate: patch.terminate === undefined ? executed.result.terminate : patch.terminate,
			}
		: executed.result;
	return {
		toolCall: call.toolCall,
		result,
		isError: patch?.isError ?? executed.isError,
		terminate: result.terminate === true,
	};
}

/** Convert finalized tool output to the provider-facing transcript message. */
export function createToolResultMessage(call: FinalizedToolCall): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.toolCall.id,
		toolName: call.toolCall.name,
		content: call.result.content ?? [],
		details: call.result.details,
		usage: call.result.usage,
		...(call.result.addedToolNames?.length ? { addedToolNames: call.result.addedToolNames } : {}),
		isError: call.isError,
		timestamp: Date.now(),
	};
}
