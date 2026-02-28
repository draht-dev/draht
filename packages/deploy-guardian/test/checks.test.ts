import { describe, expect, it } from "vitest";

describe("deploy-guardian checks", () => {
	it("should export module", async () => {
		const mod = await import("../src/index.js");
		expect(mod).toBeDefined();
	});
});
