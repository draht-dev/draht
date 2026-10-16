import { describe, expect, it } from "vitest";
import { isValidUsage } from "../src/core/usage-totals.ts";

function validUsage() {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
}

describe("isValidUsage", () => {
	it("accepts a well-formed Usage", () => {
		expect(isValidUsage(validUsage())).toBe(true);
	});

	it("rejects a missing cost field", () => {
		const { cost: _cost, ...rest } = validUsage();
		expect(isValidUsage(rest)).toBe(false);
	});

	it("rejects a non-finite numeric field", () => {
		expect(isValidUsage({ ...validUsage(), input: Number.NaN })).toBe(false);
	});

	it("rejects a non-finite cost field", () => {
		const usage = validUsage();
		expect(isValidUsage({ ...usage, cost: { ...usage.cost, total: Number.POSITIVE_INFINITY } })).toBe(false);
	});

	it("rejects null and non-objects", () => {
		expect(isValidUsage(null)).toBe(false);
		expect(isValidUsage("usage")).toBe(false);
		expect(isValidUsage(undefined)).toBe(false);
	});
});
