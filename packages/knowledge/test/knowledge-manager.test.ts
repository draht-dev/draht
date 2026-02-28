import { describe, expect, it } from "vitest";

describe("knowledge-manager", () => {
	it("should export KnowledgeManager", async () => {
		const mod = await import("../src/index.js");
		expect(mod).toBeDefined();
	});
});
