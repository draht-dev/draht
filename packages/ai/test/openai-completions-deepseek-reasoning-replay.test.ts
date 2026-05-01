import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Compat shape that detectCompat() returns for deepseek.com baseUrls today.
// Used for tests that exercise convertMessages directly.
const deepseekCompat: Required<OpenAICompletionsCompat> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
};

function makeDeepSeekModel(): Model<"openai-completions"> {
	return {
		id: "deepseek-reasoner",
		name: "DeepSeek Reasoner",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64000,
		maxTokens: 8192,
	};
}

function makeOpenCodeGoModel(): Model<"openai-completions"> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
	};
}

describe("openai-completions DeepSeek reasoning_content replay", () => {
	it("preserves reasoning_content on an assistant message that has no text or tool calls", () => {
		const model = makeDeepSeekModel();
		const now = Date.now();

		// Edge case: assistant message contains only a thinking block with
		// reasoning_content — no text content and no tool calls.
		// Previously this message was skipped by the hasContent check,
		// causing DeepSeek to fail with:
		//   400: The `reasoning_content` in the thinking mode must be passed back to the API.
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "The user asked for the README.",
					thinkingSignature: "reasoning_content",
				},
			],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-reasoner",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the README", timestamp: now - 1 },
				assistantMessage,
				{ role: "user", content: "Summarize it", timestamp: now + 1 },
			],
		};

		const messages = convertMessages(model, context, deepseekCompat);
		const replayedAssistant = messages.find((m) => m.role === "assistant");
		expect(replayedAssistant).toBeDefined();
		expect((replayedAssistant as { reasoning_content?: string }).reasoning_content).toBe(
			"The user asked for the README.",
		);
	});

	it("preserves reasoning_content for opencode-go provider (deepseek via proxy)", () => {
		const model = makeOpenCodeGoModel();
		const now = Date.now();

		// opencode-go proxies DeepSeek models. The reasoning_content replay
		// must work correctly for these models too.
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Let me think about this.",
					thinkingSignature: "reasoning_content",
				},
				{ type: "text", text: "Here is my answer." },
			],
			api: "openai-completions",
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: now - 1 },
				assistantMessage,
				{ role: "user", content: "Thanks", timestamp: now + 1 },
			],
		};

		const messages = convertMessages(model, context, deepseekCompat);
		const replayedAssistant = messages.find((m) => m.role === "assistant");
		expect(replayedAssistant).toBeDefined();
		expect((replayedAssistant as { reasoning_content?: string }).reasoning_content).toBe("Let me think about this.");
	});

	it("preserves reasoning_content on a tool-calling assistant message even when thinking text is empty", () => {
		const model = makeDeepSeekModel();
		const now = Date.now();

		// Reproduces real DeepSeek streaming behaviour: the reasoning_content
		// channel was opened (so the block exists with thinkingSignature set)
		// but the model emitted no actual reasoning text before the tool call.
		// DeepSeek still requires the reasoning_content field on the replayed
		// assistant message — otherwise the next request fails with:
		//   400: The `reasoning_content` in the thinking mode must be passed back to the API.
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: "reasoning_content",
				},
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-reasoner",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the README", timestamp: now - 2 },
				assistantMessage,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "# Hello" }],
					isError: false,
					timestamp: now + 1,
				},
				{ role: "user", content: "Summarize it", timestamp: now + 2 },
			],
		};

		const messages = convertMessages(model, context, deepseekCompat);
		const replayedAssistant = messages.find((m) => m.role === "assistant");
		expect(replayedAssistant).toBeDefined();
		expect((replayedAssistant as { reasoning_content?: string }).reasoning_content).toBeDefined();
	});

	it("preserves reasoning_content on assistant messages that captured non-empty reasoning", () => {
		const model = makeDeepSeekModel();
		const now = Date.now();

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "The user asked for the README.",
					thinkingSignature: "reasoning_content",
				},
				{ type: "text", text: "Sure, reading it now." },
			],
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-reasoner",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the README", timestamp: now - 1 },
				assistantMessage,
				{ role: "user", content: "Summarize it", timestamp: now + 1 },
			],
		};

		const messages = convertMessages(model, context, deepseekCompat);
		const replayedAssistant = messages.find((m) => m.role === "assistant");
		expect(replayedAssistant).toBeDefined();
		expect((replayedAssistant as { reasoning_content?: string }).reasoning_content).toBe(
			"The user asked for the README.",
		);
	});
});
