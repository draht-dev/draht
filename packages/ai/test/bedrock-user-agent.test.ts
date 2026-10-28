import { beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	configs: [] as Array<{ customUserAgent?: unknown }>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };

		constructor(config: { customUserAgent?: unknown }) {
			bedrockMock.configs.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

async function customUserAgentFor(options: BedrockOptions): Promise<unknown> {
	await streamBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, options)
		.result()
		.catch(() => undefined);
	expect(bedrockMock.configs).toHaveLength(1);
	return bedrockMock.configs[0].customUserAgent;
}

beforeEach(() => {
	bedrockMock.configs.length = 0;
});

describe("bedrock client identity", () => {
	it("identifies as draht with a version by default", async () => {
		const userAgent = await customUserAgentFor({ cacheRetention: "none" });
		expect(userAgent).toEqual([["draht", expect.any(String)]]);
	});

	it("identifies as draht without a version in short mode", async () => {
		const userAgent = await customUserAgentFor({ cacheRetention: "none", identity: { userAgent: "short" } });
		expect(userAgent).toEqual([["draht"]]);
	});
});
