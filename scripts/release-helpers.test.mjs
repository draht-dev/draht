import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	EXPECTED_RELEASE_ASSETS,
	assertReleaseVersions,
	getScopePackages,
	listGithubReleaseAssets,
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

test("release asset gate requires every primary and graph runtime archive", () => {
	assert.deepEqual(EXPECTED_RELEASE_ASSETS, [
		"pi-darwin-arm64.tar.gz",
		"pi-darwin-x64.tar.gz",
		"pi-linux-x64.tar.gz",
		"pi-linux-arm64.tar.gz",
		"pi-windows-x64.zip",
		"manifest.json",
		"SHA256SUMS",
		"draht-graph-darwin-arm64.tar.gz",
		"draht-graph-darwin-x64.tar.gz",
		"draht-graph-linux-x64.tar.gz",
		"draht-graph-linux-arm64.tar.gz",
		"draht-graph-windows-x64.zip",
	]);
	assert.deepEqual(missingReleaseAssets(["manifest.json", "SHA256SUMS"]), [
		...EXPECTED_RELEASE_ASSETS.slice(0, 5),
		...EXPECTED_RELEASE_ASSETS.slice(7),
	]);
});

test("release asset gate polls until all required assets exist", async () => {
	let calls = 0;
	const assets = await waitForReleaseAssets({
		tag: "v2.0.0",
		attempts: 2,
		intervalMs: 0,
		listAssets: async () => (++calls === 1 ? ["manifest.json"] : EXPECTED_RELEASE_ASSETS),
	});
	assert.equal(calls, 2);
	assert.deepEqual(assets, EXPECTED_RELEASE_ASSETS);
});

test("release asset gate rejects a release that remains partial", async () => {
	await assert.rejects(
		waitForReleaseAssets({ tag: "v2.0.0", attempts: 2, intervalMs: 0, listAssets: async () => ["manifest.json"] }),
		/SHA256SUMS.*draht-graph-windows-x64\.zip/s,
	);
});

test("GitHub release lookup uses the API without requiring gh and authenticates when configured", async () => {
	let request;
	const assets = await listGithubReleaseAssets("v2.0.0+rc", {
		token: "test-token",
		fetchImpl: async (url, options) => {
			request = { url, options };
			return { ok: true, json: async () => ({ assets: [{ name: "manifest.json" }] }) };
		},
	});
	assert.equal(request.url, "https://api.github.com/repos/draht-dev/draht/releases/tags/v2.0.0%2Brc");
	assert.equal(request.options.headers.Authorization, "Bearer test-token");
	assert.deepEqual(assets, [{ name: "manifest.json" }]);
});

test("go changelog scope reaches every npm package that ships or resolves the graph engine", () => {
	assert.deepEqual(getScopePackages("go"), ["coding-agent", "draht-claude", "draht-codex"]);
});
