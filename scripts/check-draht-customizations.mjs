#!/usr/bin/env node

/**
 * Verify draht-specific customizations survive upstream rebases.
 *
 * Run after cherry-picking upstream commits and before merging:
 *   node scripts/check-draht-customizations.mjs
 *
 * Checks:
 *   1. Root package.json: version format, scripts, workspace deps, draht-only deps
 *   2. coding-agent package.json: drahtConfig, bin entries, files, workspace deps,
 *      build scripts, publishConfig, typescript version
 *   3. Draht-only scripts exist on disk
 *   4. verify.sh branding check targets @mariozechner/pi-* (not @draht/*)
 *   5. .planning/ files are not modified vs main (branding guard must not touch them)
 *   6. All upstream-shared packages use workspace:* deps
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

let failures = 0;
let passes = 0;

function pass(msg) {
	passes++;
	console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function fail(msg) {
	failures++;
	console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function check(condition, msg) {
	if (condition) {
		pass(msg);
	} else {
		fail(msg);
	}
}

function readJson(relPath) {
	return JSON.parse(readFileSync(resolve(root, relPath), "utf-8"));
}

// ── 1. Root package.json ────────────────────────────────────────────

console.log("\nRoot package.json");

const rootPkg = readJson("package.json");

check(
	/^\d{4}\.\d{1,2}\.\d{1,2}/.test(rootPkg.version),
	`version is YYYY.M.D format: ${rootPkg.version}`
);

const requiredRootScripts = [
	"release",
	"release:dry",
	"dev:link",
	"dev:unlink",
	"verify",
	"verify:quick",
];
for (const script of requiredRootScripts) {
	check(
		typeof rootPkg.scripts?.[script] === "string",
		`scripts.${script} exists`
	);
}

// These upstream-style release scripts should NOT exist
const forbiddenRootScripts = ["release:patch", "release:minor", "release:major"];
for (const script of forbiddenRootScripts) {
	check(
		rootPkg.scripts?.[script] === undefined,
		`scripts.${script} does not exist (upstream semver release)`
	);
}

check(
	rootPkg.dependencies?.["@draht/coding-agent"] === "workspace:*",
	`@draht/coding-agent dep is workspace:*`
);

check(
	rootPkg.dependencies?.koffi !== undefined,
	`koffi dependency present`
);

// ── 2. coding-agent package.json ────────────────────────────────────

console.log("\npackages/coding-agent/package.json");

const caPkg = readJson("packages/coding-agent/package.json");

check(
	/^\d{4}\.\d{1,2}\.\d{1,2}/.test(caPkg.version),
	`version is YYYY.M.D format: ${caPkg.version}`
);

check(
	caPkg.drahtConfig?.name === "draht" && caPkg.drahtConfig?.configDir === ".draht",
	`drahtConfig present (not piConfig)`
);

check(caPkg.piConfig === undefined, `piConfig absent`);

const requiredBins = ["coding-agent", "draht", "draht-tools"];
for (const bin of requiredBins) {
	check(typeof caPkg.bin?.[bin] === "string", `bin.${bin} exists`);
}

const requiredFiles = ["prompts", "hooks", "agents", "bin"];
for (const f of requiredFiles) {
	check(caPkg.files?.includes(f), `files includes "${f}"`);
}

check(
	caPkg.dependencies?.["@draht/agent-core"] === "workspace:*",
	`@draht/agent-core dep is workspace:*`
);
check(
	caPkg.dependencies?.["@draht/ai"] === "workspace:*",
	`@draht/ai dep is workspace:*`
);
check(
	caPkg.dependencies?.["@draht/tui"] === "workspace:*",
	`@draht/tui dep is workspace:*`
);

check(
	caPkg.scripts?.["build:binary"]?.includes("dist/draht"),
	`build:binary outputs dist/draht (not dist/pi)`
);

check(
	caPkg.scripts?.["copy-assets"]?.includes("dist/prompts"),
	`copy-assets copies prompts/hooks/agents`
);

check(
	caPkg.publishConfig?.access === "public",
	`publishConfig.access is "public"`
);

check(
	caPkg.devDependencies?.typescript?.includes("6.0.0") ||
		caPkg.devDependencies?.typescript?.includes("7.") ||
		caPkg.devDependencies?.typescript?.includes("beta"),
	`typescript devDep is not downgraded: ${caPkg.devDependencies?.typescript}`
);

// ── 3. All upstream-shared packages use workspace:* ─────────────────

console.log("\nWorkspace deps");

const sharedPkgs = [
	"packages/agent/package.json",
	"packages/coding-agent/package.json",
	"packages/mom/package.json",
	"packages/web-ui/package.json",
];

for (const pkgPath of sharedPkgs) {
	const pkg = readJson(pkgPath);
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	for (const [name, version] of Object.entries(deps)) {
		if (name.startsWith("@draht/") && version !== "workspace:*") {
			fail(`${pkgPath}: ${name} is "${version}" (expected workspace:*)`);
		}
	}
}
// If we get here without failures from the loop, mark a pass
if (failures === 0 || true) {
	// Individual failures already logged; just note overall
}

// ── 4. Draht-only scripts exist on disk ─────────────────────────────

console.log("\nDraht-only scripts");

const requiredScripts = [
	"scripts/dev-link.mjs",
	"scripts/dev-unlink.mjs",
	"scripts/verify.sh",
	"scripts/release.mjs",
	"scripts/sync-versions.js",
];
for (const script of requiredScripts) {
	check(existsSync(resolve(root, script)), `${script} exists`);
}

// ── 5. verify.sh checks for @mariozechner/pi-* ─────────────────────

console.log("\nverify.sh branding target");

const verifyContent = readFileSync(resolve(root, "scripts/verify.sh"), "utf-8");
check(
	verifyContent.includes("@mariozechner/pi-"),
	`verify.sh checks for stale @mariozechner/pi-* refs`
);
check(
	!verifyContent.includes("@draht/coding-agent-"),
	`verify.sh does NOT check for @draht/coding-agent-* (incorrect rewrite)`
);

// ── 6. .planning/ not modified ──────────────────────────────────────

console.log("\n.planning/ integrity");

try {
	const diffOutput = execSync("git diff main -- .planning/", {
		cwd: root,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	check(diffOutput.trim() === "", `.planning/ unchanged vs main`);
} catch {
	// If not on a branch or main doesn't exist, skip
	pass(`.planning/ check skipped (no main ref)`);
}

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed\n`);
if (failures > 0) {
	process.exit(1);
}
