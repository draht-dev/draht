import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config.js";
import { DEFAULT_CONFIG, type RouterConfig } from "../src/types.js";

describe("config", () => {
	test("mergeConfig with no overrides returns defaults", () => {
		const result = mergeConfig(null, null);
		expect(result).toEqual(DEFAULT_CONFIG);
	});

	test("mergeConfig global overrides defaults", () => {
		const global: RouterConfig = {
			architect: {
				primary: { provider: "google", model: "gemini-2.5-pro" },
				fallbacks: [],
			},
		};
		const result = mergeConfig(null, global);
		expect(result.architect.primary.provider).toBe("google");
		// Other roles still have defaults
		expect(result.implement.primary.provider).toBe("anthropic");
	});

	test("mergeConfig project overrides global", () => {
		const global: RouterConfig = {
			architect: {
				primary: { provider: "google", model: "gemini-2.5-pro" },
				fallbacks: [],
			},
		};
		const project: RouterConfig = {
			architect: {
				primary: { provider: "deepseek", model: "deepseek-v3" },
				fallbacks: [],
			},
		};
		const result = mergeConfig(project, global);
		expect(result.architect.primary.provider).toBe("deepseek");
	});

	test("mergeConfig supports custom roles", () => {
		const project: RouterConfig = {
			"custom-role": {
				primary: { provider: "anthropic", model: "claude-sonnet-4-6" },
				fallbacks: [],
			},
		};
		const result = mergeConfig(project, null);
		expect(result["custom-role"]).toBeDefined();
		expect(result["custom-role"].primary.provider).toBe("anthropic");
	});
});
