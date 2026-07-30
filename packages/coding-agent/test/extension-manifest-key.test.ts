import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function fixture(manifestKey: "draht" | "pi" | null) {
	const root = mkdtempSync(join(tmpdir(), "draht-manifest-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export default function () {}\n");
	const pkg: Record<string, unknown> = { name: "fixture", version: "1.0.0" };
	if (manifestKey) pkg[manifestKey] = { extensions: ["./src/index.ts"] };
	writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
	return root;
}

describe("extension manifest key", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "draht-agent-"));
	const pm = new DefaultPackageManager({
		cwd: agentDir,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
	}) as unknown as { readPiManifest(root: string): { extensions?: string[] } | null };

	test('reads the "draht" key', () => {
		expect(pm.readPiManifest(fixture("draht"))?.extensions).toEqual(["./src/index.ts"]);
	});

	test('still reads upstream\'s "pi" key', () => {
		expect(pm.readPiManifest(fixture("pi"))?.extensions).toEqual(["./src/index.ts"]);
	});

	test("returns null when neither key is present", () => {
		expect(pm.readPiManifest(fixture(null))).toBeNull();
	});
});
