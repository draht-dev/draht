import { describe, expect, it } from "vitest";
import { resolvePolyphaseSettings } from "../../src/core/polyphase/settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("resolvePolyphaseSettings", () => {
	it("derives maxConcurrency from cpuCount within [2, 8] when unset", () => {
		expect(resolvePolyphaseSettings(undefined, 4).maxConcurrency).toBe(2);
		expect(resolvePolyphaseSettings(undefined, 12).maxConcurrency).toBe(8);
		expect(resolvePolyphaseSettings(undefined, 64).maxConcurrency).toBe(8);
	});

	it("applies every documented default", () => {
		const resolved = resolvePolyphaseSettings(undefined, 4);
		expect(resolved).toEqual({
			maxConcurrency: 2,
			maxAgentsPerRun: 200,
			maxItemsPerCall: 1024,
			workflowTool: "keyword",
			keyword: "polyphase",
			defaultBudgetTokens: null,
			resultChars: 64_000,
			dock: true,
			maxDepth: 2,
			liveUpdateMs: 250,
			retainRuns: 20,
			workflowTimeoutMs: 0,
			warnings: [],
		});
	});

	it("clamps and floors out-of-range numbers, warning for each clamped field", () => {
		const resolved = resolvePolyphaseSettings(
			{
				maxConcurrency: 99,
				maxAgentsPerRun: -5,
				maxItemsPerCall: 999_999,
				resultChars: 1,
				maxDepth: 0,
				liveUpdateMs: 10,
				retainRuns: 1000,
				defaultBudgetTokens: 1.9,
			},
			4,
		);
		expect(resolved.maxConcurrency).toBe(16);
		expect(resolved.maxAgentsPerRun).toBe(1);
		expect(resolved.maxItemsPerCall).toBe(4096);
		expect(resolved.resultChars).toBe(8_000);
		expect(resolved.maxDepth).toBe(1);
		expect(resolved.liveUpdateMs).toBe(100);
		expect(resolved.retainRuns).toBe(100);
		expect(resolved.defaultBudgetTokens).toBe(1000);
		expect(resolved.warnings).toEqual([
			expect.stringContaining("maxConcurrency"),
			expect.stringContaining("maxAgentsPerRun"),
			expect.stringContaining("maxItemsPerCall"),
			expect.stringContaining("resultChars"),
			expect.stringContaining("maxDepth"),
			expect.stringContaining("liveUpdateMs"),
			expect.stringContaining("retainRuns"),
			expect.stringContaining("defaultBudgetTokens"),
		]);
	});

	it("names the key, the given value and the applied value in a clamp warning", () => {
		const resolved = resolvePolyphaseSettings({ maxConcurrency: 99 }, 4);
		expect(resolved.warnings).toEqual(["polyphase.maxConcurrency 99 is outside 1-16; using 16."]);
	});

	it("floors in-range non-integers without warnings", () => {
		const resolved = resolvePolyphaseSettings(
			{
				maxConcurrency: 3.7,
				retainRuns: 10.9,
				liveUpdateMs: 333.3,
				defaultBudgetTokens: 2500.7,
			},
			4,
		);
		expect(resolved.maxConcurrency).toBe(3);
		expect(resolved.retainRuns).toBe(10);
		expect(resolved.liveUpdateMs).toBe(333);
		expect(resolved.defaultBudgetTokens).toBe(2500);
		expect(resolved.warnings).toEqual([]);
	});

	it("clamps workflowTimeoutMs to the setTimeout maximum instead of overflowing, with a warning", () => {
		const resolved = resolvePolyphaseSettings({ workflowTimeoutMs: 1e11 }, 4);
		expect(resolved.workflowTimeoutMs).toBe(2_147_483_647);
		expect(resolved.warnings).toEqual([expect.stringContaining("workflowTimeoutMs")]);
	});

	it("falls back to the default with a warning when a numeric field has the wrong type", () => {
		const resolved = resolvePolyphaseSettings({ maxConcurrency: "4" as unknown as number }, 4);
		expect(resolved.maxConcurrency).toBe(2);
		expect(resolved.warnings).toEqual([expect.stringContaining("maxConcurrency")]);
	});

	it("falls back to unlimited with a warning when defaultBudgetTokens is invalid", () => {
		const resolved = resolvePolyphaseSettings({ defaultBudgetTokens: null as unknown as number }, 4);
		expect(resolved.defaultBudgetTokens).toBeNull();
		expect(resolved.warnings).toEqual([expect.stringContaining("defaultBudgetTokens")]);
	});

	it("falls back to the default keyword with a warning when keyword is not a string", () => {
		const resolved = resolvePolyphaseSettings({ keyword: ["abcd"] as unknown as string }, 4);
		expect(resolved.keyword).toBe("polyphase");
		expect(resolved.warnings).toEqual([expect.stringContaining("keyword")]);
	});

	it("falls back to dock=true with a warning when dock is not a boolean", () => {
		const resolved = resolvePolyphaseSettings({ dock: "false" as unknown as boolean }, 4);
		expect(resolved.dock).toBe(true);
		expect(resolved.warnings).toEqual([expect.stringContaining("dock")]);
	});

	it("falls back to the default keyword with a warning when invalid", () => {
		const resolved = resolvePolyphaseSettings({ keyword: "a!" }, 4);
		expect(resolved.keyword).toBe("polyphase");
		expect(resolved.warnings).toEqual([expect.stringContaining("keyword")]);
	});

	it("falls back to the default workflowTool with a warning when invalid", () => {
		const resolved = resolvePolyphaseSettings(
			{ workflowTool: "sometimes" as unknown as "keyword" | "always" | "off" },
			4,
		);
		expect(resolved.workflowTool).toBe("keyword");
		expect(resolved.warnings).toEqual([expect.stringContaining("workflowTool")]);
	});

	it("accepts a valid keyword and workflowTool without warnings", () => {
		const resolved = resolvePolyphaseSettings({ keyword: "orchestrate", workflowTool: "always" }, 4);
		expect(resolved.keyword).toBe("orchestrate");
		expect(resolved.workflowTool).toBe("always");
		expect(resolved.warnings).toEqual([]);
	});
});

describe("SettingsManager polyphase round-trip", () => {
	it("stores and returns the configured polyphase settings", () => {
		const manager = SettingsManager.inMemory({ polyphase: { maxConcurrency: 3, keyword: "orchestrate" } });
		expect(manager.getSettings().polyphase).toEqual({ maxConcurrency: 3, keyword: "orchestrate" });
	});
});
