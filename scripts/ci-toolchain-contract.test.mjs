import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
