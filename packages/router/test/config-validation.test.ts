import { describe, expect, test } from "bun:test";
import { getProviders } from "@draht/ai";
import { validateConfig } from "../src/config.js";
import { DEFAULT_CONFIG, type RouterConfig } from "../src/types.js";

// Get a valid provider for testing
const validProviders = getProviders();

describe("config validation", () => {
	describe("structure validation", () => {
		test("empty provider string throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "", model: "claude-opus-4-6" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).toThrow(/Empty provider string for role architect/);
		});

		test("empty model string throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				implement: {
					primary: { provider: "anthropic", model: "" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).toThrow(/Empty model string for role implement/);
		});

		test("empty provider in fallback throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-opus-4-6" },
					fallbacks: [{ provider: "", model: "gpt-5.2" }],
				},
			};

			expect(() => validateConfig(config)).toThrow(/Empty provider string for role architect/);
		});

		test("empty model in fallback throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-opus-4-6" },
					fallbacks: [{ provider: "openai", model: "" }],
				},
			};

			expect(() => validateConfig(config)).toThrow(/Empty model string for role architect/);
		});
	});

	describe("built-in roles validation", () => {
		test("missing architect role throws ValidationError", () => {
			const config: RouterConfig = {
				implement: DEFAULT_CONFIG.implement,
				boilerplate: DEFAULT_CONFIG.boilerplate,
				quick: DEFAULT_CONFIG.quick,
				review: DEFAULT_CONFIG.review,
				docs: DEFAULT_CONFIG.docs,
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: architect/);
		});

		test("missing implement role throws ValidationError", () => {
			const config: RouterConfig = {
				architect: DEFAULT_CONFIG.architect,
				boilerplate: DEFAULT_CONFIG.boilerplate,
				quick: DEFAULT_CONFIG.quick,
				review: DEFAULT_CONFIG.review,
				docs: DEFAULT_CONFIG.docs,
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: implement/);
		});

		test("missing boilerplate role throws ValidationError", () => {
			const config: RouterConfig = {
				architect: DEFAULT_CONFIG.architect,
				implement: DEFAULT_CONFIG.implement,
				quick: DEFAULT_CONFIG.quick,
				review: DEFAULT_CONFIG.review,
				docs: DEFAULT_CONFIG.docs,
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: boilerplate/);
		});

		test("missing quick role throws ValidationError", () => {
			const config: RouterConfig = {
				architect: DEFAULT_CONFIG.architect,
				implement: DEFAULT_CONFIG.implement,
				boilerplate: DEFAULT_CONFIG.boilerplate,
				review: DEFAULT_CONFIG.review,
				docs: DEFAULT_CONFIG.docs,
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: quick/);
		});

		test("missing review role throws ValidationError", () => {
			const config: RouterConfig = {
				architect: DEFAULT_CONFIG.architect,
				implement: DEFAULT_CONFIG.implement,
				boilerplate: DEFAULT_CONFIG.boilerplate,
				quick: DEFAULT_CONFIG.quick,
				docs: DEFAULT_CONFIG.docs,
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: review/);
		});

		test("missing docs role throws ValidationError", () => {
			const config: RouterConfig = {
				architect: DEFAULT_CONFIG.architect,
				implement: DEFAULT_CONFIG.implement,
				boilerplate: DEFAULT_CONFIG.boilerplate,
				quick: DEFAULT_CONFIG.quick,
				review: DEFAULT_CONFIG.review,
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: docs/);
		});

		test("all 6 built-in roles missing throws ValidationError with all listed", () => {
			const config: RouterConfig = {
				"custom-role": {
					primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).toThrow(/Missing required role: architect/);
			expect(() => validateConfig(config)).toThrow(/Missing required role: implement/);
			expect(() => validateConfig(config)).toThrow(/Missing required role: boilerplate/);
			expect(() => validateConfig(config)).toThrow(/Missing required role: quick/);
			expect(() => validateConfig(config)).toThrow(/Missing required role: review/);
			expect(() => validateConfig(config)).toThrow(/Missing required role: docs/);
		});
	});

	describe("valid configs", () => {
		test("valid config with all built-in roles passes validation", () => {
			expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
		});

		test("config with built-in roles plus custom roles passes validation", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				"custom-role": {
					primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).not.toThrow();
		});
	});

	describe("registry validation", () => {
		test("invalid provider throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "nonexistent-provider", model: "some-model" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).toThrow(
				/Invalid provider 'nonexistent-provider' for role architect \(not in @draht\/ai registry\)/,
			);
		});

		test("valid provider with invalid model throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				implement: {
					primary: { provider: "anthropic", model: "fake-model" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).toThrow(
				/Invalid model 'fake-model' for provider 'anthropic' in role implement/,
			);
		});

		test("invalid provider in fallback throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-opus-4-6" },
					fallbacks: [{ provider: "invalid-provider", model: "some-model" }],
				},
			};

			expect(() => validateConfig(config)).toThrow(
				/Invalid provider 'invalid-provider' for role architect \(not in @draht\/ai registry\)/,
			);
		});

		test("invalid model in fallback throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				docs: {
					primary: { provider: "openai", model: "gpt-5.2" },
					fallbacks: [{ provider: "anthropic", model: "nonexistent-model" }],
				},
			};

			expect(() => validateConfig(config)).toThrow(
				/Invalid model 'nonexistent-model' for provider 'anthropic' in role docs/,
			);
		});

		test("multiple invalid providers and models reports all issues", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "bad-provider", model: "bad-model" },
					fallbacks: [],
				},
				implement: {
					primary: { provider: "anthropic", model: "nonexistent" },
					fallbacks: [],
				},
			};

			expect(() => validateConfig(config)).toThrow(/Invalid provider 'bad-provider'/);
			expect(() => validateConfig(config)).toThrow(/Invalid model 'nonexistent'/);
		});

		test("valid providers and models from registry passes", () => {
			// DEFAULT_CONFIG should use valid providers and models
			expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
			// Verify that we have valid providers
			expect(validProviders).toContain("anthropic");
			expect(validProviders).toContain("openai");
			expect(validProviders).toContain("google");
		});
	});

	describe("duplicate model validation", () => {
		test("duplicate model in primary and fallback throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
					fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
				},
			};

			expect(() => validateConfig(config)).toThrow(
				/Duplicate model anthropic\/claude-sonnet-4-6 in fallback chain for role architect/,
			);
		});

		test("duplicate model in fallback chain throws ValidationError", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				implement: {
					primary: { provider: "openai", model: "gpt-5.2" },
					fallbacks: [
						{ provider: "anthropic", model: "claude-sonnet-4-6" },
						{ provider: "anthropic", model: "claude-sonnet-4-6" },
					],
				},
			};

			expect(() => validateConfig(config)).toThrow(
				/Duplicate model anthropic\/claude-sonnet-4-6 in fallback chain for role implement/,
			);
		});

		test("different models with same name but different providers are valid", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
					fallbacks: [
						{ provider: "google", model: "gemini-2.5-pro" },
						{ provider: "openai", model: "gpt-5.2" },
					],
				},
			};

			expect(() => validateConfig(config)).not.toThrow();
		});
	});

	describe("circular dependency validation", () => {
		test("circular dependency A→B, B→A is NOT a configuration error", () => {
			// Note: Circular dependencies between roles don't exist in the current RoleConfig model
			// Each role has its own fallback chain of ModelRefs, not references to other roles
			// This test verifies the current model is correct
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-opus-4-6" },
					fallbacks: [{ provider: "google", model: "gemini-2.5-pro" }],
				},
				implement: {
					primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
					fallbacks: [{ provider: "openai", model: "gpt-5.2" }],
				},
			};

			// This should pass because roles don't reference each other
			expect(() => validateConfig(config)).not.toThrow();
		});

		test("valid non-circular fallback chains pass", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
				architect: {
					primary: { provider: "anthropic", model: "claude-opus-4-6" },
					fallbacks: [
						{ provider: "google", model: "gemini-2.5-pro" },
						{ provider: "openai", model: "gpt-5.2" },
					],
				},
			};

			expect(() => validateConfig(config)).not.toThrow();
		});
	});
});
