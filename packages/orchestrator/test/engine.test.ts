import { describe, expect, it } from "vitest";

describe("orchestrator engine", () => {
	it("should export module", async () => {
		const mod = await import("../src/index.js");
		expect(mod).toBeDefined();
	});
});
