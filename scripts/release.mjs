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
 * 1. Fetch tags from pull remote (for changelog scoping)
 * 2. Check for uncommitted changes
 * 3. Compute daily version (check existing tags for suffix)
 * 4. Set version across all packages
 * 5. Update CHANGELOG.md files: [Unreleased] -> [version] - date (auto-populated from commits)
 * 6. Commit and tag
 * 7. Publish to npm
 * 8. Add new [Unreleased] section to changelogs
 * 9. Commit and push
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

function getCommitsSinceLastTag() {
	// Find the last release tag
	let lastTag = null;
	try {
		lastTag = execSync("git describe --tags --abbrev=0 2>/dev/null", { encoding: "utf-8" }).trim();
	} catch { /* no tags yet */ }

	// Get commits since last tag (or all commits if no tag)
	const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
	let log = "";
	try {
		log = execSync(`git log ${range} --format="%s" 2>/dev/null`, { encoding: "utf-8" }).trim();
	} catch { /* ignore */ }

	if (!log) return null;

	const typeLabels = {
		feat: "### Features",
		fix: "### Bug Fixes",
		perf: "### Performance",
		refactor: "### Refactoring",
		docs: "### Documentation",
		chore: "### Chores",
		test: "### Tests",
		ci: "### CI",
		build: "### Build",
	};

	const groups = {};
	for (const line of log.split("\n")) {
		if (!line.trim()) continue;
		// Skip release/chore-unreleased commits
		if (/^(release:|chore: add \[Unreleased\])/.test(line)) continue;
		const match = line.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/);
		if (match) {
			const [, type, scope, desc] = match;
			const key = typeLabels[type] ?? "### Other";
			if (!groups[key]) groups[key] = [];
			groups[key].push(scope ? `- **${scope}:** ${desc}` : `- ${desc}`);
		} else {
			// Non-conventional commit — bucket under Other
			if (!groups["### Other"]) groups["### Other"] = [];
			groups["### Other"].push(`- ${line}`);
		}
	}

	if (Object.keys(groups).length === 0) return null;

	// Render in a consistent order
	const order = ["### Features", "### Bug Fixes", "### Performance", "### Refactoring", "### Documentation", "### Tests", "### CI", "### Build", "### Chores", "### Other"];
	const sections = order
		.filter((k) => groups[k])
		.map((k) => `${k}\n${groups[k].join("\n")}`)
		.join("\n\n");

	return sections;
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();
	const commitLog = getCommitsSinceLastTag();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		// Check if the [Unreleased] section already has hand-written content
		const unreleasedMatch = content.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
		const existingContent = unreleasedMatch?.[1]?.trim() ?? "";

		// Build the new section body: prefer hand-written, fall back to auto-generated commits
		let sectionBody = existingContent;
		if (!sectionBody && commitLog) {
			sectionBody = commitLog;
			console.log(`  Auto-populating ${changelog} from git commits`);
		}

		const newSection = sectionBody
			? `## [${version}] - ${date}\n\n${sectionBody}\n`
			: `## [${version}] - ${date}\n`;

		const updated = content.replace(/## \[Unreleased\]\n[\s\S]*?(?=\n## \[|$)/, newSection);
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

// 1. Fetch tags from pull remote (for changelog scoping)
console.log("Fetching tags...");
run("git fetch pull --tags", { ignoreError: true });
console.log();

// 2. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true, allowInDryRun: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 3. Compute version
const version = computeVersion();
console.log(`Version: ${version}\n`);

// 4. Set version across all packages
console.log("Setting version across packages...");
if (!DRY_RUN) {
	setVersion(version);
}
console.log(`  Set all packages to ${version}\n`);

// 5. Update changelogs
console.log("Updating CHANGELOG.md files...");
if (!DRY_RUN) {
	updateChangelogsForRelease(version);
}
console.log();

// 6. Commit and tag
console.log("Committing and tagging...");
run("git add .");
run(`git commit -m "release: v${version}"`);
run(`git tag v${version}`);
console.log();

// 7. Build and publish
console.log("Building and publishing...");
run("cd packages/tui && bun run build && cd ../ai && bun run build && cd ../agent && bun run build && cd ../coding-agent && bun run build && cd ../mom && bun run build && cd ../web-ui && bun run build && cd ../pods && bun run build");
run("npm publish -ws --access public");
console.log();

// 8. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
if (!DRY_RUN) {
	addUnreleasedSection();
}
console.log();

// 9. Commit and push
console.log("Committing changelog updates...");
run("git add .");
run('git commit -m "chore: add [Unreleased] section for next cycle"');
console.log();

console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Released v${version} ===`);
