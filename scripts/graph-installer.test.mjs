import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const IMPLEMENTATIONS = ["draht-claude", "draht-codex"];

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

	test(`${implementation} validates real gh verification JSON and checksum bindings`, async () => {
		const { validateGraphAttestation, validateGraphChecksums } = await import(`../packages/${implementation}/graph-manifest.mjs`);
		const manifest = validManifest();
		const entry = manifest.artifacts[0];
		const statement = {
			subject: [{ name: entry.archive, digest: { sha256: entry.archiveSha256 } }],
			predicate: { buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/draht-dev/draht", digest: { gitCommit: manifest.gitCommit } }] } },
		};
		const realGhShape = JSON.stringify([{ attestation: { bundle: { dsseEnvelope: {
			payloadType: "application/vnd.in-toto+json",
			payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
		} } }, verificationResult: { signature: { certificate: { extensions: { sourceRepositoryURI: "https://github.com/draht-dev/draht", sourceRepositoryDigest: manifest.gitCommit, runnerEnvironment: "github-hosted" } } } } }]);
		const constraints = { archive: entry.archive, digest: entry.archiveSha256, repo: "draht-dev/draht", commit: manifest.gitCommit };
		assert.doesNotThrow(() => validateGraphAttestation(realGhShape, constraints));
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
			import { readFileSync } from "node:fs";
			globalThis.fetch = async (url) => {
				const value = String(url);
				const file = value.endsWith("/manifest.json") ? process.env.DRAHT_TEST_MANIFEST : value.endsWith("/SHA256SUMS") ? process.env.DRAHT_TEST_SUMS : process.env.DRAHT_TEST_ARCHIVE;
				return new Response(readFileSync(file), { status: 200 });
			};
		`);
		const fakeBin = join(fixture, "bin");
		mkdirSync(fakeBin);
		const ghLog = join(fixture, "gh.log");
		const statement = { subject: [{ name: manifest.artifacts[0].archive, digest: { sha256: manifest.artifacts[0].archiveSha256 } }], predicate: { buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/draht-dev/draht", digest: { gitCommit: manifest.gitCommit } }] } } };
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
	});
}
