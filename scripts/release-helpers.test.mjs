import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	validateReleaseArtifacts,
	waitForVerifiedRelease,
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

test("repository uses Bun as its single authoritative dependency lock", () => {
	assert.equal(existsSync(join(process.cwd(), "package-lock.json")), false, "stale npm lockfile must not coexist with bun.lock");
	assert.equal(existsSync(join(process.cwd(), "bun.lock")), true);
	const releaseScript = readFileSync(join(process.cwd(), "scripts/release.mjs"), "utf8");
	assert.match(releaseScript, /bun install --lockfile-only --ignore-scripts/);
	assert.match(releaseScript, /bun install --frozen-lockfile --ignore-scripts --linker hoisted/);
});

test("release asset gate requires every primary and graph runtime archive", () => {
	assert.deepEqual(EXPECTED_RELEASE_ASSETS, [
		"draht-darwin-arm64.tar.gz",
		"draht-darwin-x64.tar.gz",
		"draht-linux-x64.tar.gz",
		"draht-linux-arm64.tar.gz",
		"draht-windows-x64.zip",
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
	assert.equal(EXPECTED_RELEASE_ASSETS.some((name) => name.startsWith("pi-")), false, "legacy pi-* assets violate the Draht brand gate");
});

test("primary runtime producers and payloads satisfy the Draht brand gate", () => {
	const workflow = readFileSync(join(process.cwd(), ".github/workflows/build-binaries.yml"), "utf8");
	const buildScript = readFileSync(join(process.cwd(), "scripts/build-binaries.sh"), "utf8");
	for (const asset of EXPECTED_RELEASE_ASSETS.slice(0, 5)) {
		assert.match(workflow, new RegExp(asset.replaceAll(".", "\\.")));
		assert.match(buildScript, new RegExp(asset.replaceAll(".", "\\.")));
	}
	assert.doesNotMatch(workflow, /\bpi-(?:darwin|linux|windows)-/);
	assert.doesNotMatch(buildScript, /\bpi-(?:darwin|linux|windows)-/);
	assert.match(buildScript, /--outfile binaries\/\$platform\/draht(?:\.exe)?/);
	assert.doesNotMatch(buildScript, /--outfile binaries\/\$platform\/pi(?:\.exe)?/);
	assert.match(buildScript, /bun install --frozen-lockfile --linker hoisted/);
	assert.match(buildScript, /bun install --frozen-lockfile --linker hoisted --os='\*' --cpu='\*'/);
	assert.doesNotMatch(buildScript, /bun add/);
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

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function verifiedReleaseFixture(version = "2.0.0") {
	const platforms = {
		"darwin-arm64": { goos: "darwin", goarch: "arm64", binary: "draht-graph" },
		"darwin-x64": { goos: "darwin", goarch: "amd64", binary: "draht-graph" },
		"linux-x64": { goos: "linux", goarch: "amd64", binary: "draht-graph" },
		"linux-arm64": { goos: "linux", goarch: "arm64", binary: "draht-graph" },
		"windows-x64": { goos: "windows", goarch: "amd64", binary: "draht-graph.exe" },
	};
	const downloads = new Map();
	const artifacts = Object.entries(platforms).map(([platform, metadata]) => {
		const archive = `draht-graph-${platform}${platform === "windows-x64" ? ".zip" : ".tar.gz"}`;
		const bytes = Buffer.from(`archive:${platform}`);
		downloads.set(`https://api.github.test/${archive}`, bytes);
		return {
			platform,
			...metadata,
			archive,
			archiveBytes: bytes.length,
			archiveSha256: sha256(bytes),
			binaryBytes: 42,
			binarySha256: "a".repeat(64),
		};
	});
	const manifest = {
		schemaVersion: 1,
		name: "draht-graph",
		version,
		tag: `v${version}`,
		artifacts,
	};
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	downloads.set("https://api.github.test/manifest.json", manifestBytes);
	const assets = EXPECTED_RELEASE_ASSETS.map((name) => {
		const bytes = downloads.get(`https://api.github.test/${name}`) ?? Buffer.from(name);
		return { name, size: bytes.length, url: `https://api.github.test/${name}` };
	});
	return {
		release: { tag_name: `v${version}`, assets },
		manifest,
		downloads,
		fetchImpl: async (url) => {
			const bytes = url.endsWith("manifest.json") ? Buffer.from(JSON.stringify(manifest)) : downloads.get(url);
			return bytes
				? { ok: true, arrayBuffer: async () => bytes }
				: { ok: false, status: 404, statusText: "Not Found" };
		},
	};
}

test("release verification downloads and validates the manifest and every graph archive", async () => {
	const fixture = verifiedReleaseFixture();
	const manifest = await validateReleaseArtifacts({
		tag: "v2.0.0",
		version: "2.0.0",
		release: fixture.release,
		fetchImpl: fixture.fetchImpl,
	});
	assert.deepEqual(manifest, fixture.manifest);
});

test("release artifact validation cannot bypass the complete asset gate", async () => {
	const fixture = verifiedReleaseFixture();
	fixture.release.assets = fixture.release.assets.filter(({ name }) => name !== "draht-linux-arm64.tar.gz");
	await assert.rejects(
		validateReleaseArtifacts({
			tag: "v2.0.0",
			version: "2.0.0",
			release: fixture.release,
			fetchImpl: fixture.fetchImpl,
		}),
		/draht-linux-arm64\.tar\.gz/,
	);
});

test("release verification rejects stale release and manifest identities", async (t) => {
	await t.test("release tag", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.release.tag_name = "v1.9.0";
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/release tag.*v1\.9\.0.*v2\.0\.0/i,
		);
	});
	await t.test("manifest version", async () => {
		const fixture = verifiedReleaseFixture("1.9.0");
		fixture.release.tag_name = "v2.0.0";
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/manifest version.*1\.9\.0.*2\.0\.0/i,
		);
	});
	await t.test("manifest tag", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.tag = "v1.9.0";
		fixture.fetchImpl = async (url) => {
			if (url.endsWith("manifest.json")) return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify(fixture.manifest)) };
			return verifiedReleaseFixture().fetchImpl(url);
		};
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/manifest tag.*v1\.9\.0.*v2\.0\.0/i,
		);
	});
});

test("release verification rejects malformed or unsupported graph manifests", async (t) => {
	await t.test("malformed JSON", async () => {
		const fixture = verifiedReleaseFixture();
		const fetchFixture = fixture.fetchImpl;
		fixture.fetchImpl = async (url, options) =>
			url.endsWith("manifest.json")
				? { ok: true, arrayBuffer: async () => Buffer.from("{not-json") }
				: fetchFixture(url, options);
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/manifest.*JSON/i,
		);
	});
	await t.test("schema version", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.schemaVersion = 2;
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/schemaVersion.*2.*1/i,
		);
	});
	await t.test("manifest name", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.name = "other-graph";
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/manifest name.*other-graph.*draht-graph/i,
		);
	});
});

test("release verification requires exactly one manifest entry for each graph platform", async (t) => {
	await t.test("missing platform", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.artifacts = fixture.manifest.artifacts.filter((artifact) => artifact.platform !== "linux-arm64");
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/missing.*linux-arm64/i,
		);
	});
	await t.test("duplicate platform", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.artifacts[4] = { ...fixture.manifest.artifacts[0] };
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/duplicate.*darwin-arm64/i,
		);
	});
	await t.test("unexpected platform", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.artifacts.push({ ...fixture.manifest.artifacts[0], platform: "freebsd-x64" });
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/unexpected.*freebsd-x64/i,
		);
	});
});

test("release verification rejects graph archive naming, size, and digest mismatches", async (t) => {
	await t.test("archive name does not match its platform", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.artifacts[0].archive = "draht-graph-linux-x64.tar.gz";
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/darwin-arm64.*archive.*draht-graph-darwin-arm64\.tar\.gz/i,
		);
	});
	await t.test("GitHub asset size differs from manifest", async () => {
		const fixture = verifiedReleaseFixture();
		const artifact = fixture.manifest.artifacts[0];
		fixture.release.assets.find((asset) => asset.name === artifact.archive).size += 1;
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/size.*darwin-arm64.*GitHub.*manifest/i,
		);
	});
	await t.test("downloaded archive size differs from manifest", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.artifacts[0].archiveBytes += 1;
		fixture.release.assets.find((asset) => asset.name === fixture.manifest.artifacts[0].archive).size += 1;
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/downloaded size.*darwin-arm64/i,
		);
	});
	await t.test("downloaded archive digest differs from manifest", async () => {
		const fixture = verifiedReleaseFixture();
		fixture.manifest.artifacts[0].archiveSha256 = "0".repeat(64);
		await assert.rejects(
			validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
			/SHA-256.*darwin-arm64/i,
		);
	});
});

test("verified release polling retries filename-complete releases until content validation succeeds", async () => {
	let calls = 0;
	const stale = verifiedReleaseFixture("1.9.0");
	const current = verifiedReleaseFixture("2.0.0");
	const manifest = await waitForVerifiedRelease({
		tag: "v2.0.0",
		version: "2.0.0",
		attempts: 2,
		intervalMs: 0,
		getRelease: async () => (++calls === 1 ? stale.release : current.release),
		fetchImpl: async (url, options) => (calls === 1 ? stale.fetchImpl(url, options) : current.fetchImpl(url, options)),
	});
	assert.equal(calls, 2);
	assert.equal(manifest.version, "2.0.0");
});

test("go changelog scope reaches every npm package that ships or resolves the graph engine", () => {
	assert.deepEqual(getScopePackages("go"), ["coding-agent", "draht-claude", "draht-codex"]);
});
