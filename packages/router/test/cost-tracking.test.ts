import { describe, expect, test } from "bun:test";
import { DEFAULT_RATES, estimateCost } from "../src/cost.js";

/**
 * Assert cost is within 1% tolerance of expected value.
 */
function assertCostWithinTolerance(actual: number, expected: number): void {
	if (expected === 0) {
		expect(actual).toBe(0);
		return;
	}
	const tolerance = expected * 0.01; // 1% tolerance
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/**
 * Test fixtures for known model cost calculations.
 * Based on COST_PER_MILLION pricing table in cost.ts.
 */
const knownModelFixtures = [
	{
		name: "anthropic/claude-opus-5-5",
		provider: "anthropic",
		model: "claude-opus-5-5",
		inputTokens: 100_000,
		outputTokens: 50_000,
		// 0.1M * $4 (input) + 0.05M * $20 (output) = $1.40
		expectedCost: 1.4,
	},
	{
		name: "google/gemini-2.5-flash",
		provider: "google",
		model: "gemini-2.5-flash",
		inputTokens: 1_000_000,
		outputTokens: 500_000,
		// 1M * $0.3 (input) + 0.5M * $2.5 (output) = $1.55
		expectedCost: 1.55,
	},
	{
		name: "deepseek/deepseek-v3",
		provider: "deepseek",
		model: "deepseek-v3",
		inputTokens: 500_000,
		outputTokens: 200_000,
		// 0.5M * $0.27 (input) + 0.2M * $1.1 (output) = $0.355
		expectedCost: 0.355,
	},
	{
		name: "openai/gpt-6.1-sol",
		provider: "openai",
		model: "gpt-6.1-sol",
		inputTokens: 200_000,
		outputTokens: 100_000,
		// 0.2M * $2 (input) + 0.1M * $10 (output) = $1.40
		expectedCost: 1.4,
	},
];

/**
 * Test fixtures for unknown models using default rates.
 * Default rates: { input: 3, output: 15 } per million tokens.
 */
const unknownModelFixtures = [
	{
		name: "unknown-provider/unknown-model",
		provider: "unknown-provider",
		model: "unknown-model",
		inputTokens: 100_000,
		outputTokens: 50_000,
		// 0.1M * $3 (input) + 0.05M * $15 (output) = $1.05
		expectedCost: 1.05,
	},
	{
		name: "anthropic/claude-opus-5 (unknown model, known provider)",
		provider: "anthropic",
		model: "claude-opus-5",
		inputTokens: 500_000,
		outputTokens: 250_000,
		// 0.5M * $3 (input) + 0.25M * $15 (output) = $5.25
		expectedCost: 5.25,
	},
	{
		name: "completely-new-provider/new-model (zero output)",
		provider: "completely-new-provider",
		model: "new-model",
		inputTokens: 1_000_000,
		outputTokens: 0,
		// 1M * $3 (input) + 0 * $15 (output) = $3.00
		expectedCost: 3.0,
	},
];

/**
 * Test fixtures for reasoning token calculations.
 * Reasoning tokens are billed at input token rate.
 */
const reasoningTokenFixtures = [
	{
		name: "anthropic/claude-sonnet-5 with reasoning tokens",
		provider: "anthropic",
		model: "claude-sonnet-5",
		inputTokens: 100_000,
		outputTokens: 50_000,
		reasoningTokens: 25_000,
		// (0.1M + 0.025M) * $2 (input rate for reasoning) + 0.05M * $10 (output) = $0.75
		expectedCost: 0.75,
	},
	{
		name: "openai/gpt-6.1-sol with reasoning tokens",
		provider: "openai",
		model: "gpt-6.1-sol",
		inputTokens: 200_000,
		outputTokens: 100_000,
		reasoningTokens: 50_000,
		// (0.2M + 0.05M) * $2 (input rate for reasoning) + 0.1M * $10 (output) = $1.50
		expectedCost: 1.5,
	},
	{
		name: "unknown model with reasoning tokens",
		provider: "unknown",
		model: "unknown",
		inputTokens: 100_000,
		outputTokens: 50_000,
		reasoningTokens: 25_000,
		// (0.1M + 0.025M) * $3 (default input) + 0.05M * $15 (default output) = $1.125
		expectedCost: 1.125,
	},
];

describe("cost tracking", () => {
	describe("known models", () => {
		for (const fixture of knownModelFixtures) {
			test(`calculates cost for ${fixture.name} at expected rate`, () => {
				const cost = estimateCost(fixture.provider, fixture.model, fixture.inputTokens, fixture.outputTokens);
				assertCostWithinTolerance(cost, fixture.expectedCost);
			});
		}
	});

	describe("unknown models use default rates", () => {
		test("DEFAULT_RATES constant is { input: 3, output: 15 }", () => {
			expect(DEFAULT_RATES.input).toBe(3);
			expect(DEFAULT_RATES.output).toBe(15);
		});

		for (const fixture of unknownModelFixtures) {
			test(`calculates cost for ${fixture.name} using default rates`, () => {
				const cost = estimateCost(fixture.provider, fixture.model, fixture.inputTokens, fixture.outputTokens);
				assertCostWithinTolerance(cost, fixture.expectedCost);
			});
		}
	});

	describe("reasoning tokens", () => {
		for (const fixture of reasoningTokenFixtures) {
			test(`calculates cost for ${fixture.name} with reasoning billed at input rate`, () => {
				const cost = estimateCost(
					fixture.provider,
					fixture.model,
					fixture.inputTokens,
					fixture.outputTokens,
					fixture.reasoningTokens,
				);
				assertCostWithinTolerance(cost, fixture.expectedCost);
			});
		}

		test("backward compatibility: estimateCost without reasoning param still works", () => {
			// anthropic/claude-sonnet-5 with 100000 input, 50000 output → $0.70
			const cost = estimateCost("anthropic", "claude-sonnet-5", 100_000, 50_000);
			assertCostWithinTolerance(cost, 0.7);
		});
	});

	describe("edge cases and boundary conditions", () => {
		test("zero tokens returns $0.00", () => {
			const cost = estimateCost("anthropic", "claude-opus-5-5", 0, 0);
			expect(cost).toBe(0);
		});

		test("zero output tokens: only input cost", () => {
			// anthropic/claude-opus-5-5 with 1M input, 0 output → $4.00 (1M * $4)
			const cost = estimateCost("anthropic", "claude-opus-5-5", 1_000_000, 0);
			assertCostWithinTolerance(cost, 4.0);
		});

		test("zero input tokens: only output cost", () => {
			// google/gemini-2.5-pro with 0 input, 1M output → $10.00 (1M * $10)
			const cost = estimateCost("google", "gemini-2.5-pro", 0, 1_000_000);
			assertCostWithinTolerance(cost, 10.0);
		});

		test("very large token counts: no overflow or precision loss", () => {
			// deepseek/deepseek-v3 with 100M input, 50M output → $82.00 (100M * $0.27 + 50M * $1.1)
			const cost = estimateCost("deepseek", "deepseek-v3", 100_000_000, 50_000_000);
			assertCostWithinTolerance(cost, 82.0);
		});

		test("single token: very small but non-zero cost", () => {
			// anthropic/claude-sonnet-5 with 1 input, 1 output
			// (1 / 1_000_000) * $2 + (1 / 1_000_000) * $10 = $0.000002 + $0.00001 = $0.000012
			const cost = estimateCost("anthropic", "claude-sonnet-5", 1, 1);
			expect(cost).toBeGreaterThan(0);
			expect(cost).toBeCloseTo(0.000012, 9);
		});

		test("zero reasoning tokens has no effect on cost", () => {
			const costWithoutReasoning = estimateCost("anthropic", "claude-sonnet-5", 100_000, 50_000);
			const costWithZeroReasoning = estimateCost("anthropic", "claude-sonnet-5", 100_000, 50_000, 0);
			expect(costWithZeroReasoning).toBe(costWithoutReasoning);
		});
	});
});
