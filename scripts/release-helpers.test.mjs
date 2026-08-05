import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
	EXPECTED_RELEASE_ASSETS,
	assertBunToolchain,
	assertReleaseVersions,
	getScopePackages,
	listGithubReleaseAssets,
	missingReleaseAssets,
	setVersion,
	validateReleaseArtifacts,
	verifyGithubAttestation,
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
	writeFileSync(join(root, "bun.lock"), `{"workspaces":{"packages/a":{"name":"a","version":"0.9.0"},"packages/draht-claude":{"name":"draht-claude","version":"0.9.0"},"packages/draht-codex":{"name":"draht-codex","version":"0.9.0"}}}`);
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
	assert.doesNotMatch(readFileSync(join(root, "bun.lock"), "utf8"), /0\.9\.0/);
});

test("repository uses Bun as its single authoritative dependency lock", () => {
	assert.equal(existsSync(join(process.cwd(), "package-lock.json")), false, "stale npm lockfile must not coexist with bun.lock");
	assert.equal(existsSync(join(process.cwd(), "bun.lock")), true);
	const releaseScript = readFileSync(join(process.cwd(), "scripts/release.mjs"), "utf8");
	assert.match(releaseScript, /bun install --lockfile-only --ignore-scripts/);
	assert.match(releaseScript, /bun install --frozen-lockfile --ignore-scripts --linker hoisted/);
});

test("release toolchain requires the exact pinned Bun canary revision", () => {
	assert.doesNotThrow(() => assertBunToolchain(process.cwd(), () => "1.3.14-canary.1+ed1c48f2b"));
	assert.throws(
		() => assertBunToolchain(process.cwd(), () => "1.4.0-canary.1+wrong"),
		/Bun revision.*does not match required/,
	);
	const workflow = readFileSync(join(process.cwd(), ".github/workflows/build-binaries.yml"), "utf8");
	assert.match(workflow, /BUN_PACKAGE_VERSION: 1\.3\.13-canary\.20260425\.1/);
	assert.match(workflow, /BUN_REVISION: 1\.3\.14-canary\.1\+ed1c48f2b/);
});

test("release asset gate requires every primary and graph runtime archive", () => {
	assert.deepEqual(EXPECTED_RELEASE_ASSETS, [
		"draht-darwin-arm64.tar.gz",
		"draht-darwin-x64.tar.gz",
		"draht-linux-x64.tar.gz",
		"draht-linux-arm64.tar.gz",
		"draht-windows-x64.zip",
		"runtime-manifest.json",
		"DRAHT-SHA256SUMS",
		"manifest.json",
		"SHA256SUMS",
		"draht-graph-darwin-arm64.tar.gz",
		"draht-graph-darwin-x64.tar.gz",
		"draht-graph-linux-x64.tar.gz",
		"draht-graph-linux-arm64.tar.gz",
		"draht-graph-windows-x64.zip",
	]);
	assert.deepEqual(missingReleaseAssets(["manifest.json", "SHA256SUMS"]), EXPECTED_RELEASE_ASSETS.filter((name) => !["manifest.json", "SHA256SUMS"].includes(name)));
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
	assert.match(buildScript, /bun --revision/);
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

test("GitHub attestation binds an asset digest to the release repository and commit", async () => {
	const digest = "a".repeat(64);
	const commit = "b".repeat(40);
	const statement = {
		subject: [{ name: "draht-linux-x64.tar.gz", digest: { sha256: digest } }],
		predicate: {
			buildDefinition: {
				resolvedDependencies: [{ uri: "git+https://github.com/draht-dev/draht", digest: { gitCommit: commit } }],
			},
		},
	};
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({
			attestations: [{ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }],
		}),
	});
	await assert.doesNotReject(() => verifyGithubAttestation({ name: "draht-linux-x64.tar.gz", digest, commit, fetchImpl }));
	await assert.rejects(
		() => verifyGithubAttestation({ name: "draht-linux-x64.tar.gz", digest, commit: "c".repeat(40), fetchImpl }),
		/not bound.*commit/i,
	);
});

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function makeArchive(name, files) {
	const root = mkdtempSync(join(tmpdir(), "draht-release-fixture-"));
	try {
		for (const [relative, content] of Object.entries(files)) {
			mkdirSync(join(root, relative, ".."), { recursive: true });
			writeFileSync(join(root, relative), content);
		}
		const output = join(root, name);
		const paths = Object.keys(files);
		const result = name.endsWith(".zip")
			? spawnSync("zip", ["-q", output, ...paths], { cwd: root, encoding: "utf8" })
			: spawnSync("tar", ["-czf", output, ...[...new Set(paths.map((path) => path.split("/")[0]))]], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return readFileSync(output);
	} finally { rmSync(root, { recursive: true, force: true }); }
}

function verifiedReleaseFixture(version = "2.0.0") {
	const commit = "1".repeat(40);
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
		const binaryBytes = Buffer.from(`graph-binary:${platform}`);
		const bytes = makeArchive(archive, {
			[`draht-graph/${metadata.binary}`]: binaryBytes,
			"draht-graph/README.md": "readme",
			"draht-graph/LICENSE": "license",
		});
		downloads.set(`https://api.github.test/${archive}`, bytes);
		return { platform, ...metadata, archive, archiveBytes: bytes.length, archiveSha256: sha256(bytes), binaryBytes: binaryBytes.length, binarySha256: sha256(binaryBytes) };
	});
	const runtimeArtifacts = Object.keys(platforms).map((platform) => {
		const archive = `draht-${platform}${platform === "windows-x64" ? ".zip" : ".tar.gz"}`;
		const binary = platform === "windows-x64" ? "draht.exe" : "draht";
		const binaryBytes = Buffer.from(`runtime-binary:${platform}`);
		const bytes = makeArchive(archive, { [platform === "windows-x64" ? binary : `draht/${binary}`]: binaryBytes, ...(platform === "windows-x64" ? {} : { "draht/README.md": "readme" }) });
		downloads.set(`https://api.github.test/${archive}`, bytes);
		return {
			platform,
			archive,
			archiveBytes: bytes.length,
			archiveSha256: sha256(bytes),
			binary,
			binaryBytes: binaryBytes.length,
			binarySha256: sha256(binaryBytes),
			files: platform === "windows-x64" ? [binary] : [`draht/${binary}`, "draht/README.md"],
		};
	});
	const manifest = { schemaVersion: 1, name: "draht-graph", version, tag: `v${version}`, gitCommit: commit, artifacts };
	const runtimeManifest = { schemaVersion: 1, name: "draht", version, tag: `v${version}`, gitCommit: commit, artifacts: runtimeArtifacts };
	downloads.set("https://api.github.test/manifest.json", Buffer.from(JSON.stringify(manifest)));
	downloads.set("https://api.github.test/runtime-manifest.json", Buffer.from(JSON.stringify(runtimeManifest)));
	downloads.set("https://api.github.test/SHA256SUMS", Buffer.from(`${artifacts.flatMap((a) => [`${a.archiveSha256}  ${a.archive}`, `${a.binarySha256}  ${a.platform}/${a.binary}`]).join("\n")}\n`));
	downloads.set("https://api.github.test/DRAHT-SHA256SUMS", Buffer.from(`${runtimeArtifacts.map((a) => `${a.archiveSha256}  ${a.archive}`).join("\n")}\n`));
	const assets = EXPECTED_RELEASE_ASSETS.map((name) => {
		const bytes = downloads.get(`https://api.github.test/${name}`);
		return { name, size: bytes.length, url: `https://api.github.test/${name}` };
	});
	return {
		commit,
		release: { tag_name: `v${version}`, assets },
		manifest,
		runtimeManifest,
		downloads,
		verifyAttestation: async () => {},
		fetchImpl: async (url) => {
			const bytes = url.endsWith("/manifest.json") ? Buffer.from(JSON.stringify(manifest)) : url.endsWith("/runtime-manifest.json") ? Buffer.from(JSON.stringify(runtimeManifest)) : downloads.get(url);
			return bytes ? { ok: true, arrayBuffer: async () => bytes } : { ok: false, status: 404, statusText: "Not Found" };
		},
	};
}

test("release verification downloads and validates the manifest and every graph archive", async () => {
	const fixture = verifiedReleaseFixture();
	const manifest = await validateReleaseArtifacts({
		tag: "v2.0.0",
		version: "2.0.0",
		commit: fixture.commit,
		release: fixture.release,
		fetchImpl: fixture.fetchImpl,
		verifyAttestation: fixture.verifyAttestation,
	});
	assert.deepEqual(manifest, fixture.manifest);
});

test("runtime manifest must declare every archive member exactly", async () => {
	const fixture = verifiedReleaseFixture("2.0.0");
	fixture.runtimeManifest.artifacts.find((artifact) => artifact.platform === "linux-x64").files.pop();
	await assert.rejects(
		() => validateReleaseArtifacts({
			tag: "v2.0.0",
			version: "2.0.0",
			commit: fixture.commit,
			release: fixture.release,
			fetchImpl: fixture.fetchImpl,
			verifyAttestation: fixture.verifyAttestation,
		}),
		/payload does not exactly match manifest contract/,
	);
});

test("release artifact validation cannot bypass the complete asset gate", async () => {
	const fixture = verifiedReleaseFixture();
	fixture.release.assets = fixture.release.assets.filter(({ name }) => name !== "draht-linux-arm64.tar.gz");
	await assert.rejects(
		validateReleaseArtifacts({
			tag: "v2.0.0",
			version: "2.0.0",
			commit: fixture.commit,
			release: fixture.release,
			fetchImpl: fixture.fetchImpl,
			verifyAttestation: fixture.verifyAttestation,
		}),
		/draht-linux-arm64\.tar\.gz/,
	);
});

test("release artifact validation rejects oversized assets before download", async () => {
	const fixture = verifiedReleaseFixture();
	fixture.release.assets[0].size = 513 * 1024 * 1024;
	let downloads = 0;
	await assert.rejects(
		() => validateReleaseArtifacts({
			tag: "v2.0.0",
			version: "2.0.0",
			commit: fixture.commit,
			release: fixture.release,
			fetchImpl: async (...args) => {
				downloads++;
				return fixture.fetchImpl(...args);
			},
			verifyAttestation: fixture.verifyAttestation,
		}),
		/positive bounded size/,
	);
	assert.equal(downloads, 0);
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
		commit: current.commit,
		verifyAttestation: current.verifyAttestation,
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
