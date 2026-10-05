import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@draht/ai";
import { fauxAssistantMessage } from "@draht/ai";
import { createCompleter, resolveModelLimits } from "../src/ai-completer.lazy.ts";

const STUB_MODEL: Model<Api> = {
	id: "stub-1",
	name: "Stub",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://localhost:0",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("createCompleter", () => {
	test("resolves text and usage on a successful completion", async () => {
		const message: AssistantMessage = fauxAssistantMessage("hello");
		message.usage = {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		};
		const completer = createCompleter(STUB_MODEL, async () => message);

		const result = await completer({ prompt: "write a story", maxTokens: 100 });

		expect(result.text).toBe("hello");
		expect(result.usage).toEqual({ input: 10, output: 20, costUsd: 0.003 });
	});

	test("passes systemPrompt and maxTokens through to the completion call", async () => {
		let seenSystemPrompt: string | undefined;
		let seenMaxTokens: number | undefined;
		const completer = createCompleter(STUB_MODEL, async (_model, context, options) => {
			seenSystemPrompt = context.systemPrompt;
			seenMaxTokens = options?.maxTokens;
			return fauxAssistantMessage("ok");
		});

		await completer({ systemPrompt: "you are the writer", prompt: "go", maxTokens: 4096 });

		expect(seenSystemPrompt).toBe("you are the writer");
		expect(seenMaxTokens).toBe(4096);
	});

	test("throws on stopReason error, with the errorMessage included", async () => {
		const completer = createCompleter(STUB_MODEL, async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }),
		);

		await expect(completer({ prompt: "go", maxTokens: 10 })).rejects.toThrow(/error.*rate limited/);
	});

	test("throws on stopReason aborted", async () => {
		const completer = createCompleter(STUB_MODEL, async () => fauxAssistantMessage("", { stopReason: "aborted" }));

		await expect(completer({ prompt: "go", maxTokens: 10 })).rejects.toThrow(/aborted/);
	});
});

describe("resolveModelLimits", () => {
	test("rejects a spec without a provider/model slash", () => {
		expect(() => resolveModelLimits("not-a-spec")).toThrow(/provider.*modelId/);
	});

	test("rejects an unknown model", () => {
		expect(() => resolveModelLimits("anthropic/does-not-exist")).toThrow(/Unknown model/);
	});
});
