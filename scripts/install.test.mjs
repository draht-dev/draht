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

function fixture({ unsafe = false, withGh = true } = {}) {
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
		artifacts: [{
			platform: "linux-x64",
			archive: archiveName,
			archiveSha256: sha256(archiveBytes),
			archiveBytes: archiveBytes.length,
			binary: "draht",
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
name="\${url##*/}"
cp "$DRAHT_TEST_RELEASE/$name" "$out"
`, "utf8");
	chmodSync(join(fakeBin, "curl"), 0o755);
	for (const command of ["git", "bun"]) {
		writeFileSync(join(fakeBin, command), "#!/bin/sh\nexit 97\n", "utf8");
		chmodSync(join(fakeBin, command), 0o755);
	}
	if (withGh) {
		writeFileSync(join(fakeBin, "gh"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$DRAHT_TEST_GH_LOG\"\n", "utf8");
		chmodSync(join(fakeBin, "gh"), 0o755);
	}
	return { root, release, fakeBin, home, ghLog: join(root, "gh.log") };
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
		assert.ok(attestations.every((line) => line.includes("attestation verify") && line.includes("--repo draht-dev/draht")));
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
