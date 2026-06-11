#!/usr/bin/env node
/**
 * Release script for draht (date-based versioning: YYYY.M.D[-N])
 *
 * Usage:
 *   node scripts/release.mjs                 # today's date version, auto intraday suffix (-1, -2, ...)
 *   node scripts/release.mjs <YYYY.M.D[-N]>  # explicit version
 *   node scripts/release.mjs <major|minor|patch>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump version via npm run version:xxx or set an explicit version
 * 3. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 4. Commit and tag
 * 5. Publish to npm
 * 6. Add new [Unreleased] section to changelogs
 * 7. Commit
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const VERSION_RE = /^\d+\.\d+\.\d+(-\d+)?$/;

if (RELEASE_TARGET && !BUMP_TYPES.has(RELEASE_TARGET) && !VERSION_RE.test(RELEASE_TARGET)) {
	console.error("Usage: node scripts/release.mjs [major|minor|patch|YYYY.M.D[-N]]");
	console.error("  (no argument = today's date-based version, auto-incrementing intraday suffix)");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

// draht date-based version: YYYY.M.D, with an intraday suffix (-1, -2, ...) when
// today already has a release.
function computeDateVersion() {
	const now = new Date();
	const base = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
	const current = getVersion();
	if (current.split("-")[0] === base) {
		const match = current.match(/-(\d+)$/);
		return `${base}-${match ? Number(match[1]) + 1 : 1}`;
	}
	return base;
}

function compareVersions(a, b) {
	const parse = (v) => {
		const [base, suffix] = v.split("-");
		return { parts: base.split(".").map(Number), suffix: suffix ? Number(suffix) : 0 };
	};
	const pa = parse(a);
	const pb = parse(b);

	for (let i = 0; i < 3; i++) {
		const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return pa.suffix - pb.suffix;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (target && BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
		return getVersion();
	}

	// No target -> today's date-based version; explicit target -> use as given.
	const version = target || computeDateVersion();

	if (compareVersions(version, currentVersion) <= 0) {
		console.error(`Error: version ${version} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}

	console.log(`Setting version (${version})...`);
	run(
		`npm version ${version} -ws --no-git-tag-version && node scripts/sync-versions.js && bun install`,
	);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 3. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 4. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 5. Publish
console.log("Publishing to npm...");
run("npm run publish");
console.log();

// 6. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 7. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 8. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
