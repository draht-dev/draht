import { describe, expect, test } from "bun:test";
import { parseRangeHeader, reconcileAndTouch, touchCacheOrder } from "../public/sw-cache.js";

describe("touchCacheOrder", () => {
	test("appends a new key and evicts nothing under the cap", () => {
		const { order, evicted } = touchCacheOrder(["a", "b"], "c", 5);
		expect(order).toEqual(["a", "b", "c"]);
		expect(evicted).toEqual([]);
	});

	test("evicts the oldest entries once the cap is exceeded", () => {
		const { order, evicted } = touchCacheOrder(["a", "b", "c"], "d", 3);
		expect(order).toEqual(["b", "c", "d"]);
		expect(evicted).toEqual(["a"]);
	});

	test("moves an already-cached key to the most-recently-used end without evicting", () => {
		const { order, evicted } = touchCacheOrder(["a", "b", "c"], "a", 3);
		expect(order).toEqual(["b", "c", "a"]);
		expect(evicted).toEqual([]);
	});

	test("evicts down to the cap even if it starts far over it", () => {
		const { order, evicted } = touchCacheOrder(["a", "b", "c", "d", "e"], "f", 2);
		expect(order).toEqual(["e", "f"]);
		expect(evicted).toEqual(["a", "b", "c", "d"]);
	});
});

describe("reconcileAndTouch", () => {
	test("treats a key present in the cache but missing from bookkeeping as oldest", () => {
		// Simulates the lost-update race: "b" was cache.put but the order write
		// never landed, so a naive touch of "c" would never know "b" exists.
		// Reconciliation puts it at the front (oldest) so it is first to evict.
		const { order, evicted } = reconcileAndTouch(["a"], ["a", "b"], "c", 2);
		expect(order).toEqual(["a", "c"]);
		expect(evicted).toEqual(["b"]);
	});

	test("drops bookkeeping for a key the cache no longer actually has", () => {
		const { order, evicted } = reconcileAndTouch(["a", "b"], ["b"], "c", 5);
		expect(order).toEqual(["b", "c"]);
		expect(evicted).toEqual([]);
	});

	test("behaves like touchCacheOrder when bookkeeping already matches the cache", () => {
		const { order, evicted } = reconcileAndTouch(["a", "b"], ["a", "b"], "a", 5);
		expect(order).toEqual(["b", "a"]);
		expect(evicted).toEqual([]);
	});
});

describe("parseRangeHeader", () => {
	test("parses a start-end range", () => {
		expect(parseRangeHeader("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
	});

	test("parses an open-ended range, clamped to the total size", () => {
		expect(parseRangeHeader("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
	});

	test("parses a suffix range (last N bytes)", () => {
		expect(parseRangeHeader("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
	});

	test("clamps an end beyond the total size", () => {
		expect(parseRangeHeader("bytes=0-9999", 1000)).toEqual({ start: 0, end: 999 });
	});

	test("returns null for a missing header", () => {
		expect(parseRangeHeader(null, 1000)).toBeNull();
		expect(parseRangeHeader(undefined, 1000)).toBeNull();
	});

	test("returns null for a malformed header", () => {
		expect(parseRangeHeader("bytes=abc-def", 1000)).toBeNull();
		expect(parseRangeHeader("items=0-10", 1000)).toBeNull();
	});

	test("returns null for an unsatisfiable range (start past the end)", () => {
		expect(parseRangeHeader("bytes=5000-6000", 1000)).toBeNull();
	});

	test("returns null when start is after end", () => {
		expect(parseRangeHeader("bytes=500-100", 1000)).toBeNull();
	});
});
