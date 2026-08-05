import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLERS = [join(ROOT, "install.sh"), join(ROOT, "packages", "landing", "public", "install.sh")];

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function fixture({ unsafe = false, withGh = true, manifestCommit = "2".repeat(40), ghMode = "valid" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "draht-install-test-"));
	const release = join(root, "release");
	const fakeBin = join(root, "fake-bin");
	const home = join(root, "home");
	mkdirSync(release, { recursive: true });
	mkdirSync(fakeBin, { recursive: true });
	mkdirSync(home, { recursive: true });
	const payload = join(root, "payload", "draht");
	mkdirSync(payload, { recursive: true });
	writeFileSync(join(payload, "draht"), "#!/bin/sh\nprintf 'draht fixture\\n'\n");
	chmodSync(join(payload, "draht"), 0o755);
	const binaryBytes = readFileSync(join(payload, "draht"));
	const archiveName = "draht-linux-x64.tar.gz";
	const archive = join(release, archiveName);
	const tarArgs = unsafe
		? ["-czf", archive, "--transform=s|^|../|", "-C", join(root, "payload"), "draht"]
		: ["-czf", archive, "-C", join(root, "payload"), "draht"];
	const tar = spawnSync("tar", tarArgs, { encoding: "utf8" });
	assert.equal(tar.status, 0, tar.stderr);
	const archiveBytes = readFileSync(archive);
	writeFileSync(join(release, "runtime-manifest.json"), JSON.stringify({
		schemaVersion: 1,
		name: "draht",
		version: "1.2.3",
		tag: "v1.2.3",
		gitCommit: manifestCommit,
		artifacts: [{
			platform: "linux-x64",
			archive: archiveName,
			archiveSha256: sha256(archiveBytes),
			archiveBytes: archiveBytes.length,
			binary: "draht",
			binarySha256: sha256(binaryBytes),
			binaryBytes: binaryBytes.length,
		}],
	}));
	writeFileSync(join(release, "DRAHT-SHA256SUMS"), `${sha256(archiveBytes)}  ${archiveName}\n`);
	writeFileSync(join(fakeBin, "curl"), `#!/bin/sh
set -eu
out=""
write_url=false
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write_url=true; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if $write_url; then printf '%s' "https://github.com/draht-dev/draht/releases/tag/v1.2.3"; exit 0; fi
case "$url" in
  https://api.github.com/repos/draht-dev/draht/git/ref/tags/v1.2.3)
    printf '%s\\n' '{"object":{"type":"tag","sha":"4444444444444444444444444444444444444444"}}'
    exit 0
    ;;
  https://api.github.com/repos/draht-dev/draht/git/tags/4444444444444444444444444444444444444444)
    printf '%s\\n' '{"object":{"type":"commit","sha":"2222222222222222222222222222222222222222"}}'
    exit 0
    ;;
esac
name="\${url##*/}"
cp "$DRAHT_TEST_RELEASE/$name" "$out"
`, "utf8");
	chmodSync(join(fakeBin, "curl"), 0o755);
	for (const command of ["git", "bun"]) {
		writeFileSync(join(fakeBin, command), "#!/bin/sh\nexit 97\n", "utf8");
		chmodSync(join(fakeBin, command), 0o755);
	}
	if (withGh) {
		writeFileSync(join(fakeBin, "gh"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DRAHT_TEST_GH_LOG"
[ "$DRAHT_TEST_GH_MODE" != fail ] || exit 1
asset="$3"
digest="$(sha256sum "$asset" | cut -d' ' -f1)"
commit="$DRAHT_TEST_COMMIT"
repository="https://github.com/draht-dev/draht"
source_uri="git+https://github.com/draht-dev/draht@refs/tags/v1.2.3"
builder="https://github.com/draht-dev/draht/.github/workflows/build-binaries.yml@refs/tags/v1.2.3"
if [ "$DRAHT_TEST_GH_MODE" = spoof ]; then
  commit="3333333333333333333333333333333333333333"
  repository="https://github.com/attacker/repo"
  source_uri="git+https://github.com/attacker/repo"
  builder="https://github.com/attacker/repo/.github/workflows/evil.yml@refs/tags/v1.2.3"
fi
jq -n --arg digest "$digest" --arg commit "$commit" --arg repository "$repository" --arg source_uri "$source_uri" --arg builder "$builder" --arg note "draht-dev/draht $DRAHT_TEST_COMMIT .github/workflows/build-binaries.yml" '[{verificationResult:{statement:{_type:"https://in-toto.io/Statement/v1",predicateType:"https://slsa.dev/provenance/v1",subject:[{digest:{sha256:$digest}}],predicate:{buildDefinition:{buildType:"https://actions.github.io/buildtypes/workflow/v1",externalParameters:{workflow:{repository:$repository,ref:"refs/tags/v1.2.3",path:".github/workflows/build-binaries.yml"}},resolvedDependencies:[{uri:$source_uri,digest:{gitCommit:$commit}}]},runDetails:{builder:{id:$builder}}},note:$note}}}]'
`, "utf8");
		chmodSync(join(fakeBin, "gh"), 0o755);
	}
	return { root, release, fakeBin, home, ghLog: join(root, "gh.log"), commit: "2".repeat(40), ghMode };
}

function runInstaller(installer, f, extraEnv = {}) {
	return spawnSync("bash", [installer], {
		timeout: 10_000,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: f.home,
			SHELL: "/bin/false",
			PATH: `${f.fakeBin}:/run/current-system/sw/bin:/usr/bin:/bin`,
			DRAHT_VERSION: "1.2.3",
			DRAHT_BIN: join(f.home, "bin"),
			DRAHT_DIR: join(f.home, ".draht-runtime"),
			DRAHT_TEST_RELEASE: f.release,
			DRAHT_TEST_GH_LOG: f.ghLog,
			DRAHT_TEST_COMMIT: f.commit,
			DRAHT_TEST_GH_MODE: f.ghMode,
			...extraEnv,
		},
	});
}

for (const installer of INSTALLERS) {
	const label = installer === INSTALLERS[0] ? "root installer" : "landing installer mirror";

	test(`${label} installs an immutable checked and attested platform binary`, () => {
		const f = fixture();
		// Empty DRAHT_VERSION exercises one-time latest-tag resolution; the fake
		// curl returns an immutable /releases/tag/v1.2.3 effective URL.
		const result = runInstaller(installer, f, { DRAHT_VERSION: "" });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const target = join(f.home, "bin", "draht");
		assert.equal(existsSync(target), true);
		assert.match(readFileSync(target, "utf8"), /draht fixture/);
		const update = runInstaller(installer, f);
		assert.equal(update.status, 0, update.stderr || update.stdout);
		assert.match(readFileSync(target, "utf8"), /draht fixture/);
		const attestations = readFileSync(f.ghLog, "utf8").trim().split("\n");
		assert.equal(attestations.length, 6);
		assert.ok(attestations.every((line) => line.includes("attestation verify")
			&& line.includes("--repo draht-dev/draht")
			&& line.includes(`--source-digest ${f.commit}`)
			&& line.includes("--source-ref refs/tags/v1.2.3")
			&& line.includes("--signer-workflow draht-dev/draht/.github/workflows/build-binaries.yml")
			&& line.includes("--format json")));
	});

	test(`${label} rejects a runtime manifest from a commit other than the resolved tag`, () => {
		const f = fixture({ manifestCommit: "3".repeat(40) });
		const result = runInstaller(installer, f);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /gitCommit|release commit/i);
		assert.equal(existsSync(join(f.home, "bin", "draht")), false);
	});

	test(`${label} rejects spoofed gh JSON even when expected values appear in a note`, () => {
		const f = fixture({ ghMode: "spoof" });
		const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /provenance/i);
		assert.equal(existsSync(join(f.home, "bin", "draht")), false);
	});

	test(`${label} never allows the opt-out to mask an installed gh verification failure`, () => {
		const f = fixture({ ghMode: "fail" });
		const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /provenance/i);
		assert.equal(existsSync(join(f.home, "bin", "draht")), false);
	});

	test(`${label} fails closed without gh unless the documented opt-out is explicit`, () => {
		const f = fixture({ withGh: false });
		const denied = runInstaller(installer, f);
		assert.notEqual(denied.status, 0);
		assert.match(denied.stderr, /DRAHT_ALLOW_UNVERIFIED=1/);
		const allowed = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
		assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
	});

	test(`${label} rejects unsafe archive paths before extraction`, () => {
		const f = fixture({ unsafe: true, withGh: false });
		const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /unsafe archive path/i);
		assert.equal(existsSync(join(f.home, "bin", "draht")), false);
	});

	test(`${label} rejects an archive that does not match the release checksum list`, () => {
		const f = fixture({ withGh: false });
		writeFileSync(join(f.release, "DRAHT-SHA256SUMS"), `${"0".repeat(64)}  draht-linux-x64.tar.gz\n`);
		const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /DRAHT-SHA256SUMS/);
		assert.equal(existsSync(join(f.home, "bin", "draht")), false);
	});
}
