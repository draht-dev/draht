import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("scheduled releases are opt-in, credentialed, and routed through the release script", () => {
	const workflow = readFileSync(join(process.cwd(), ".github/workflows/scheduled-release.yml"), "utf8");
	assert.match(workflow, /cron: '17 3 \* \* \*'/);
	assert.match(workflow, /vars\.DRAHT_RELEASES_ENABLED == 'true'/);
	assert.match(workflow, /secrets\.DRAHT_RELEASE_TOKEN/);
	assert.match(workflow, /secrets\.NPM_TOKEN/);
	assert.match(workflow, /token: \$\{\{ secrets\.DRAHT_RELEASE_TOKEN \}\}/);
	assert.match(workflow, /npm run check/);
	assert.match(workflow, /run: npm run release/);
	assert.doesNotMatch(workflow, /run: (?:npm|bun) publish/);
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


test("release workflow splits attestation authority from immutable release attachment", () => {
	const workflow = readFileSync(join(process.cwd(), ".github/workflows/build-binaries.yml"), "utf8");
	assert.doesNotMatch(workflow, /workflow_dispatch/,
		"manual dispatch cannot produce tag-ref-bound GitHub provenance even when checkout uses a tag");
	assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
	assert.doesNotMatch(workflow, /--clobber|gh release upload/);
	assert.match(workflow, /gh release view "\$\{RELEASE_TAG\}"[\s\S]*exit 1[\s\S]*gh release create/);
	const attestJob = workflow.match(/\n  attest:\n([\s\S]*?)(?=\n  release:\n)/)?.[1] ?? "";
	const releaseJob = workflow.match(/\n  release:\n([\s\S]*)$/)?.[1] ?? "";
	assert.match(attestJob, /permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write/);
	assert.doesNotMatch(attestJob, /contents: write|gh release/);
	assert.match(attestJob, /actions\/attest-build-provenance@[0-9a-f]{40}/);
	assert.match(releaseJob, /needs: \[build-runtime, build-graph, attest\]/);
	assert.match(releaseJob, /permissions:\n\s+contents: write/);
	assert.doesNotMatch(releaseJob, /id-token: write|attestations: write|attest-build-provenance/);
	assert.match(releaseJob, /gh release create/);
	assert.doesNotMatch(releaseJob, /assets=\([^)]*\*/s, "release attachment must not use asset wildcards");
	const attachedAssets = [...releaseJob.matchAll(/^\s+release-assets\/(?:runtime|graph)\/([^\s)]+)$/gm)].map((match) => match[1]);
	assert.deepEqual(attachedAssets.sort(), [...EXPECTED_RELEASE_ASSETS].sort(), "release job must attach exactly the canonical 14 assets");
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

function provenanceStatement({ digest, commit, tag = "v2.0.0" }) {
	return {
		_type: "https://in-toto.io/Statement/v1",
		predicateType: "https://slsa.dev/provenance/v1",
		subject: [{ name: "draht-linux-x64.tar.gz", digest: { sha256: digest } }],
		predicate: {
			buildDefinition: {
				buildType: "https://actions.github.io/buildtypes/workflow/v1",
				externalParameters: {
					workflow: {
						repository: "https://github.com/draht-dev/draht",
						ref: `refs/tags/${tag}`,
						path: ".github/workflows/build-binaries.yml",
					},
				},
				resolvedDependencies: [{ uri: `git+https://github.com/draht-dev/draht@refs/tags/${tag}`, digest: { gitCommit: commit } }],
			},
			runDetails: {
				builder: { id: `https://github.com/draht-dev/draht/.github/workflows/build-binaries.yml@refs/tags/${tag}` },
			},
		},
	};
}

function attestationFetch(statement) {
	return async () => ({
		ok: true,
		json: async () => ({
			attestations: [{ bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }],
		}),
	});
}

test("GitHub attestation structurally binds an asset to SLSA provenance, repository, commit, and workflow", async () => {
	const digest = "a".repeat(64);
	const commit = "b".repeat(40);
	const tag = "v2.0.0";
	const statement = provenanceStatement({ digest, commit, tag });
	await assert.doesNotReject(() => verifyGithubAttestation({ name: "draht-linux-x64.tar.gz", digest, commit, tag, fetchImpl: attestationFetch(statement) }));
	await assert.rejects(
		() => verifyGithubAttestation({ name: "draht-linux-x64.tar.gz", digest, commit: "c".repeat(40), tag, fetchImpl: attestationFetch(statement) }),
		/not bound.*commit/i,
	);
});

test("GitHub attestation rejects expected values spoofed only in an unrelated note", async () => {
	const digest = "a".repeat(64);
	const commit = "b".repeat(40);
	const tag = "v2.0.0";
	const statement = provenanceStatement({ digest, commit: "c".repeat(40), tag });
	statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/attacker/repo";
	statement.predicate.runDetails.builder.id = "https://github.com/attacker/repo/.github/workflows/evil.yml@refs/tags/v2.0.0";
	statement.note = `draht-dev/draht ${commit} .github/workflows/build-binaries.yml`;
	await assert.rejects(
		() => verifyGithubAttestation({ name: "draht-linux-x64.tar.gz", digest, commit, tag, fetchImpl: attestationFetch(statement) }),
		/not bound/i,
	);
});

test("GitHub attestation rejects wrong in-toto type, predicate type, repository URI, or workflow identity", async (t) => {
	const digest = "a".repeat(64);
	const commit = "b".repeat(40);
	const tag = "v2.0.0";
	for (const [label, mutate] of [
		["statement type", (s) => { s._type = "https://in-toto.io/Statement/v0.1"; }],
		["predicate type", (s) => { s.predicateType = "https://example.test/provenance"; }],
		["repository URI", (s) => { s.predicate.buildDefinition.resolvedDependencies[0].uri += "/fork"; }],
		["source URI without the attested tag ref", (s) => { s.predicate.buildDefinition.resolvedDependencies[0].uri = "git+https://github.com/draht-dev/draht"; }],
		["workflow identity", (s) => { s.predicate.runDetails.builder.id = "https://github.com/draht-dev/draht/.github/workflows/other.yml@refs/tags/v2.0.0"; }],
	]) {
		await t.test(label, async () => {
			const statement = provenanceStatement({ digest, commit, tag });
			mutate(statement);
			await assert.rejects(
				() => verifyGithubAttestation({ name: "asset", digest, commit, tag, fetchImpl: attestationFetch(statement) }),
				/not bound/i,
			);
		});
	}
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

function makeMalformedGraphArchive(kind) {
	const root = mkdtempSync(join(tmpdir(), "draht-malformed-archive-"));
	try {
		mkdirSync(join(root, "draht-graph"), { recursive: true });
		writeFileSync(join(root, "draht-graph/draht-graph"), "graph-binary:linux-x64");
		writeFileSync(join(root, "draht-graph/LICENSE"), "license");
		writeFileSync(join(root, "target"), "readme");
		const readme = join(root, "draht-graph/README.md");
		if (kind === "hardlink") linkSync(join(root, "draht-graph/LICENSE"), readme);
		else if (kind === "symlink") symlinkSync("LICENSE", readme);
		else if (kind === "fifo") {
			const fifo = spawnSync("mkfifo", [readme], { encoding: "utf8" });
			assert.equal(fifo.status, 0, fifo.stderr);
		} else writeFileSync(readme, "readme");
		const tarPath = join(root, "asset.tar");
		let result = spawnSync("tar", ["-cf", tarPath, "draht-graph"], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		if (kind === "duplicate") {
			result = spawnSync("tar", ["-rf", tarPath, "draht-graph/README.md"], { cwd: root, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const gzipPath = `${tarPath}.gz`;
		result = spawnSync("gzip", ["-c", tarPath], { encoding: null });
		assert.equal(result.status, 0, result.stderr?.toString());
		writeFileSync(gzipPath, result.stdout);
		return readFileSync(gzipPath);
	} finally { rmSync(root, { recursive: true, force: true }); }
}

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, content, mode = 0o100644 } of entries) {
		const nameBytes = Buffer.from(name);
		const bytes = Buffer.from(content);
		const checksum = crc32(bytes);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(bytes.length, 18);
		local.writeUInt32LE(bytes.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, bytes);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x031e, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(bytes.length, 20);
		central.writeUInt32LE(bytes.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE((mode << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + bytes.length;
	}
	const centralBytes = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBytes, end]);
}

function makeMalformedGraphZip(kind) {
	const entries = [
		{ name: "draht-graph/draht-graph.exe", content: "graph-binary:windows-x64" },
		{ name: "draht-graph/LICENSE", content: "license" },
		kind === "symlink"
			? { name: "draht-graph/README.md", content: "LICENSE", mode: 0o120777 }
			: kind === "fifo"
				? { name: "draht-graph/README.md", content: "", mode: 0o010644 }
				: kind === "device"
					? { name: "draht-graph/README.md", content: "", mode: 0o060644 }
					: { name: "draht-graph/README.md", content: "readme" },
	];
	if (kind === "duplicate") entries.push({ name: "draht-graph/README.md", content: "second" });
	return makeStoredZip(entries);
}

function replaceGraphArchive(fixture, platform, bytes) {
	const artifact = fixture.manifest.artifacts.find((item) => item.platform === platform);
	artifact.archiveBytes = bytes.length;
	artifact.archiveSha256 = sha256(bytes);
	fixture.downloads.set(`https://api.github.test/${artifact.archive}`, bytes);
	fixture.release.assets.find((asset) => asset.name === artifact.archive).size = bytes.length;
	fixture.downloads.set("https://api.github.test/SHA256SUMS", Buffer.from(`${fixture.manifest.artifacts.flatMap((item) => [`${item.archiveSha256}  ${item.archive}`, `${item.binarySha256}  ${item.platform}/${item.binary}`]).join("\n")}\n`));
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
			const asset = assets.find((item) => item.url === url);
			if (asset && bytes) asset.size = bytes.length;
			return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404, statusText: "Not Found" });
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

test("release validator rejects real tar archives with duplicate, symlink, hardlink, or FIFO members", async (t) => {
	for (const kind of ["duplicate", "symlink", "hardlink", "fifo"]) {
		await t.test(kind, async () => {
			const fixture = verifiedReleaseFixture();
			replaceGraphArchive(fixture, "linux-x64", makeMalformedGraphArchive(kind));
			await assert.rejects(
				() => validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
				/invalid archive.*(?:duplicate|entry type|special|regular)/i,
			);
		});
	}
});

test("release validator rejects real ZIP archives with duplicate, symlink, FIFO, or device members", async (t) => {
	for (const kind of ["duplicate", "symlink", "fifo", "device"]) {
		await t.test(kind, async () => {
			const fixture = verifiedReleaseFixture();
			replaceGraphArchive(fixture, "windows-x64", makeMalformedGraphZip(kind));
			await assert.rejects(
				() => validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
				/invalid archive.*(?:duplicate|entry type|special|regular)/i,
			);
		});
	}
});

test("release artifact validation rejects missing, duplicate, pi-prefixed, and unexpected assets", async (t) => {
	for (const [label, mutate, pattern] of [
		["missing", (assets) => assets.filter(({ name }) => name !== "draht-linux-arm64.tar.gz"), /draht-linux-arm64\.tar\.gz/],
		["duplicate", (assets) => [...assets, { ...assets[0] }], /duplicate.*asset/i],
		["legacy pi", (assets) => [...assets, { name: "pi-linux-x64.tar.gz", size: 1, url: "https://api.github.test/pi" }], /unexpected.*pi-linux-x64/i],
		["unexpected", (assets) => [...assets, { name: "notes.txt", size: 1, url: "https://api.github.test/notes" }], /unexpected.*notes\.txt/i],
	]) {
		await t.test(label, async () => {
			const fixture = verifiedReleaseFixture();
			fixture.release.assets = mutate(fixture.release.assets);
			await assert.rejects(
				validateReleaseArtifacts({
					tag: "v2.0.0",
					version: "2.0.0",
					commit: fixture.commit,
					release: fixture.release,
					fetchImpl: fixture.fetchImpl,
					verifyAttestation: fixture.verifyAttestation,
				}),
				pattern,
			);
		});
	}
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

test("release artifact streaming cancels a missing or lying Content-Length overrun", async () => {
	const fixture = verifiedReleaseFixture();
	const manifestAsset = fixture.release.assets.find((asset) => asset.name === "manifest.json");
	let cancelled = false;
	const original = fixture.fetchImpl;
	const fetchImpl = async (url, options) => {
		if (url !== manifestAsset.url) return original(url, options);
		let stage = 0;
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-length": "1" }),
			body: { getReader: () => ({
				async read() {
					if (stage++ === 0) return { done: false, value: fixture.downloads.get(url) };
					return { done: false, value: Buffer.from("overrun") };
				},
				async cancel() { cancelled = true; },
			}) },
		};
	};
	await assert.rejects(
		() => validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture, fetchImpl }),
		/manifest\.json.*(?:declared|byte|size).*limit|limit.*manifest\.json/i,
	);
	assert.equal(cancelled, true, "bounded reader must cancel immediately on overrun");
});

test("release artifact aggregate metadata limit fails before any download", async () => {
	const fixture = verifiedReleaseFixture();
	for (const asset of fixture.release.assets) if (asset.name.endsWith(".tar.gz") || asset.name.endsWith(".zip")) asset.size = 110 * 1024 * 1024;
	let downloads = 0;
	await assert.rejects(
		() => validateReleaseArtifacts({
			tag: "v2.0.0",
			version: "2.0.0",
			...fixture,
			fetchImpl: async () => { downloads++; throw new Error("must not download"); },
		}),
		/aggregate.*limit/i,
	);
	assert.equal(downloads, 0);
});

test("release validator rejects compressed expansion beyond the manifest-bound budget", async () => {
	const fixture = verifiedReleaseFixture();
	const bytes = makeArchive("draht-graph-linux-x64.tar.gz", {
		"draht-graph/draht-graph": "graph-binary:linux-x64",
		"draht-graph/README.md": "readme",
		"draht-graph/LICENSE": "license",
		"draht-graph/padding": Buffer.alloc(20 * 1024 * 1024),
	});
	replaceGraphArchive(fixture, "linux-x64", bytes);
	await assert.rejects(
		() => validateReleaseArtifacts({ tag: "v2.0.0", version: "2.0.0", ...fixture }),
		/decompress|expanded/i,
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
				? new Response(Buffer.from("{not-json"), { status: 200 })
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
