import { describe, expect, test } from "bun:test";
import { pickMostVisible } from "../src/lib/visibility.js";

describe("pickMostVisible", () => {
	test("picks the id with the highest ratio", () => {
		const ratios = new Map([
			["a", 0.3],
			["b", 0.9],
			["c", 0.5],
		]);
		expect(pickMostVisible(ratios)).toBe("b");
	});

	test("returns undefined when nothing is visible", () => {
		const ratios = new Map([
			["a", 0],
			["b", 0],
		]);
		expect(pickMostVisible(ratios)).toBeUndefined();
	});

	test("returns undefined for an empty map", () => {
		expect(pickMostVisible(new Map())).toBeUndefined();
	});

	test("keeps the first-seen winner on an exact tie", () => {
		const ratios = new Map([
			["a", 0.75],
			["b", 0.75],
		]);
		expect(pickMostVisible(ratios)).toBe("a");
	});
});
