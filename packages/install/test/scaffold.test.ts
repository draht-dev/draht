import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
	it("test harness runs", () => {
		expect(1 + 1).toBe(2);
	});

	it("matches the explicit publication authorization mode", () => {
		const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		expect(manifest.private).toBe(process.env.DRAHT_INSTALL_PUBLICATION_GATE !== "1");
	});
});
