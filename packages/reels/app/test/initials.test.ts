import { describe, expect, test } from "bun:test";
import { initials } from "../src/lib/initials.js";

describe("initials", () => {
	test("takes the first letter of up to two hyphen/space/slash-separated parts", () => {
		expect(initials("draht-mono")).toBe("DM");
		expect(initials("geist console")).toBe("GC");
		expect(initials("a/b/c")).toBe("AB");
	});

	test("uppercases", () => {
		expect(initials("lowercase")).toBe("L");
	});

	test("handles a single-word name", () => {
		expect(initials("reels")).toBe("R");
	});
});
