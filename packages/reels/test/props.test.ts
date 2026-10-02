import { describe, expect, test } from "bun:test";
import { msToFrames } from "../src/remotion/props.ts";

describe("msToFrames", () => {
	test("maps 0ms to frame 0, not frame 1 (a scene starting at ms=0 must land on frame 0 or frame 0 renders blank)", () => {
		expect(msToFrames(0, 30)).toBe(0);
	});

	test("rounds to the nearest frame", () => {
		expect(msToFrames(1000, 30)).toBe(30);
		expect(msToFrames(500, 30)).toBe(15);
	});
});
