import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readPiManifest } from "../src/core/pi-manifest.ts";

function fixture(manifestKey: "draht" | "pi" | null) {
	const root = mkdtempSync(join(tmpdir(), "draht-manifest-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export default function () {}\n");
	const pkg: Record<string, unknown> = { name: "fixture", version: "1.0.0" };
	if (manifestKey) pkg[manifestKey] = { extensions: ["./src/index.ts"] };
	writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
	return join(root, "package.json");
}

describe("extension manifest key", () => {
	test('reads the "draht" key', () => {
		expect(readPiManifest(fixture("draht"))?.extensions).toEqual(["./src/index.ts"]);
	});

	test('still reads upstream\'s "pi" key', () => {
		expect(readPiManifest(fixture("pi"))?.extensions).toEqual(["./src/index.ts"]);
	});

	test("returns null when neither key is present", () => {
		expect(readPiManifest(fixture(null))).toBeNull();
	});
});
