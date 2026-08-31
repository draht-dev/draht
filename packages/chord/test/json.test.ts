import { describe, expect, test } from "vitest";
import { cloneJsonValue, isJsonValue } from "../src/index.ts";

describe("cloneJsonValue", () => {
	test("clones strict JSON and omits undefined object properties", () => {
		const source = { nested: { value: 1 }, omitted: undefined, values: [true, null, "value"] };
		const cloned = cloneJsonValue(source);
		expect(cloned).toEqual({ nested: { value: 1 }, values: [true, null, "value"] });
		expect(cloned).not.toBe(source);
		expect(cloned.nested).not.toBe(source.nested);
	});

	test.each([[new Date()], [{ value: Number.NaN }], [[undefined]], [Array(1)], [1n]])(
		"rejects non-JSON values",
		(value) => {
			expect(() => cloneJsonValue(value)).toThrow(TypeError);
		},
	);

	test("rejects cycles", () => {
		const value: { self?: unknown } = {};
		value.self = value;
		expect(() => cloneJsonValue(value)).toThrow(/cycles/);
	});

	test("checks strict JSON without normalizing it", () => {
		expect(isJsonValue({ nested: [1, true, null] })).toBe(true);
		expect(isJsonValue({ omitted: undefined })).toBe(false);
		expect(isJsonValue(new Uint8Array([1]))).toBe(false);
		expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(isJsonValue(cyclic)).toBe(false);
	});
});
