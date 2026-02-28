#!/usr/bin/env node
/**
 * Release script for draht
 *
 * Usage: node scripts/release.mjs [--dry-run]
 *
 * Version format: YYYY.M.D (e.g. 2026.2.28)
 * Multiple releases per day: 2026.2.28-1, 2026.2.28-2, etc.
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Compute daily version (check existing tags for suffix)
 * 3. Set version across all packages
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 5. Commit and tag
 * 6. Publish to npm
 * 7. Add new [Unreleased] section to changelogs
 * 8. Commit and push
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	if (DRY_RUN && !options.allowInDryRun) {
		console.log("  (dry-run: skipped)");
		return "";
	}
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

function computeVersion() {
	const now = new Date();
	const base = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;

	// Check existing tags for today
	const tags = execSync("git tag -l", { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
	const todayTags = tags.filter((t) => t === `v${base}` || t.startsWith(`v${base}-`));

	if (todayTags.length === 0) {
		return base;
	}

	// Find highest suffix
	let maxSuffix = 0;
	for (const tag of todayTags) {
		if (tag === `v${base}`) {
			maxSuffix = Math.max(maxSuffix, 0);
		} else {
			const match = tag.match(new RegExp(`^v${base.replace(/\./g, "\\.")}-(\\d+)$`));
			if (match) {
				maxSuffix = Math.max(maxSuffix, Number.parseInt(match[1], 10));
			}
		}
	}

	return `${base}-${maxSuffix + 1}`;
}

function setVersion(version) {
	const packagesDir = "packages";
	const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	const versionMap = {};

	// First pass: update all package versions and build name map
	for (const dir of packageDirs) {
		const pkgPath = join(packagesDir, dir, "package.json");
		if (!existsSync(pkgPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		pkg.version = version;
		versionMap[pkg.name] = version;
		writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
	}

	// Second pass: update inter-package dependency versions
	for (const dir of packageDirs) {
		const pkgPath = join(packagesDir, dir, "package.json");
		if (!existsSync(pkgPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		let updated = false;

		for (const depType of ["dependencies", "devDependencies"]) {
			if (!pkg[depType]) continue;
			for (const [depName, currentVersion] of Object.entries(pkg[depType])) {
				if (versionMap[depName] && !currentVersion.startsWith("workspace:")) {
					const newVersion = `^${version}`;
					if (currentVersion !== newVersion) {
						pkg[depType][depName] = newVersion;
						updated = true;
					}
				}
			}
		}

		if (updated) {
			writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
		}
	}

	// Update root package.json
	const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
	rootPkg.version = version;
	writeFileSync("package.json", JSON.stringify(rootPkg, null, "  ") + "\n");
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
			`## [${version}] - ${date}`,
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

		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`,
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log(`\n=== Draht Release${DRY_RUN ? " (dry-run)" : ""} ===\n`);

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true, allowInDryRun: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Compute version
const version = computeVersion();
console.log(`Version: ${version}\n`);

// 3. Set version across all packages
console.log("Setting version across packages...");
if (!DRY_RUN) {
	setVersion(version);
}
console.log(`  Set all packages to ${version}\n`);

// 4. Update changelogs
console.log("Updating CHANGELOG.md files...");
if (!DRY_RUN) {
	updateChangelogsForRelease(version);
}
console.log();

// 5. Commit and tag
console.log("Committing and tagging...");
run("git add .");
run(`git commit -m "release: v${version}"`);
run(`git tag v${version}`);
console.log();

// 6. Build and publish
console.log("Building and publishing...");
run("bun run prepublishOnly");
run("npm publish -ws --access public");
console.log();

// 7. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
if (!DRY_RUN) {
	addUnreleasedSection();
}
console.log();

// 8. Commit and push
console.log("Committing changelog updates...");
run("git add .");
run('git commit -m "chore: add [Unreleased] section for next cycle"');
console.log();

console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
