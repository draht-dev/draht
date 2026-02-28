import { describe, expect, test } from "bun:test";
import { ModelRouter } from "../src/router.js";
import { DEFAULT_CONFIG } from "../src/types.js";

describe("ModelRouter", () => {
	const router = new ModelRouter(DEFAULT_CONFIG);

	test("resolve returns primary model for role", () => {
		const model = router.resolve("architect");
		expect(model.provider).toBe("anthropic");
		expect(model.model).toBe("claude-opus-4-6");
	});

	test("resolve throws for unknown role", () => {
		expect(() => router.resolve("nonexistent")).toThrow("Unknown role");
	});

	test("resolveWithFallbacks returns full chain", () => {
		const chain = router.resolveWithFallbacks("implement");
		expect(chain).toHaveLength(3);
		expect(chain[0].provider).toBe("anthropic");
		expect(chain[1].provider).toBe("openai");
		expect(chain[2].provider).toBe("deepseek");
	});

	test("route uses primary on success", async () => {
		const result = await router.route("architect", async (model) => {
			return `${model.provider}/${model.model}`;
		});
		expect(result).toBe("anthropic/claude-opus-4-6");
	});

	test("route falls back on retryable error", async () => {
		let attempt = 0;
		const result = await router.route("implement", async (model) => {
			attempt++;
			if (attempt === 1) throw new Error("429 rate limit exceeded");
			return `${model.provider}/${model.model}`;
		});
		expect(result).toBe("openai/gpt-5.2");
		expect(attempt).toBe(2);
	});

	test("route throws on non-retryable error", async () => {
		expect(
			router.route("architect", async () => {
				throw new Error("invalid API key");
			}),
		).rejects.toThrow("invalid API key");
	});

	test("isRetryableError identifies retryable errors", () => {
		expect(router.isRetryableError(new Error("429 rate limit"))).toBe(true);
		expect(router.isRetryableError(new Error("timeout"))).toBe(true);
		expect(router.isRetryableError(new Error("503 service unavailable"))).toBe(true);
		expect(router.isRetryableError(new Error("invalid key"))).toBe(false);
	});

	test("isRetryableError checks status property", () => {
		expect(router.isRetryableError({ status: 429 })).toBe(true);
		expect(router.isRetryableError({ status: 500 })).toBe(true);
		expect(router.isRetryableError({ status: 401 })).toBe(false);
	});
});
