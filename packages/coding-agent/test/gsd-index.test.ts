import { describe, expect, it } from "vitest";

describe("gsd index exports", () => {
	it("exports all planning functions from src/gsd/index.ts", async () => {
		const mod = await import("../src/gsd/index.js");
		expect(typeof mod.createPlan).toBe("function");
		expect(typeof mod.discoverPlans).toBe("function");
		expect(typeof mod.readPlan).toBe("function");
		expect(typeof mod.writeSummary).toBe("function");
		expect(typeof mod.verifyPhase).toBe("function");
		expect(typeof mod.updateState).toBe("function");
	});

	it("exports all domain functions from src/gsd/index.ts", async () => {
		const mod = await import("../src/gsd/index.js");
		expect(typeof mod.createDomainModel).toBe("function");
		expect(typeof mod.mapCodebase).toBe("function");
	});

	it("exports all git functions from src/gsd/index.ts", async () => {
		const mod = await import("../src/gsd/index.js");
		expect(typeof mod.commitTask).toBe("function");
		expect(typeof mod.commitDocs).toBe("function");
		expect(typeof mod.hasTestFiles).toBe("function");
	});
});
