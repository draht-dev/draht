import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLERS = [join(ROOT, "install.sh"), join(ROOT, "packages", "landing", "public", "install.sh")];

// The gh-absent scenarios (DRAHT_ALLOW_UNVERIFIED opt-out, fails-closed-without-gh)
// require that no real gh is reachable through the system portion of the pinned
// PATH — the installers refuse to let the opt-out mask a present gh, so a host
// gh (e.g. /usr/bin/gh on GitHub Actions runners, which refuses without
// GH_TOKEN) turns every opt-out install into a provenance failure. Symlink the
// system tools into one dir, minus gh, so absence is guaranteed on every host.
const SYSTEM_BIN = (() => {
	const dir = mkdtempSync(join(tmpdir(), "draht-install-system-bin-"));
	for (const sys of ["/run/current-system/sw/bin", "/usr/bin", "/bin"]) {
		if (!existsSync(sys)) continue;
		for (const entry of readdirSync(sys)) {
			if (entry === "gh") continue;
			try {
				symlinkSync(join(sys, entry), join(dir, entry));
			} catch {}
		}
	}
	return dir;
})();

// The release payload is built for linux-x64 and the traversal fixture rewrites
// member names on the way in; GNU tar and bsdtar spell that differently.
const GNU_TAR = /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function fixture({ archiveMode = "valid", withGh = true, manifestCommit = "2".repeat(40), ghMode = "valid", curlMode = "valid" } = {}) {
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
	writeFileSync(join(payload, "README.md"), "fixture readme\n");
	if (archiveMode === "expansion") writeFileSync(join(payload, "padding"), Buffer.alloc(3 * 1024 * 1024));
	if (archiveMode === "symlink") symlinkSync("draht", join(payload, "link"));
	if (archiveMode === "special") {
		const fifo = spawnSync("mkfifo", [join(payload, "fifo")]);
		assert.equal(fifo.status, 0, fifo.stderr?.toString());
	}
	const binaryBytes = readFileSync(join(payload, "draht"));
	const archiveName = "draht-linux-x64.tar.gz";
	const archive = join(release, archiveName);
	const tarArgs = archiveMode === "traversal"
		? ["-czf", archive, GNU_TAR ? "--transform=s|^|../|" : "-s|^|../|", "-C", join(root, "payload"), "draht"]
		: archiveMode === "missing"
			? ["-czf", archive, "-C", join(root, "payload"), "draht/README.md"]
			: archiveMode === "duplicate"
				? ["-czf", archive, "-C", join(root, "payload"), "draht/draht", "draht/draht", "draht/README.md"]
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
			files: ["draht/draht", "draht/README.md"],
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
src="$DRAHT_TEST_RELEASE/$name"
case "$DRAHT_TEST_CURL_MODE:$name" in
  missing-length-overrun:runtime-manifest.json|lying-length-overrun:runtime-manifest.json|aggregate-overrun:DRAHT-SHA256SUMS)
    dd if=/dev/zero bs=1048576 count=3 2>/dev/null
    ;;
  *) cat "$src" ;;
esac > "$out"
`, "utf8");
	chmodSync(join(fakeBin, "curl"), 0o755);
	for (const command of ["git", "bun"]) {
		writeFileSync(join(fakeBin, command), "#!/bin/sh\nexit 97\n", "utf8");
		chmodSync(join(fakeBin, command), 0o755);
	}
	// The payload above is a linux-x64 release; pin the platform the installer
	// sees to match it so the suite runs on any host, not only Linux runners.
	writeFileSync(join(fakeBin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux;; -m) echo x86_64;; esac\n", "utf8");
	chmodSync(join(fakeBin, "uname"), 0o755);
	if (withGh) {
		writeFileSync(join(fakeBin, "gh"), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DRAHT_TEST_GH_LOG"
[ "$DRAHT_TEST_GH_MODE" != fail ] || exit 1
asset="$3"
if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$asset" | cut -d' ' -f1)"
else digest="$(shasum -a 256 "$asset" | cut -d' ' -f1)"; fi
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
	return { root, release, fakeBin, home, ghLog: join(root, "gh.log"), commit: "2".repeat(40), ghMode, curlMode };
}

function runInstaller(installer, f, extraEnv = {}) {
	return spawnSync("bash", [installer], {
		timeout: 10_000,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: f.home,
			SHELL: "/bin/false",
			PATH: `${f.fakeBin}:${SYSTEM_BIN}`,
			DRAHT_VERSION: "1.2.3",
			DRAHT_BIN: join(f.home, "bin"),
			DRAHT_DIR: join(f.home, ".draht-runtime"),
			DRAHT_TEST_RELEASE: f.release,
			DRAHT_TEST_GH_LOG: f.ghLog,
			DRAHT_TEST_COMMIT: f.commit,
			DRAHT_TEST_GH_MODE: f.ghMode,
			DRAHT_TEST_CURL_MODE: f.curlMode,
			...extraEnv,
		},
	});
}

function windowsZipFixture({ symlink = false } = {}) {
	const f = fixture({ withGh: false });
	const payload = join(f.root, "windows-payload");
	mkdirSync(payload);
	writeFileSync(join(payload, "draht.exe"), "windows binary");
	if (symlink) symlinkSync("draht.exe", join(payload, "link"));
	const archiveName = "draht-windows-x64.zip";
	const archive = join(f.release, archiveName);
	const zip = spawnSync("zip", ["-q", "-y", archive, "draht.exe", ...(symlink ? ["link"] : [])], { cwd: payload, encoding: "utf8" });
	assert.equal(zip.status, 0, zip.stderr);
	const binary = readFileSync(join(payload, "draht.exe"));
	const archiveBytes = readFileSync(archive);
	writeFileSync(join(f.release, "runtime-manifest.json"), JSON.stringify({ schemaVersion: 1, name: "draht", version: "1.2.3", tag: "v1.2.3", gitCommit: f.commit, artifacts: [{
		platform: "windows-x64", archive: archiveName, archiveSha256: sha256(archiveBytes), archiveBytes: archiveBytes.length,
		binary: "draht.exe", binarySha256: sha256(binary), binaryBytes: binary.length, files: ["draht.exe", ...(symlink ? ["link"] : [])],
	}] }));
	writeFileSync(join(f.release, "DRAHT-SHA256SUMS"), `${sha256(archiveBytes)}  ${archiveName}\n`);
	writeFileSync(join(f.fakeBin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo MINGW64_NT;; -m) echo x86_64;; esac\n");
	chmodSync(join(f.fakeBin, "uname"), 0o755);
	return f;
}

/**
 * The standard fixture, with `uname` pinned to the linux-x64 platform its
 * release payload is actually built for, so the `~/.draht` ownership guard
 * can be driven through a complete install on any host.
 */
function drahtHomeFixture() {
	const f = fixture({ withGh: false });
	writeFileSync(join(f.fakeBin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo Linux;; -m) echo x86_64;; esac\n", "utf8");
	chmodSync(join(f.fakeBin, "uname"), 0o755);
	return f;
}

/**
 * Runs the installer with DRAHT_DIR unset, so INSTALL_DIR falls back to
 * `$HOME/.draht/runtime` and the guard on `~/.draht` itself is in play.
 * (The rest of the suite pins DRAHT_DIR outside `~/.draht`, where the guard
 * deliberately does not apply.)
 */
function runInDrahtHome(installer, f, extraEnv = {}) {
	return runInstaller(installer, f, { DRAHT_DIR: undefined, DRAHT_ALLOW_UNVERIFIED: "1", ...extraEnv });
}

for (const installer of INSTALLERS) {
	const label = installer === INSTALLERS[0] ? "root installer" : "landing installer mirror";

	test(`${label} claims an absent ~/.draht and re-installs into the directory it owns`, () => {
		const f = drahtHomeFixture();
		const drahtHome = join(f.home, ".draht");
		assert.equal(existsSync(drahtHome), false);
		const result = runInDrahtHome(installer, f);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(existsSync(join(drahtHome, ".draht-home")), true);
		assert.equal(existsSync(join(drahtHome, "runtime", "current", "draht")), true);
		assert.equal(existsSync(join(f.home, "bin", "draht")), true);
		// Second run: ~/.draht is now non-empty and non-git, and must still be
		// accepted because the marker proves Draht owns it.
		const again = runInDrahtHome(installer, f);
		assert.equal(again.status, 0, again.stderr || again.stdout);
	});

	test(`${label} adopts an empty ~/.draht`, () => {
		const f = drahtHomeFixture();
		const drahtHome = join(f.home, ".draht");
		mkdirSync(drahtHome);
		const result = runInDrahtHome(installer, f);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(existsSync(join(drahtHome, ".draht-home")), true);
		assert.equal(existsSync(join(drahtHome, "runtime", "current", "draht")), true);
	});

	test(`${label} refuses a non-empty non-git ~/.draht and leaves it untouched`, () => {
		const f = drahtHomeFixture();
		const drahtHome = join(f.home, ".draht");
		mkdirSync(join(drahtHome, "someone-elses-data"), { recursive: true });
		writeFileSync(join(drahtHome, "notes.txt"), "not draht's\n", "utf8");
		const result = runInDrahtHome(installer, f);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /is not empty, and was not created by Draht/);
		assert.match(result.stderr, /DRAHT_DIR/);
		assert.equal(readFileSync(join(drahtHome, "notes.txt"), "utf8"), "not draht's\n");
		assert.equal(existsSync(join(drahtHome, ".draht-home")), false);
		assert.equal(existsSync(join(drahtHome, "runtime")), false);
		assert.equal(existsSync(join(f.home, "bin", "draht")), false);
	});

	test(`${label} accepts a git-checkout ~/.draht from the legacy bootstrap`, () => {
		const f = drahtHomeFixture();
		const drahtHome = join(f.home, ".draht");
		mkdirSync(join(drahtHome, ".git"), { recursive: true });
		writeFileSync(join(drahtHome, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		writeFileSync(join(drahtHome, "package.json"), "{}\n", "utf8");
		const result = runInDrahtHome(installer, f);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(existsSync(join(drahtHome, ".git", "HEAD")), true);
		assert.equal(existsSync(join(drahtHome, "runtime", "current", "draht")), true);
	});

	test(`${label} leaves a foreign ~/.draht alone when DRAHT_DIR points elsewhere`, () => {
		const f = drahtHomeFixture();
		const drahtHome = join(f.home, ".draht");
		mkdirSync(drahtHome);
		writeFileSync(join(drahtHome, "notes.txt"), "not draht's\n", "utf8");
		const elsewhere = join(f.home, "opt", "draht");
		const result = runInDrahtHome(installer, f, { DRAHT_DIR: elsewhere });
		assert.equal(result.status, 0, result.stderr || result.stdout);
		assert.equal(existsSync(join(elsewhere, "current", "draht")), true);
		assert.deepEqual(readdirSync(drahtHome), ["notes.txt"]);
	});

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
		const f = fixture({ archiveMode: "traversal", withGh: false });
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

	for (const mode of ["missing-length-overrun", "lying-length-overrun", "aggregate-overrun"]) {
		test(`${label} bounds ${mode.replaceAll("-", " ")} while streaming downloads`, () => {
			const f = fixture({ withGh: false, curlMode: mode });
			const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /byte|size|download|limit/i);
			assert.equal(existsSync(join(f.home, "bin", "draht")), false);
		});
	}

	for (const [mode, message] of [
		["expansion", /expanded|decompress|uncompressed|limit/i],
		["duplicate", /duplicate/i],
		["symlink", /type|link/i],
		["special", /type|special/i],
		["valid", /unexpected|manifest|member/i],
		["missing", /missing|manifest|member/i],
	]) {
		test(`${label} rejects ${mode === "valid" ? "an unexpected archive member" : `${mode} archive members`}`, () => {
			const f = fixture({ archiveMode: mode, withGh: false });
			if (mode === "valid") {
				const manifestPath = join(f.release, "runtime-manifest.json");
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				manifest.artifacts[0].files = ["draht/draht"];
				writeFileSync(manifestPath, JSON.stringify(manifest));
			}
			const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, message);
			assert.equal(existsSync(join(f.home, "bin", "draht")), false);
		});
	}

	test(`${label} rejects a ZIP symlink even when the manifest names it`, () => {
		const f = windowsZipFixture({ symlink: true });
		const result = runInstaller(installer, f, { DRAHT_ALLOW_UNVERIFIED: "1" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /type|link|special/i);
		assert.equal(existsSync(join(f.home, "bin", "draht.exe")), false);
	});
}
