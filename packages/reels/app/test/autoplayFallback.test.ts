import { describe, expect, test } from "bun:test";
import { resolveAutoplayGesture } from "../src/lib/autoplayFallback.js";

describe("resolveAutoplayGesture", () => {
	test("already-muted rejection means even muted autoplay was blocked: show play", () => {
		expect(resolveAutoplayGesture(true, false)).toBe("play");
	});

	test("unmuted attempt rejected, muted retry succeeded: show unmute", () => {
		expect(resolveAutoplayGesture(false, true)).toBe("unmute");
	});

	test("unmuted attempt rejected, muted retry also rejected: show play", () => {
		expect(resolveAutoplayGesture(false, false)).toBe("play");
	});
});
