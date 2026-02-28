import { describe, expect, it } from "vitest";

describe("ci reviewer", () => {
	it("should export module", async () => {
		const mod = await import("../src/reviewer.js");
		expect(mod).toBeDefined();
	});
});
