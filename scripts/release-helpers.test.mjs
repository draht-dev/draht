import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	EXPECTED_GRAPH_RELEASE_ASSETS,
	assertReleaseVersions,
	getScopePackages,
	missingReleaseAssets,
	setVersion,
	waitForReleaseAssets,
} from "./release-helpers.mjs";

function json(path, value) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function versionFixture() {
	const root = mkdtempSync(join(tmpdir(), "draht-release-version-"));
	json(join(root, "package.json"), { name: "root", version: "1.0.0" });
	json(join(root, "packages/a/package.json"), { name: "a", version: "1.0.0" });
	json(join(root, "packages/draht-claude/package.json"), { name: "draht-claude", version: "1.0.0", dependencies: { a: "^1.0.0" } });
	json(join(root, "packages/draht-codex/package.json"), { name: "draht-codex", version: "1.0.0", dependencies: { a: "workspace:*" } });
	json(join(root, "packages/draht-claude/.claude-plugin/plugin.json"), { name: "draht", version: "0.9.0" });
	json(join(root, "packages/draht-codex/.codex-plugin/plugin.json"), { name: "draht", version: "0.9.0" });
	return root;
}

test("stale plugin manifests fail the release version gate", () => {
	const root = versionFixture();
	assert.throws(() => assertReleaseVersions(root, "1.0.0"), /plugin\.json.*0\.9\.0.*1\.0\.0/s);
});

test("setting package versions synchronizes plugin manifests and dependency versions", () => {
	const root = versionFixture();
	setVersion(root, "2.0.0");
	assert.doesNotThrow(() => assertReleaseVersions(root, "2.0.0"));
	assert.equal(JSON.parse(readFileSync(join(root, "packages/draht-claude/.claude-plugin/plugin.json"))).version, "2.0.0");
	assert.equal(JSON.parse(readFileSync(join(root, "packages/draht-codex/.codex-plugin/plugin.json"))).version, "2.0.0");
	assert.equal(JSON.parse(readFileSync(join(root, "packages/draht-claude/package.json"))).dependencies.a, "^2.0.0");
	assert.equal(JSON.parse(readFileSync(join(root, "packages/draht-codex/package.json"))).dependencies.a, "workspace:*");
});

test("release asset gate requires manifest, checksums, and every graph archive", () => {
	assert.deepEqual(EXPECTED_GRAPH_RELEASE_ASSETS, [
		"manifest.json",
		"SHA256SUMS",
		"draht-graph-darwin-arm64.tar.gz",
		"draht-graph-darwin-x64.tar.gz",
		"draht-graph-linux-x64.tar.gz",
		"draht-graph-linux-arm64.tar.gz",
		"draht-graph-windows-x64.zip",
	]);
	assert.deepEqual(missingReleaseAssets(["manifest.json", "SHA256SUMS"]), EXPECTED_GRAPH_RELEASE_ASSETS.slice(2));
});

test("release asset gate polls until all required assets exist", async () => {
	let calls = 0;
	const assets = await waitForReleaseAssets({
		tag: "v2.0.0",
		attempts: 2,
		intervalMs: 0,
		listAssets: async () => (++calls === 1 ? ["manifest.json"] : EXPECTED_GRAPH_RELEASE_ASSETS),
	});
	assert.equal(calls, 2);
	assert.deepEqual(assets, EXPECTED_GRAPH_RELEASE_ASSETS);
});

test("release asset gate rejects a release that remains partial", async () => {
	await assert.rejects(
		waitForReleaseAssets({ tag: "v2.0.0", attempts: 2, intervalMs: 0, listAssets: async () => ["manifest.json"] }),
		/SHA256SUMS.*draht-graph-windows-x64\.zip/s,
	);
});

test("go changelog scope reaches every npm package that ships or resolves the graph engine", () => {
	assert.deepEqual(getScopePackages("go"), ["coding-agent", "draht-claude", "draht-codex"]);
});
