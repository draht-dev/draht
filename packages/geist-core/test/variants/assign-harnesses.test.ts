import { describe, expect, test } from "bun:test";
import { assignHarnessesRoundRobin } from "../../src/variants/assign-harnesses.js";

/**
 * Unit tests for `assignHarnessesRoundRobin` (spec §9.2 `variants_new` row,
 * §2/§16 M6 "variants, optionally mixed"). Pure function — no git, no fleet.
 */
describe("assignHarnessesRoundRobin", () => {
	test("cycles through the provided harness list round-robin, even when count isn't divisible by list length", () => {
		expect(assignHarnessesRoundRobin(5, ["claude", "codex"], "draht")).toEqual([
			"claude",
			"codex",
			"claude",
			"codex",
			"claude",
		]);
	});

	test("assigns one harness per slot when count is a clean multiple of the list length", () => {
		expect(assignHarnessesRoundRobin(3, ["claude", "codex", "draht"], "draht")).toEqual(["claude", "codex", "draht"]);
	});

	test("every slot gets the default harness when the list is omitted (undefined)", () => {
		expect(assignHarnessesRoundRobin(3, undefined, "draht")).toEqual(["draht", "draht", "draht"]);
	});

	test("every slot gets the default harness when the list is empty (the grammar's [] for a bare `variants n`)", () => {
		expect(assignHarnessesRoundRobin(3, [], "draht")).toEqual(["draht", "draht", "draht"]);
	});

	test("count=1 with a list returns a single-element array (the first harness)", () => {
		expect(assignHarnessesRoundRobin(1, ["claude", "codex"], "draht")).toEqual(["claude"]);
	});

	test("count=1 with no list returns a single default harness", () => {
		expect(assignHarnessesRoundRobin(1, undefined, "draht")).toEqual(["draht"]);
	});

	test("throws RangeError for a non-positive or non-integer count", () => {
		expect(() => assignHarnessesRoundRobin(0, ["claude"], "draht")).toThrow(RangeError);
		expect(() => assignHarnessesRoundRobin(-2, undefined, "draht")).toThrow(RangeError);
		expect(() => assignHarnessesRoundRobin(1.5, undefined, "draht")).toThrow(RangeError);
	});
});
