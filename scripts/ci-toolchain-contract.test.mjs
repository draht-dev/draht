import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const manifest = JSON.parse(read("package.json"));
const setupAction = read(".github/actions/setup/action.yml");
const binaryRelease = read(".github/workflows/build-binaries.yml");

// The TEST install, not the release one. Release workflows keep
// `--ignore-scripts --linker hoisted` (release-helpers.test.mjs); the shared
// setup action feeds the test jobs, which need trusted lifecycle scripts
// (better-sqlite3's native binding) and per-workspace node_modules/.bin.
const TEST_INSTALL = "bun install --frozen-lockfile";

test("the shared setup action installs and asserts the exact Bun pinned by the manifest", () => {
	assert.match(manifest.packageManager, /^bun@\d+\.\d+\.\d+$/);
	assert.match(manifest.drahtReleaseBunRevision, /^\d+\.\d+\.\d+\+[0-9a-f]+$/);
	assert.match(setupAction, /require\('\.\/package\.json'\)\.packageManager/);
	assert.match(setupAction, /require\('\.\/package\.json'\)\.drahtReleaseBunRevision/);
	assert.match(setupAction, /uses: oven-sh\/setup-bun@[0-9a-f]{40}\b/);
	assert.match(setupAction, /bun-version: \$\{\{ steps\.bun-pin\.outputs\.version \}\}/);
	assert.match(setupAction, /bun --revision/);
	assert.match(setupAction, /test "\$\{ACTUAL_BUN_REVISION\}" = "\$\{EXPECTED_BUN_REVISION\}"/);
	assert.doesNotMatch(setupAction, /bun-version: latest/);
	assert.doesNotMatch(setupAction, /bun-version-file/);
});

test("the shared setup action does not install Bun under the npm global prefix", () => {
	// The npm global prefix sits in the runner's /opt toolcache, which is
	// group- or world-writable; the gateway refuses to exec a runtime there
	// ("writable by others: /opt"). setup-bun installs into ~/.bun/bin.
	assert.doesNotMatch(setupAction, /npm install --global "?bun@/);
});

test("the shared setup action uses a frozen install that keeps lifecycle scripts and the default layout", () => {
	const installLines = setupAction.split("\n").filter((line) => /^\s*run: bun install\b/.test(line));
	assert.deepEqual(
		installLines.map((line) => line.trim()),
		[`run: ${TEST_INSTALL}`],
	);
});

test("binary release pins the same manifest Bun version and revision, not a different one", () => {
	const packageManagerVersion = manifest.packageManager.replace(/^bun@/, "");
	assert.match(binaryRelease, new RegExp(`BUN_PACKAGE_VERSION: ${packageManagerVersion.replaceAll(".", "\\.")}`));
	assert.match(
		binaryRelease,
		new RegExp(`BUN_REVISION: ${manifest.drahtReleaseBunRevision.replaceAll(".", "\\.").replaceAll("+", "\\+")}`),
	);
	assert.doesNotMatch(binaryRelease, /bun-version: latest/);
});

test("release workflows install the pinned Bun with setup-bun, never under the npm global prefix", () => {
	for (const name of ["scheduled-release", "promote-daily-release", "build-binaries"]) {
		const workflow = read(`.github/workflows/${name}.yml`);
		assert.doesNotMatch(workflow, /npm install --global "?bun@/, `${name}.yml installs Bun under /opt`);
		assert.match(workflow, /uses: oven-sh\/setup-bun@[0-9a-f]{40}\b/, `${name}.yml must use a pinned setup-bun`);
		assert.match(workflow, /bun-version: \$\{\{ env\.BUN_PACKAGE_VERSION \}\}/, `${name}.yml must install the pinned version`);
		assert.match(workflow, /test "\$\(bun --revision\)" = "\$\{BUN_REVISION\}"/, `${name}.yml must verify the revision`);
	}
});

test("release workflows give git a committer identity before they commit", () => {
	for (const name of ["scheduled-release", "promote-daily-release"]) {
		const workflow = read(`.github/workflows/${name}.yml`);
		assert.match(workflow, /git config user\.name "draht-release\[bot\]"/, `${name}.yml must set user.name`);
		assert.match(workflow, /git config user\.email "release@draht\.dev"/, `${name}.yml must set user.email`);
	}
});

test("publishing workflow steps hand bun publish its token through NPM_CONFIG_TOKEN", () => {
	for (const name of ["scheduled-release", "promote-daily-release"]) {
		const workflow = read(`.github/workflows/${name}.yml`);
		assert.match(workflow, /NPM_CONFIG_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/, `${name}.yml must set NPM_CONFIG_TOKEN`);
	}
	const scheduled = read(".github/workflows/scheduled-release.yml");
	assert.match(scheduled, /resume_publish:/);
	assert.match(scheduled, /run: npm run release -- --resume-publish/);
});

test("binary archives ship executable Git safety and completion-check runtimes", { skip: process.platform === "win32", timeout: 30_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "draht-binary-archive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (path, content, mode = 0o644) => {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, { mode });
	};
	const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
	const packageRoot = "packages/coding-agent";
	write("package.json", JSON.stringify({ version: "1.0.0", drahtReleaseBunRevision: manifest.drahtReleaseBunRevision }));
	write("scripts/build-binaries.sh", read("scripts/build-binaries.sh"));
	write("scripts/build-runtime-manifest.mjs", read("scripts/build-runtime-manifest.mjs"));
	write("fixture-bin/bun", `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--revision") {
 console.log(${JSON.stringify(manifest.drahtReleaseBunRevision)});
} else if (args[0] === "install" && args.includes("--frozen-lockfile")) {
} else if (args.length === 2 && args[0] === "run" && args[1] === "build") {
} else if (args[0] === "build" && args.includes("--compile") && args.indexOf("--outfile") === args.length - 2) {
 fs.writeFileSync(args.at(-1), "fixture binary");
} else {
 throw new Error("Unexpected fixture Bun invocation: " + JSON.stringify(args));
}
`, 0o755);
	write("fixture-bin/git", `#!/usr/bin/env node
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["rev-parse", "HEAD"]);
console.log("1".repeat(40));
`, 0o755);
	for (const file of ["package.json", "README.md", "CHANGELOG.md", "dist/modes/interactive/theme/default.json", "dist/modes/interactive/assets/logo.png", "dist/core/export-html/template.html", "docs/providers.md", "examples/example.js"]) {
		write(`${packageRoot}/${file}`, file.endsWith(".json") ? "{}" : "fixture asset");
	}
	write("node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "fixture wasm");
	cpSync(join(ROOT, packageRoot, "hooks"), join(root, packageRoot, "hooks"), { recursive: true });
	for (const platform of platforms) {
		const native = platform.replace("windows-", "win32-");
		write(`packages/tui/native/${native.split("-")[0]}/prebuilds/${native}/binding.node`, "fixture native asset");
	}
	execFileSync("bash", [join(root, "scripts/build-binaries.sh")], {
		cwd: root,
		env: { ...process.env, PATH: `${join(root, "fixture-bin")}${delimiter}${process.env.PATH ?? ""}` },
		encoding: "utf8",
		timeout: 20_000,
	});
	const binaries = join(root, packageRoot, "binaries");
	const runtimeManifest = JSON.parse(readFileSync(join(binaries, "runtime-manifest.json"), "utf8"));
	const require = createRequire(import.meta.url);
	for (const platform of platforms) {
		await t.test(platform, () => {
			const windows = platform === "windows-x64";
			const unpacked = join(root, "extracted", platform);
			mkdirSync(unpacked, { recursive: true });
			if (windows) execFileSync("unzip", ["-q", join(binaries, `draht-${platform}.zip`), "-d", unpacked]);
			else execFileSync("tar", ["-xzf", join(binaries, `draht-${platform}.tar.gz`), "-C", unpacked]);
			const payload = windows ? unpacked : join(unpacked, "draht");
			const policy = require(join(payload, "hooks/checks/git-safety.cjs"));
			assert.equal(policy.findGitSafetyViolation("git status"), undefined);
			assert.match(policy.findGitSafetyViolation("git commit --no-verify"), /hook bypass/i);
			const artifact = runtimeManifest.artifacts.find((entry) => entry.platform === platform);
			assert.ok(artifact, `${platform} must appear in the runtime manifest`);
			for (const file of ["git-safety.cjs", "checks-runtime.cjs"]) {
				const member = `hooks/checks/${file}`;
				assert.deepEqual(readFileSync(join(payload, member)), readFileSync(join(ROOT, packageRoot, member)));
				assert.ok(artifact.files.includes(windows ? member : `draht/${member}`), `${platform} manifest omits ${member}`);
			}
			const project = join(root, "projects", platform);
			write(`projects/${platform}/.draht/checks.json`, JSON.stringify({
				checks: [{ name: "archive-check", cache: false, command: [process.execPath, "-e", "require('node:fs').writeFileSync('checked.txt', 'verified')"] }],
			}));
			const output = execFileSync(process.execPath, [join(payload, "hooks/checks/checks-runtime.cjs"), "--cwd", project, "--json"], {
				cwd: project,
				encoding: "utf8",
				timeout: 10_000,
			});
			const result = JSON.parse(output);
			assert.equal(result.status, "passed");
			assert.equal(result.configured, true);
			assert.equal(result.checks[0].status, "passed");
			assert.equal(readFileSync(join(project, "checked.txt"), "utf8"), "verified");
		});
	}
});
