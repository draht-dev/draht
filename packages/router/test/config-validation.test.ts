import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviders } from "@draht/ai/compat";
import { loadConfig, saveConfig, validateConfig } from "../src/config.js";
import { logCost, readCostLog } from "../src/cost.js";
import { type CostEntry, DEFAULT_CONFIG, type RouterConfig } from "../src/types.js";

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

	describe("rlm-root/rlm-sub roles", () => {
		test("DEFAULT_CONFIG includes rlm-root passing config validation", () => {
			expect(DEFAULT_CONFIG["rlm-root"]).toBeDefined();
			expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
		});

		test("DEFAULT_CONFIG includes rlm-sub passing config validation", () => {
			expect(DEFAULT_CONFIG["rlm-sub"]).toBeDefined();
			expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
		});

		test("rlm-root has a registry-valid primary and fallback chain", () => {
			const role = DEFAULT_CONFIG["rlm-root"];
			expect(role.primary.provider).toBeTruthy();
			expect(role.primary.model).toBeTruthy();
			expect(Array.isArray(role.fallbacks)).toBe(true);
			expect(role.fallbacks.length).toBeGreaterThan(0);
		});

		test("rlm-sub has a registry-valid primary and fallback chain", () => {
			const role = DEFAULT_CONFIG["rlm-sub"];
			expect(role.primary.provider).toBeTruthy();
			expect(role.primary.model).toBeTruthy();
			expect(Array.isArray(role.fallbacks)).toBe(true);
			expect(role.fallbacks.length).toBeGreaterThan(0);
		});

		test("rlm-root and rlm-sub fallback chains are independent array references", () => {
			const root = DEFAULT_CONFIG["rlm-root"];
			const sub = DEFAULT_CONFIG["rlm-sub"];

			expect(root.fallbacks).not.toBe(sub.fallbacks);

			const rootFallbacksBefore = [...root.fallbacks];
			const subFallbacksBefore = [...sub.fallbacks];

			// Mutate rlm-root's fallback chain and verify rlm-sub is unaffected.
			root.fallbacks.push({ provider: "openai", model: "gpt-5.2" });
			expect(sub.fallbacks).toEqual(subFallbacksBefore);
			expect(root.fallbacks).not.toEqual(rootFallbacksBefore);

			// Restore so other tests in this file aren't affected by shared DEFAULT_CONFIG mutation.
			root.fallbacks.pop();
		});

		test("removing a config entirely still leaves DEFAULT_CONFIG's rlm roles independently valid", () => {
			const config: RouterConfig = {
				...DEFAULT_CONFIG,
			};
			expect(() => validateConfig(config)).not.toThrow();
			expect(config["rlm-root"].fallbacks).not.toBe(config["rlm-sub"].fallbacks);
		});
	});

	describe("CostEntry trajectoryId", () => {
		let testDir: string;
		let logPath: string;

		function makeTestDir() {
			testDir = mkdtempSync(join(tmpdir(), "router-cost-test-"));
			logPath = join(testDir, "cost-log.jsonl");
		}

		function cleanupTestDir() {
			rmSync(testDir, { recursive: true, force: true });
		}

		test("CostEntry with trajectoryId round-trips through logCost/readCostLog", () => {
			makeTestDir();
			try {
				const entry: CostEntry = {
					timestamp: new Date().toISOString(),
					role: "rlm-root",
					provider: "anthropic",
					model: "claude-opus-4-6",
					inputTokens: 100,
					outputTokens: 50,
					estimatedCostUsd: 0.01,
					sessionId: "session-rlm-1",
					trajectoryId: "trajectory-abc-123",
				};

				logCost(entry, logPath);
				const entries = readCostLog(logPath);

				expect(entries).toHaveLength(1);
				expect(entries[0].trajectoryId).toBe("trajectory-abc-123");
				expect(entries[0]).toEqual(entry);
			} finally {
				cleanupTestDir();
			}
		});

		test("CostEntry without trajectoryId (existing non-RLM callers) still works unchanged", () => {
			makeTestDir();
			try {
				const entry: CostEntry = {
					timestamp: new Date().toISOString(),
					role: "architect",
					provider: "anthropic",
					model: "claude-opus-4-6",
					inputTokens: 200,
					outputTokens: 75,
					estimatedCostUsd: 0.02,
					sessionId: "session-non-rlm-1",
				};

				logCost(entry, logPath);
				const entries = readCostLog(logPath);

				expect(entries).toHaveLength(1);
				expect(entries[0].trajectoryId).toBeUndefined();
				expect(entries[0]).toEqual(entry);
			} finally {
				cleanupTestDir();
			}
		});

		test("mixed log with and without trajectoryId both parse correctly", () => {
			makeTestDir();
			try {
				const withTrajectory: CostEntry = {
					timestamp: new Date().toISOString(),
					role: "rlm-sub",
					provider: "google",
					model: "gemini-2.5-flash",
					inputTokens: 10,
					outputTokens: 5,
					estimatedCostUsd: 0.001,
					sessionId: "session-rlm-2",
					trajectoryId: "trajectory-xyz",
				};
				const withoutTrajectory: CostEntry = {
					timestamp: new Date().toISOString(),
					role: "quick",
					provider: "google",
					model: "gemini-2.5-flash",
					inputTokens: 10,
					outputTokens: 5,
					estimatedCostUsd: 0.001,
					sessionId: "session-non-rlm-2",
				};

				logCost(withTrajectory, logPath);
				logCost(withoutTrajectory, logPath);

				const entries = readCostLog(logPath);
				expect(entries).toHaveLength(2);
				expect(entries[0].trajectoryId).toBe("trajectory-xyz");
				expect(entries[1].trajectoryId).toBeUndefined();
			} finally {
				cleanupTestDir();
			}
		});
	});

	describe("loadConfig/saveConfig integration", () => {
		test("loadConfig validates merged config", () => {
			// loadConfig should call validateConfig on the result
			// Since we're using defaults, this should pass
			const config = loadConfig();
			expect(config).toBeDefined();
			expect(config.architect).toBeDefined();
		});

		test("saveConfig with invalid config throws ValidationError before writing", () => {
			const invalidConfig: RouterConfig = {
				architect: {
					primary: { provider: "", model: "" },
					fallbacks: [],
				},
			} as RouterConfig;

			expect(() => saveConfig(invalidConfig, "project", "/tmp/test-router")).toThrow(/Empty provider string/);
		});

		test("saveConfig with valid config succeeds", () => {
			// This test verifies saveConfig validates before writing
			// Using a temp directory to avoid affecting real configs
			expect(() => saveConfig(DEFAULT_CONFIG, "project", "/tmp/test-router-valid")).not.toThrow();
		});
	});
});
