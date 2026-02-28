import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";

describe("extensions draht manifest loading", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-ext-test-"));
		extensionsDir = path.join(tempDir, ".draht", "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should discover extensions from .draht/extensions directory", async () => {
		// Create a simple extension
		const extDir = path.join(extensionsDir, "test-ext");
		fs.mkdirSync(extDir);
		fs.writeFileSync(
			path.join(extDir, "index.ts"),
			`export default function(draht) { draht.registerCommand("hello", { handler: async () => {} }); }`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, path.join(tempDir, ".draht", "agent"));

		expect(result.extensions.length).toBeGreaterThanOrEqual(1);
	});

	it("should load extension with draht manifest in package.json", async () => {
		const extDir = path.join(extensionsDir, "manifest-ext");
		fs.mkdirSync(extDir);
		fs.writeFileSync(
			path.join(extDir, "package.json"),
			JSON.stringify({
				name: "test-manifest-ext",
				draht: {
					extensions: ["./ext.ts"],
				},
			}),
		);
		fs.writeFileSync(
			path.join(extDir, "ext.ts"),
			`export default function(draht) { draht.registerCommand("manifest-hello", { handler: async () => {} }); }`,
		);

		const result = await discoverAndLoadExtensions([], tempDir, path.join(tempDir, ".draht", "agent"));

		const manifestExt = result.extensions.find((e) => e.commands.has("manifest-hello"));
		expect(manifestExt).toBeDefined();
	});
});
