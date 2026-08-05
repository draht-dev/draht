import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPLEMENTATIONS = ["draht-claude", "draht-codex"];

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const data = Buffer.from(entry.data || "");
		const compressed = entry.method === 0 ? data : deflateRawSync(data);
		const method = entry.method ?? 8;
		const flags = entry.flags ?? 0;
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(flags, 6); localHeader.writeUInt16LE(method, 8);
		localHeader.writeUInt32LE(crc32(data), 14); localHeader.writeUInt32LE(compressed.length, 18); localHeader.writeUInt32LE(data.length, 22); localHeader.writeUInt16LE(name.length, 26);
		local.push(localHeader, name, compressed);
		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(0x031e, 4); centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(flags, 8); centralHeader.writeUInt16LE(method, 10); centralHeader.writeUInt32LE(crc32(data), 16);
		centralHeader.writeUInt32LE(entry.compressedSize ?? compressed.length, 20); centralHeader.writeUInt32LE(entry.uncompressedSize ?? data.length, 24); centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt32LE(entry.externalAttributes ?? (entry.name.endsWith("/") ? 0x41ed0010 : 0x81a40000), 38); centralHeader.writeUInt32LE(offset, 42);
		central.push(centralHeader, name);
		offset += localHeader.length + name.length + compressed.length;
	}
	const centralBytes = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBytes, eocd]);
}

function validManifest(version = "2026.8.5") {
	return {
		schemaVersion: 1,
		name: "draht-graph",
		version,
		tag: `v${version}`,
		gitCommit: "c".repeat(40),
		artifacts: [{
			platform: "linux-x64",
			goos: "linux",
			goarch: "amd64",
			archive: "draht-graph-linux-x64.tar.gz",
			archiveSha256: "a".repeat(64),
			archiveBytes: 123,
			binary: "draht-graph",
			binarySha256: "b".repeat(64),
			binaryBytes: 45,
		}],
	};
}

for (const implementation of IMPLEMENTATIONS) {
	test(`${implementation} performs controlled ZIP extraction of the exact graph payload`, async () => {
		const { extractGraphZip } = await import(`../packages/${implementation}/graph-archive.mjs`);
		const root = mkdtempSync(join(tmpdir(), `${implementation}-zip-`));
		const archive = join(root, "graph.zip");
		writeFileSync(archive, makeZip([
			{ name: "draht-graph/", data: "", method: 0 },
			{ name: "draht-graph/draht-graph.exe", data: "binary" },
			{ name: "draht-graph/README.md", data: "readme" },
			{ name: "draht-graph/LICENSE", data: "license" },
		]));
		const dest = join(root, "out");
		extractGraphZip(archive, dest, { binary: "draht-graph.exe", binaryBytes: 6, maxUncompressedBytes: 1024, maxCompressedBytes: 1024 });
		assert.equal(readFileSync(join(dest, "draht-graph", "draht-graph.exe"), "utf8"), "binary");
	});

	for (const [label, entries, limits, pattern] of [
		["encrypted members", [{ name: "draht-graph/draht-graph.exe", data: "binary", flags: 1 }], {}, /encrypt/i],
		["duplicate members", [{ name: "draht-graph/draht-graph.exe", data: "binary" }, { name: "draht-graph/draht-graph.exe", data: "binary" }], {}, /duplicate/i],
		["traversal members", [{ name: "../draht-graph.exe", data: "binary" }], {}, /path|traversal/i],
		["symlink members", [{ name: "draht-graph/draht-graph.exe", data: "target", externalAttributes: 0xa1ff0000 }], {}, /link|type/i],
		["device members", [{ name: "draht-graph/draht-graph.exe", data: "", externalAttributes: 0x61ff0000 }], {}, /type|special/i],
		["special members", [{ name: "draht-graph/draht-graph.exe", data: "", externalAttributes: 0x11ff0000 }], {}, /type|special/i],
		["unexpected members", [{ name: "draht-graph/draht-graph.exe", data: "binary" }, { name: "evil", data: "x" }], {}, /unexpected|exact/i],
		["missing members", [{ name: "draht-graph/README.md", data: "readme" }], {}, /missing|exact/i],
		["aggregate uncompressed overrun", [{ name: "draht-graph/draht-graph.exe", data: "binary" }, { name: "draht-graph/README.md", data: "123456" }, { name: "draht-graph/LICENSE", data: "123456" }], { maxUncompressedBytes: 12 }, /uncompressed.*limit/i],
		["aggregate compressed overrun", [{ name: "draht-graph/draht-graph.exe", data: "binary", method: 0 }, { name: "draht-graph/README.md", data: "readme", method: 0 }, { name: "draht-graph/LICENSE", data: "license", method: 0 }], { maxCompressedBytes: 10 }, /compressed.*limit/i],
		["archive expansion", [{ name: "draht-graph/", data: "", method: 0 }, { name: "draht-graph/draht-graph.exe", data: Buffer.alloc(4096), uncompressedSize: 6 }, { name: "draht-graph/README.md", data: "readme" }, { name: "draht-graph/LICENSE", data: "license" }], { maxUncompressedBytes: 1024 }, /expanded|uncompressed|size/i],
	]) {
		test(`${implementation} rejects ZIP ${label} before publication`, async () => {
			const { extractGraphZip } = await import(`../packages/${implementation}/graph-archive.mjs`);
			const root = mkdtempSync(join(tmpdir(), `${implementation}-bad-zip-`));
			const archive = join(root, "graph.zip");
			writeFileSync(archive, makeZip(entries));
			assert.throws(() => extractGraphZip(archive, join(root, "out"), {
				binary: "draht-graph.exe", binaryBytes: 6,
				maxUncompressedBytes: limits.maxUncompressedBytes ?? 1024 * 1024,
				maxCompressedBytes: limits.maxCompressedBytes ?? 1024 * 1024,
			}), pattern);
		});
	}

	test(`${implementation} accepts a manifest bound to the requested release and platform`, async () => {
		const { validateGraphManifest } = await import(`../packages/${implementation}/graph-manifest.mjs`);
		assert.equal(validateGraphManifest(validManifest(), { version: "2026.8.5", tag: "v2026.8.5", platform: "linux-x64", commit: "c".repeat(40) }).archiveBytes, 123);
	});

	for (const [label, mutate] of [
		["name", (m) => { m.name = "other"; }],
		["version", (m) => { m.version = "2026.8.4"; }],
		["tag", (m) => { m.tag = "v2026.8.4"; }],
		["git commit", (m) => { m.gitCommit = "d".repeat(40); }],
		["schema", (m) => { m.schemaVersion = 2; }],
		["platform", (m) => { m.artifacts[0].platform = "darwin-x64"; }],
		["goos", (m) => { m.artifacts[0].goos = "darwin"; }],
		["goarch", (m) => { m.artifacts[0].goarch = "arm64"; }],
		["archive", (m) => { m.artifacts[0].archive = "wrong.tar.gz"; }],
		["binary", (m) => { m.artifacts[0].binary = "wrong"; }],
		["archive hash metadata", (m) => { m.artifacts[0].archiveSha256 = "not-a-hash"; }],
		["binary size metadata", (m) => { m.artifacts[0].binaryBytes = 0; }],
		["archive size limit", (m) => { m.artifacts[0].archiveBytes = 129 * 1024 * 1024; }],
		["binary size limit", (m) => { m.artifacts[0].binaryBytes = 257 * 1024 * 1024; }],
	]) {
		test(`${implementation} rejects manifest ${label} mismatch before download`, async () => {
			const { validateGraphManifest } = await import(`../packages/${implementation}/graph-manifest.mjs`);
			const manifest = validManifest();
			mutate(manifest);
			assert.throws(
				() => validateGraphManifest(manifest, { version: "2026.8.5", tag: "v2026.8.5", platform: "linux-x64", commit: "c".repeat(40) }),
				/invalid graph release manifest/i,
			);
		});
	}

	test(`${implementation} validates genuine attest-build-provenance v2.4.0 gh JSON and checksum bindings`, async () => {
		const { validateGraphAttestation, validateGraphChecksums } = await import(`../packages/${implementation}/graph-manifest.mjs`);
		const manifest = validManifest();
		const entry = manifest.artifacts[0];
		const tag = manifest.tag;
		const workflowRef = `refs/tags/${tag}`;
		const statement = {
			_type: "https://in-toto.io/Statement/v1",
			predicateType: "https://slsa.dev/provenance/v1",
			subject: [{ name: entry.archive, digest: { sha256: entry.archiveSha256 } }],
			predicate: {
				buildDefinition: {
					buildType: "https://actions.github.io/buildtypes/workflow/v1",
					externalParameters: { workflow: { repository: "https://github.com/draht-dev/draht", path: ".github/workflows/build-binaries.yml", ref: workflowRef } },
					resolvedDependencies: [{ uri: `git+https://github.com/draht-dev/draht@${workflowRef}`, digest: { gitCommit: manifest.gitCommit } }],
				},
				runDetails: { builder: { id: `https://github.com/draht-dev/draht/.github/workflows/build-binaries.yml@${workflowRef}` } },
			},
		};
		const ghRecord = (value) => ({ attestation: { bundle: { dsseEnvelope: {
			payloadType: "application/vnd.in-toto+json",
			payload: Buffer.from(JSON.stringify(value)).toString("base64"),
		} } }, verificationResult: { signature: { certificate: { extensions: { sourceRepositoryURI: "https://github.com/draht-dev/draht", sourceRepositoryDigest: manifest.gitCommit, runnerEnvironment: "github-hosted" } } } } });
		const constraints = { archive: entry.archive, digest: entry.archiveSha256, repo: "draht-dev/draht", commit: manifest.gitCommit, tag };
		assert.doesNotThrow(() => validateGraphAttestation(JSON.stringify([ghRecord(statement)]), constraints));
		for (const mutate of [
			(value) => { value._type = "https://in-toto.io/Statement/v0.1"; },
			(value) => { value.predicateType = "https://example.test/provenance"; },
			(value) => { value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/untrusted.yml"; },
		]) {
			const invalid = structuredClone(statement);
			mutate(invalid);
			assert.throws(() => validateGraphAttestation(JSON.stringify([ghRecord(invalid)]), constraints), /structurally bound/i);
		}
		assert.throws(() => validateGraphAttestation(JSON.stringify([{ verificationResult: { statement } }]), constraints), /structurally bound/i);
		assert.doesNotThrow(() => validateGraphChecksums(`${entry.archiveSha256}  ${entry.archive}\n${entry.binarySha256}  linux-x64/${entry.binary}\n`, entry, "linux-x64"));
		assert.throws(() => validateGraphChecksums(`${entry.archiveSha256}  ../${entry.archive}\n${entry.binarySha256}  linux-x64/${entry.binary}\n`, entry, "linux-x64"), /not bound|invalid/i);
	});

	test(`${implementation} performs fresh local graph install and replaces it on update`, () => {
		const home = mkdtempSync(join(tmpdir(), `${implementation}-home-`));
		const sources = mkdtempSync(join(tmpdir(), `${implementation}-sources-`));
		const first = join(sources, "first");
		const second = join(sources, "second");
		writeFileSync(first, "first graph binary");
		writeFileSync(second, "updated graph binary");
		const cli = join(ROOT, "packages", implementation, "cli.mjs");
		const run = (source, version) => spawnSync(process.execPath, [cli, "install-graph-engine", "--from", source, "--graph-engine-version", version], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, USERPROFILE: home },
		});
		const fresh = run(first, "1.0.0");
		assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
		const target = join(home, ".draht", "bin", process.platform === "win32" ? "draht-graph.exe" : "draht-graph");
		assert.equal(readFileSync(target, "utf8"), "first graph binary");
		const updated = run(second, "2.0.0");
		assert.equal(updated.status, 0, updated.stderr || updated.stdout);
		assert.equal(readFileSync(target, "utf8"), "updated graph binary");
		const stamp = JSON.parse(readFileSync(join(home, ".draht", "bin", ".draht-graph.json"), "utf8"));
		assert.equal(stamp.version, "2.0.0");
		assert.equal(stamp.sha256, createHash("sha256").update("updated graph binary").digest("hex"));
	});

	test(`${implementation} repairs a same-version binary whose digest no longer matches its stamp`, () => {
		const home = mkdtempSync(join(tmpdir(), `${implementation}-repair-home-`));
		const fixture = mkdtempSync(join(tmpdir(), `${implementation}-repair-release-`));
		const payloadDir = join(fixture, "payload", "draht-graph");
		mkdirSync(payloadDir, { recursive: true });
		const expected = "#!/bin/sh\nprintf repaired\\n\n";
		const releasedBinary = join(payloadDir, "draht-graph");
		writeFileSync(releasedBinary, expected);
		chmodSync(releasedBinary, 0o755);
		const archive = join(fixture, "draht-graph-linux-x64.tar.gz");
		const tar = spawnSync("tar", ["-czf", archive, "-C", join(fixture, "payload"), "draht-graph"]);
		assert.equal(tar.status, 0, tar.stderr?.toString());
		const archiveBytes = readFileSync(archive);
		const manifest = validManifest("1.2.3");
		Object.assign(manifest.artifacts[0], {
			archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
			archiveBytes: archiveBytes.length,
			binarySha256: createHash("sha256").update(expected).digest("hex"),
			binaryBytes: Buffer.byteLength(expected),
		});
		writeFileSync(join(fixture, "manifest.json"), JSON.stringify(manifest));
		writeFileSync(join(fixture, "SHA256SUMS"), `${manifest.artifacts[0].archiveSha256}  ${manifest.artifacts[0].archive}\n${manifest.artifacts[0].binarySha256}  linux-x64/draht-graph\n`);
		const preload = join(fixture, "mock-fetch.mjs");
		writeFileSync(preload, `
			import { readFileSync, writeFileSync } from "node:fs";
			globalThis.fetch = async (url) => {
				const value = String(url);
				const file = value.endsWith("/manifest.json") ? process.env.DRAHT_TEST_MANIFEST : value.endsWith("/SHA256SUMS") ? process.env.DRAHT_TEST_SUMS : process.env.DRAHT_TEST_ARCHIVE;
				const bytes = readFileSync(file);
				if (process.env.DRAHT_TEST_OVERRUN && file === process.env.DRAHT_TEST_ARCHIVE) {
					let stage = 0;
					return {
						ok: true,
						status: 200,
						statusText: "OK",
						headers: new Headers(),
						body: { getReader: () => ({
							async read() {
								if (stage++ === 0) return { done: false, value: bytes };
								return { done: false, value: Buffer.from("overrun") };
							},
							async cancel() { writeFileSync(process.env.DRAHT_TEST_CANCELLED, "cancelled"); },
						}) },
					};
				}
				return new Response(bytes, { status: 200 });
			};
		`);
		const fakeBin = join(fixture, "bin");
		mkdirSync(fakeBin);
		const ghLog = join(fixture, "gh.log");
		const workflowRef = `refs/tags/${manifest.tag}`;
		const statement = {
			_type: "https://in-toto.io/Statement/v1",
			predicateType: "https://slsa.dev/provenance/v1",
			subject: [{ name: manifest.artifacts[0].archive, digest: { sha256: manifest.artifacts[0].archiveSha256 } }],
			predicate: {
				buildDefinition: {
					buildType: "https://actions.github.io/buildtypes/workflow/v1",
					externalParameters: { workflow: { repository: "https://github.com/draht-dev/draht", path: ".github/workflows/build-binaries.yml", ref: workflowRef } },
					resolvedDependencies: [{ uri: `git+https://github.com/draht-dev/draht@${workflowRef}`, digest: { gitCommit: manifest.gitCommit } }],
				},
				runDetails: { builder: { id: `https://github.com/draht-dev/draht/.github/workflows/build-binaries.yml@${workflowRef}` } },
			},
		};
		const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
		const gh = join(fakeBin, process.platform === "win32" ? "gh.cmd" : "gh");
		writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DRAHT_TEST_GH_LOG"\ncase "$2" in\nrepos/*/git/ref/tags/*) if [ -n "$DRAHT_TEST_LIGHTWEIGHT" ]; then printf '%s\\n' '{"object":{"type":"commit","sha":"${manifest.gitCommit}"}}'; else printf '%s\\n' '{"object":{"type":"tag","sha":"${"d".repeat(40)}"}}'; fi;;\nrepos/*/git/tags/*) printf '%s\\n' '{"object":{"type":"commit","sha":"${manifest.gitCommit}"}}';;\nesac\nif [ "$1" = attestation ]; then printf '%s\\n' '${JSON.stringify([{ attestation: { bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload } } }, verificationResult: { signature: { certificate: { extensions: { sourceRepositoryURI: "https://github.com/draht-dev/draht", sourceRepositoryDigest: manifest.gitCommit, runnerEnvironment: "github-hosted" } } } } }])}'; fi\n`);
		chmodSync(gh, 0o755);
		const binDir = join(home, ".draht", "bin");
		mkdirSync(binDir, { recursive: true });
		const target = join(binDir, "draht-graph");
		const tampered = expected.replace("repaired", "TAMPERED");
		assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(expected));
		writeFileSync(target, tampered);
		chmodSync(target, 0o755);
		writeFileSync(join(binDir, ".draht-graph.json"), JSON.stringify({
			name: "draht-graph",
			version: "1.2.3",
			schemaVersion: 5,
			sha256: createHash("sha256").update(expected).digest("hex"),
			size: Buffer.byteLength(expected),
		}));
		const cli = join(ROOT, "packages", implementation, "cli.mjs");
		const repaired = spawnSync(process.execPath, ["--import", preload, cli, "install-graph-engine", "--graph-engine-version", "1.2.3"], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				DRAHT_TEST_MANIFEST: join(fixture, "manifest.json"),
				DRAHT_TEST_SUMS: join(fixture, "SHA256SUMS"),
				DRAHT_TEST_ARCHIVE: archive,
				DRAHT_TEST_GH_LOG: ghLog,
				PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}`,
			},
		});
		assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
		assert.equal(readFileSync(target, "utf8"), expected);
		assert.match(readFileSync(ghLog, "utf8"), /api .*git\/ref\/tags\/v1\.2\.3/);
		assert.match(readFileSync(ghLog, "utf8"), /attestation verify .*--repo draht-dev\/draht .*--format json/);
		// Repeat through the lightweight-tag shape; both tag kinds must resolve
		// to the exact manifest commit before installation.
		writeFileSync(target, tampered);
		const lightweight = spawnSync(process.execPath, ["--import", preload, cli, "install-graph-engine", "--graph-engine-version", "1.2.3", "--force"], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, USERPROFILE: home, DRAHT_TEST_MANIFEST: join(fixture, "manifest.json"), DRAHT_TEST_SUMS: join(fixture, "SHA256SUMS"), DRAHT_TEST_ARCHIVE: archive, DRAHT_TEST_GH_LOG: ghLog, DRAHT_TEST_LIGHTWEIGHT: "1", PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}` },
		});
		assert.equal(lightweight.status, 0, lightweight.stderr || lightweight.stdout);
		assert.equal(readFileSync(target, "utf8"), expected);

		// A missing Content-Length cannot bypass the exact archive bound. The
		// reader must cancel as soon as the next chunk crosses that bound.
		writeFileSync(target, tampered);
		const cancelled = join(fixture, "cancelled");
		const overrun = spawnSync(process.execPath, ["--import", preload, cli, "install-graph-engine", "--graph-engine-version", "1.2.3", "--force"], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, USERPROFILE: home, DRAHT_TEST_MANIFEST: join(fixture, "manifest.json"), DRAHT_TEST_SUMS: join(fixture, "SHA256SUMS"), DRAHT_TEST_ARCHIVE: archive, DRAHT_TEST_GH_LOG: ghLog, DRAHT_TEST_OVERRUN: "1", DRAHT_TEST_CANCELLED: cancelled, PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}` },
		});
		assert.equal(overrun.status, 0, overrun.stderr || overrun.stdout);
		assert.equal(readFileSync(target, "utf8"), tampered);
		assert.equal(readFileSync(cancelled, "utf8"), "cancelled");
		assert.match(overrun.stdout, /exceeds.*archive.*limit|archive.*exceeds.*limit/i);

		// A tiny gzip may not expand beyond the manifest-bound decompression
		// budget before any archive member is written.
		const expansionDir = join(fixture, "expansion", "draht-graph");
		mkdirSync(expansionDir, { recursive: true });
		writeFileSync(join(expansionDir, "draht-graph"), expected);
		writeFileSync(join(expansionDir, "padding"), Buffer.alloc(3 * 1024 * 1024));
		const expansionArchive = join(fixture, "expansion.tar.gz");
		const expansionTar = spawnSync("tar", ["-czf", expansionArchive, "-C", join(fixture, "expansion"), "draht-graph"]);
		assert.equal(expansionTar.status, 0, expansionTar.stderr?.toString());
		const expansionBytes = readFileSync(expansionArchive);
		manifest.artifacts[0].archiveSha256 = createHash("sha256").update(expansionBytes).digest("hex");
		manifest.artifacts[0].archiveBytes = expansionBytes.length;
		writeFileSync(join(fixture, "manifest.json"), JSON.stringify(manifest));
		writeFileSync(join(fixture, "SHA256SUMS"), `${manifest.artifacts[0].archiveSha256}  ${manifest.artifacts[0].archive}\n${manifest.artifacts[0].binarySha256}  linux-x64/draht-graph\n`);
		const expansionStatement = structuredClone(statement);
		expansionStatement.subject[0].digest.sha256 = manifest.artifacts[0].archiveSha256;
		const expansionPayload = Buffer.from(JSON.stringify(expansionStatement)).toString("base64");
		writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DRAHT_TEST_GH_LOG"\ncase "$2" in\nrepos/*/git/ref/tags/*) printf '%s\\n' '{"object":{"type":"commit","sha":"${manifest.gitCommit}"}}';;\nesac\nif [ "$1" = attestation ]; then printf '%s\\n' '${JSON.stringify([{ attestation: { bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: expansionPayload } } }, verificationResult: { signature: { certificate: { extensions: { sourceRepositoryURI: "https://github.com/draht-dev/draht", sourceRepositoryDigest: manifest.gitCommit, runnerEnvironment: "github-hosted" } } } } }])}'; fi\n`);
		chmodSync(gh, 0o755);
		const expansion = spawnSync(process.execPath, ["--import", preload, cli, "install-graph-engine", "--graph-engine-version", "1.2.3", "--force"], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, USERPROFILE: home, DRAHT_TEST_MANIFEST: join(fixture, "manifest.json"), DRAHT_TEST_SUMS: join(fixture, "SHA256SUMS"), DRAHT_TEST_ARCHIVE: expansionArchive, DRAHT_TEST_GH_LOG: ghLog, PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}` },
		});
		assert.equal(expansion.status, 0, expansion.stderr || expansion.stdout);
		assert.equal(readFileSync(target, "utf8"), tampered);
		assert.match(expansion.stdout, /decompress|expanded/i);
	});
}
