import { describe, expect, test } from "bun:test";
import { DEFAULT_RATES, estimateCost } from "../src/cost.js";

/**
 * Assert cost is within 1% tolerance of expected value.
 */
function assertCostWithinTolerance(actual: number, expected: number): void {
	const tolerance = expected * 0.01; // 1% tolerance
	expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/**
 * Test fixtures for known model cost calculations.
 * Based on COST_PER_MILLION pricing table in cost.ts.
 */
const knownModelFixtures = [
	{
		name: "anthropic/claude-opus-4-6",
		provider: "anthropic",
		model: "claude-opus-4-6",
		inputTokens: 100_000,
		outputTokens: 50_000,
		// 0.1M * $15 (input) + 0.05M * $75 (output) = $5.25
		expectedCost: 5.25,
	},
	{
		name: "google/gemini-2.5-flash",
		provider: "google",
		model: "gemini-2.5-flash",
		inputTokens: 1_000_000,
		outputTokens: 500_000,
		// 1M * $0.15 (input) + 0.5M * $0.6 (output) = $0.45
		expectedCost: 0.45,
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
		name: "openai/gpt-5.2",
		provider: "openai",
		model: "gpt-5.2",
		inputTokens: 200_000,
		outputTokens: 100_000,
		// 0.2M * $5 (input) + 0.1M * $15 (output) = $2.50
		expectedCost: 2.5,
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
});
