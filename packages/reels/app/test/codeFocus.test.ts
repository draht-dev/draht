import { describe, expect, test } from "bun:test";
import { codeLineStates } from "../src/lib/codeFocus.js";

describe("codeLineStates", () => {
	test("every line is normal with no focus", () => {
		expect(codeLineStates(4, undefined)).toEqual(["normal", "normal", "normal", "normal"]);
	});

	test("lines inside the focus range are focused, the rest dimmed", () => {
		expect(codeLineStates(5, { lines: [2, 3] })).toEqual(["dimmed", "focused", "focused", "dimmed", "dimmed"]);
	});

	test("an order-independent range still focuses the right lines", () => {
		expect(codeLineStates(3, { lines: [3, 1] })).toEqual(["focused", "focused", "focused"]);
	});

	test("a focus with no node field is ignored (code scenes only read lines)", () => {
		expect(codeLineStates(2, { nodes: ["A"] })).toEqual(["normal", "normal"]);
	});
});
