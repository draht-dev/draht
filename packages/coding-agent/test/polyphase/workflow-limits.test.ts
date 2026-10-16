import { describe, expect, it } from "vitest";
import { MAX_SET_TIMEOUT_MS } from "../../src/core/polyphase/settings.ts";
import {
	formatLimitDuration,
	formatMissingLimitsDisclaimer,
	formatWorkflowLimitsLine,
	hardSandboxTimeoutMs,
	MAX_TIME_LIMIT_MS,
	mergePromptDirectives,
	parseDurationMs,
	parsePromptDirectives,
	resolveWorkflowLimits,
	stripPromptDirectives,
} from "../../src/core/polyphase/workflow/limits.ts";

describe("parsePromptDirectives", () => {
	it("parses a plain-number budget directive", () => {
		expect(parsePromptDirectives("run this +200000 tokens please").budgetTokens).toBe(200_000);
	});

	it("parses a k-suffixed budget directive", () => {
		expect(parsePromptDirectives("+500k").budgetTokens).toBe(500_000);
	});

	it("parses an M-suffixed decimal budget directive", () => {
		expect(parsePromptDirectives("+1.5M").budgetTokens).toBe(1_500_000);
	});

	it("treats a bare m suffix as million tokens, never minutes", () => {
		const parsed = parsePromptDirectives("+2m");
		expect(parsed.budgetTokens).toBe(2_000_000);
		expect(parsed.timeLimitMs).toBeNull();
	});

	it("parses minute/hour/second time directives", () => {
		expect(parsePromptDirectives("+30min").timeLimitMs).toBe(30 * 60 * 1000);
		expect(parsePromptDirectives("+2h").timeLimitMs).toBe(2 * 3600 * 1000);
		expect(parsePromptDirectives("+90s").timeLimitMs).toBe(90 * 1000);
		expect(parsePromptDirectives("+45sec").timeLimitMs).toBe(45 * 1000);
		expect(parsePromptDirectives("+3hr").timeLimitMs).toBe(3 * 3600 * 1000);
	});

	it("parses a compound hour+minute time directive", () => {
		expect(parsePromptDirectives("+1h30min").timeLimitMs).toBe((3600 + 30 * 60) * 1000);
	});

	it("rejects a budget below the 1000-token minimum", () => {
		expect(parsePromptDirectives("+1 for this idea").budgetTokens).toBeNull();
		expect(parsePromptDirectives("+2m is not relevant here").budgetTokens).toBe(2_000_000);
	});

	it("does not mistake a diff's leading +30 (too small) for a directive, even fenced", () => {
		const text = ["```diff", "+30 some code", "-old line", "```"].join("\n");
		expect(parsePromptDirectives(text).budgetTokens).toBeNull();
		expect(parsePromptDirectives(text).timeLimitMs).toBeNull();
	});

	it("matches a directive preceded by other text, standing alone as a word", () => {
		expect(parsePromptDirectives("a +500k budget please").budgetTokens).toBe(500_000);
	});

	it("ignores a + token that is not standalone (glued to adjacent text)", () => {
		expect(parsePromptDirectives("version+500k").budgetTokens).toBeNull();
		expect(parsePromptDirectives("+500kplus").budgetTokens).toBeNull();
	});

	it("ignores a bare + with no digits", () => {
		expect(parsePromptDirectives("+ 500k").budgetTokens).toBeNull();
	});

	it("returns both null when there is no directive", () => {
		const parsed = parsePromptDirectives("just run the workflow please");
		expect(parsed.budgetTokens).toBeNull();
		expect(parsed.timeLimitMs).toBeNull();
	});

	it("picks the first budget and first time directive independently when both appear", () => {
		const parsed = parsePromptDirectives("+500k and also +1M, within +30min or +2h");
		expect(parsed.budgetTokens).toBe(500_000);
		expect(parsed.timeLimitMs).toBe(30 * 60 * 1000);
	});
});

describe("stripPromptDirectives", () => {
	it("removes a recognized directive and collapses surrounding spaces", () => {
		expect(stripPromptDirectives("run this +500k now")).toBe("run this now");
	});

	it("removes both a budget and a time directive", () => {
		expect(stripPromptDirectives("+500k do it +30min")).toBe("do it");
	});

	it("leaves an unrecognized +token untouched", () => {
		expect(stripPromptDirectives("score is +1 today")).toBe("score is +1 today");
	});

	it("is a no-op when there is no directive", () => {
		expect(stripPromptDirectives("plain args string")).toBe("plain args string");
	});

	it("does not let one standalone directive's removal eat a longer standalone directive it prefixes", () => {
		expect(stripPromptDirectives("+1000 see +10000")).toBe("see");
	});

	it("does not strip a directive-shaped token glued to other text", () => {
		expect(stripPromptDirectives("+500k tag v+500k")).toBe("tag v+500k");
	});
});

describe("parseDurationMs", () => {
	it("parses a duration string without the leading +", () => {
		expect(parseDurationMs("30min")).toBe(30 * 60 * 1000);
		expect(parseDurationMs("2h")).toBe(2 * 3600 * 1000);
		expect(parseDurationMs("1h30min")).toBe((3600 + 30 * 60) * 1000);
	});

	it("returns undefined for a budget-shaped (non-time) string", () => {
		expect(parseDurationMs("500k")).toBeUndefined();
	});

	it("returns undefined for garbage", () => {
		expect(parseDurationMs("not-a-duration")).toBeUndefined();
	});
});

describe("resolveWorkflowLimits precedence", () => {
	it("prefers the prompt directive over the tool parameter and config", () => {
		const resolved = resolveWorkflowLimits({
			prompt: { budgetTokens: 500_000, timeLimitMs: null },
			tool: { budgetTokens: 10_000, timeLimitMs: 60_000 },
			config: { budgetTokens: 1_000, timeLimitMs: 5_000 },
		});
		expect(resolved.budgetTokens).toEqual({ value: 500_000, source: "prompt" });
		expect(resolved.timeLimitMs).toEqual({ value: 60_000, source: "tool" });
	});

	it("prefers the tool parameter over config when there is no prompt directive", () => {
		const resolved = resolveWorkflowLimits({
			tool: { budgetTokens: 10_000, timeLimitMs: 60_000 },
			config: { budgetTokens: 1_000, timeLimitMs: 5_000 },
		});
		expect(resolved.budgetTokens).toEqual({ value: 10_000, source: "tool" });
		expect(resolved.timeLimitMs).toEqual({ value: 60_000, source: "tool" });
	});

	it("falls back to config, then to none", () => {
		const configOnly = resolveWorkflowLimits({ config: { budgetTokens: 1_000, timeLimitMs: null } });
		expect(configOnly.budgetTokens).toEqual({ value: 1_000, source: "config" });
		expect(configOnly.timeLimitMs).toEqual({ value: null, source: "none" });

		const none = resolveWorkflowLimits({ config: { budgetTokens: null, timeLimitMs: null } });
		expect(none.budgetTokens).toEqual({ value: null, source: "none" });
		expect(none.timeLimitMs).toEqual({ value: null, source: "none" });
	});
});

describe("time limits stay inside what one setTimeout can wait", () => {
	it("is not a directive at zero: a 0s limit would read as a limit the run never applies", () => {
		expect(parsePromptDirectives("+0s").timeLimitMs).toBeNull();
		expect(parsePromptDirectives("+0min").timeLimitMs).toBeNull();
		expect(parseDurationMs("0h")).toBeUndefined();
	});

	it("caps an over-long directive or tool parameter instead of letting Node fire it after 1ms", () => {
		expect(parsePromptDirectives("+600h").timeLimitMs).toBe(MAX_TIME_LIMIT_MS);
		expect(parseDurationMs("1000h")).toBe(MAX_TIME_LIMIT_MS);
		expect(parsePromptDirectives("+99999999999999999999h").timeLimitMs).toBe(MAX_TIME_LIMIT_MS);
	});

	it("caps a config time limit too, which settings clamp only to the full setTimeout range", () => {
		const resolved = resolveWorkflowLimits({ config: { budgetTokens: null, timeLimitMs: MAX_SET_TIMEOUT_MS } });
		expect(resolved.timeLimitMs).toEqual({ value: MAX_TIME_LIMIT_MS, source: "config" });
		expect(hardSandboxTimeoutMs(resolved.timeLimitMs.value)).toBeLessThanOrEqual(MAX_SET_TIMEOUT_MS);
	});
});

describe("hardSandboxTimeoutMs", () => {
	it("is the resolved time limit plus the 60s backstop", () => {
		expect(hardSandboxTimeoutMs(30_000)).toBe(90_000);
	});

	it("is disabled (0) when no time limit resolved", () => {
		expect(hardSandboxTimeoutMs(null)).toBe(0);
	});

	it("never exceeds the longest setTimeout delay, whatever it is handed", () => {
		expect(hardSandboxTimeoutMs(MAX_SET_TIMEOUT_MS)).toBe(MAX_SET_TIMEOUT_MS);
	});
});

describe("mergePromptDirectives", () => {
	it("keeps the base's limits where the update states none, and takes the update's where it does", () => {
		const base = { budgetTokens: 500_000, timeLimitMs: 1_800_000 };
		expect(mergePromptDirectives(base, { budgetTokens: null, timeLimitMs: null })).toEqual(base);
		expect(mergePromptDirectives(base, { budgetTokens: null, timeLimitMs: 3_600_000 })).toEqual({
			budgetTokens: 500_000,
			timeLimitMs: 3_600_000,
		});
		expect(mergePromptDirectives(undefined, { budgetTokens: 2_000, timeLimitMs: null })).toEqual({
			budgetTokens: 2_000,
			timeLimitMs: null,
		});
	});
});

describe("formatLimitDuration", () => {
	it("spells a limit the same way everywhere it is shown", () => {
		expect(formatLimitDuration(90_000)).toBe("1min30s");
		expect(formatLimitDuration(5_400_000)).toBe("1h30min");
		expect(formatLimitDuration(30 * 60 * 1000)).toBe("30min");
	});
});

describe("formatWorkflowLimitsLine / formatMissingLimitsDisclaimer", () => {
	it("shows both limits with their source when both are set", () => {
		const line = formatWorkflowLimitsLine({
			budgetTokens: { value: 500_000, source: "prompt" },
			timeLimitMs: { value: 30 * 60 * 1000, source: "tool" },
		});
		expect(line).toContain("budget 500k tokens (from your prompt)");
		expect(line).toContain("time limit 30min (set by the model)");
		expect(
			formatMissingLimitsDisclaimer({
				budgetTokens: { value: 500_000, source: "prompt" },
				timeLimitMs: { value: 30 * 60 * 1000, source: "tool" },
			}),
		).toBeUndefined();
	});

	it("names only the missing limit when one is set", () => {
		const resolved = {
			budgetTokens: { value: 500_000, source: "prompt" as const },
			timeLimitMs: { value: null, source: "none" as const },
		};
		expect(formatMissingLimitsDisclaimer(resolved)).toContain("no time limit");
		expect(formatMissingLimitsDisclaimer(resolved)).not.toContain("no token budget and no time limit");
		const line = formatWorkflowLimitsLine(resolved);
		expect(line).toContain("budget 500k tokens (from your prompt)");
		expect(line.split("no time limit")).toHaveLength(2);
		// A budget alone still ends the run, so the line must not promise it runs until its goal.
		expect(line).not.toContain("runs until");
	});

	it("names a missing budget exactly once next to a set time limit", () => {
		const line = formatWorkflowLimitsLine({
			budgetTokens: { value: null, source: "none" },
			timeLimitMs: { value: 30 * 60 * 1000, source: "prompt" },
		});
		expect(line.split("no token budget")).toHaveLength(2);
		expect(line).toContain("time limit 30min (from your prompt)");
		expect(line).not.toContain("runs until");
	});

	it("shows the combined disclaimer and hints when neither is set", () => {
		const resolved = {
			budgetTokens: { value: null, source: "none" as const },
			timeLimitMs: { value: null, source: "none" as const },
		};
		const line = formatWorkflowLimitsLine(resolved);
		expect(line).toContain("no token budget and no time limit");
		expect(line).toContain("+500k");
		expect(line).toContain("+30min");
		expect(line).toContain("polyphase.defaultBudgetTokens");
		expect(line).toContain("polyphase.workflowTimeoutMs");
	});
});
