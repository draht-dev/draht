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

describe("openai-completions DeepSeek reasoning_content replay", () => {
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
