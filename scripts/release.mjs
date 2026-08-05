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
 * 6. Build, commit, tag, and push the release commit/tag
 * 7. Wait for the complete matching GitHub release, then publish to npm
 * 8. Add new [Unreleased] section to changelogs
 * 9. Commit and push the next-cycle changelogs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
	assertReleaseVersions,
	getScopePackages,
	setVersion,
	waitForVerifiedRelease,
} from "./release-helpers.mjs";

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

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

/**
 * Map conventional commit scopes to package directory names.
 * Scopes not listed here fall back to file-path-based detection.
 */
const TYPE_LABELS = {
	feat: "### Added",
	fix: "### Fixed",
	perf: "### Changed",
	refactor: "### Changed",
	docs: "### Changed",
	chore: "### Changed",
	test: "### Changed",
	ci: "### Changed",
	build: "### Changed",
};

const SECTION_ORDER = ["### Breaking Changes", "### Added", "### Changed", "### Fixed", "### Removed"];

/**
 * Get the package directories affected by a commit based on changed file paths.
 */
function getAffectedPackages(commitHash) {
	let files = "";
	try {
		files = execSync(`git diff-tree --no-commit-id --name-only -r ${commitHash} 2>/dev/null`, { encoding: "utf-8" }).trim();
	} catch { return []; }
	if (!files) return [];

	const packages = new Set();
	for (const file of files.split("\n")) {
		const match = file.match(/^packages\/([^/]+)\//);
		if (match) packages.add(match[1]);
	}
	return [...packages];
}

/**
 * Find the last release tag whose changelog entries have actual content.
 * Walks backwards through tags (newest first) and checks if any package's
 * CHANGELOG.md has non-empty content for that version. This skips over
 * empty releases that were produced by buggy older release scripts.
 */
function findLastContentfulTag() {
	const tags = execSync("git tag -l 'v*' --sort=-creatordate", { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
	const changelogs = getChangelogs();

	for (const tag of tags) {
		const version = tag.slice(1); // strip 'v' prefix
		const versionEscaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

		for (const changelog of changelogs) {
			const content = readFileSync(changelog, "utf-8");
			// Match the version header and capture content until next version header or EOF
			const regex = new RegExp(`## \\[${versionEscaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
			const match = content.match(regex);
			if (match?.[1]?.trim()) {
				console.log(`  Baseline tag: ${tag} (has content in ${changelog})`);
				return tag;
			}
		}
	}

	return null;
}

/**
 * Collect commits since last contentful tag and group them per package directory.
 * Returns Map<packageDir, Map<sectionHeader, string[]>> where string[] are bullet lines.
 */
function getCommitsPerPackage() {
	const lastTag = findLastContentfulTag();
	const range = lastTag ? `${lastTag}..HEAD` : "HEAD";

	console.log(`  Commit range: ${range}`);

	let log = "";
	try {
		// Format: hash<SEP>subject
		log = execSync(`git log ${range} --format="%H<SEP>%s" 2>/dev/null`, { encoding: "utf-8" }).trim();
	} catch { /* ignore */ }

	if (!log) return new Map();

	// packageDir -> Map<sectionHeader, bulletLines[]>
	const perPackage = new Map();

	function addEntry(pkgDir, section, bullet) {
		if (!perPackage.has(pkgDir)) perPackage.set(pkgDir, new Map());
		const sections = perPackage.get(pkgDir);
		if (!sections.has(section)) sections.set(section, []);
		sections.get(section).push(bullet);
	}

	for (const line of log.split("\n")) {
		if (!line.trim()) continue;
		const sepIdx = line.indexOf("<SEP>");
		if (sepIdx === -1) continue;
		const hash = line.slice(0, sepIdx);
		const subject = line.slice(sepIdx + 5);

		// Skip release and meta commits
		if (/^(release:|chore: add \[Unreleased\])/.test(subject)) continue;

		const conventionalMatch = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
		if (!conventionalMatch) continue; // skip non-conventional commits

		const [, type, scope, breaking, desc] = conventionalMatch;
		const section = breaking ? "### Breaking Changes" : (TYPE_LABELS[type] ?? "### Changed");
		const bullet = `- ${desc}`;

		// Determine target packages
		let targetPackages = [];

		if (scope && getScopePackages(scope).length > 0) {
			// A scope may affect multiple published packages (for example the Go
			// graph engine is shipped/resolved by all three Node consumers).
			targetPackages = getScopePackages(scope);
		} else {
			// Fall back to file-path detection
			targetPackages = getAffectedPackages(hash);
		}

		// If we still have no target, skip (root-level commits like CI changes)
		for (const pkg of targetPackages) {
			addEntry(pkg, section, bullet);
		}
	}

	return perPackage;
}

/**
 * Render grouped sections into a markdown string.
 */
function renderSections(sections) {
	const parts = SECTION_ORDER
		.filter((s) => sections.has(s))
		.map((s) => `${s}\n\n${sections.get(s).join("\n")}`);
	return parts.join("\n\n");
}

/**
 * Remove empty version entries from a changelog string.
 * An empty entry is a `## [version] - date` line followed by no content
 * before the next `## [` or end of file.
 */
function removeEmptyVersionEntries(content) {
	// Match version headers with no content (only whitespace) before the next header or EOF
	return content.replace(/## \[\d[^\]]*\][^\n]*\n\s*(?=## \[|$)/g, "");
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const commitsPerPackage = getCommitsPerPackage();

	const packagesDir = "packages";
	const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const dir of packageDirs) {
		const changelog = join(packagesDir, dir, "CHANGELOG.md");
		if (!existsSync(changelog)) continue;

		let content = readFileSync(changelog, "utf-8");
		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const sections = commitsPerPackage.get(dir);
		const sectionBody = sections ? renderSections(sections) : "";

		const newSection = sectionBody
			? `## [${version}] - ${date}\n\n${sectionBody}\n`
			: `## [${version}] - ${date}\n`;

		content = content.replace(/## \[Unreleased\]\n[\s\S]*?(?=\n## \[|$)/, newSection);

		// Clean up empty version entries left by previous broken releases
		content = removeEmptyVersionEntries(content);

		writeFileSync(changelog, content);
		if (sectionBody) {
			console.log(`  Updated ${changelog} (from git commits)`);
		} else {
			console.log(`  Updated ${changelog} (no changes)`);
		}
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
run("git fetch origin --tags", { ignoreError: true });
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
	setVersion(process.cwd(), version);
	run("bun install --lockfile-only --ignore-scripts");
	run("bun install --frozen-lockfile --ignore-scripts --linker hoisted");
	assertReleaseVersions(process.cwd(), version);
}
console.log(`  Set all packages to ${version}\n`);

// 5. Update changelogs
console.log("Updating CHANGELOG.md files...");
if (!DRY_RUN) {
	updateChangelogsForRelease(version);
}
console.log();

console.log("Running tests...");
run("./test.sh");
console.log();

// 6. Build, commit, tag, and make the immutable tag public. The tag-triggered
// workflow must finish the matching GitHub release before npm can become public.
console.log("Building packages...");
run("bun run build");
console.log();

console.log("Committing and tagging...");
run("git add .");
run(`git commit -m "release: v${version}"`);
run(`git tag v${version}`);
console.log();

console.log("Pushing release commit and tag...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

// 7. Gate npm publication on the complete, content-verified GitHub release.
// This includes both the primary Draht runtime archives and the Go graph-engine
// assets. A partial, stale, or corrupted release is retried for up to ten
// minutes and then aborts before any npm package is public.
console.log("Waiting for and verifying required release assets...");
if (!DRY_RUN) {
	await waitForVerifiedRelease({ tag: `v${version}`, version });
	console.log("  GitHub release identity, manifest, and runtime archives verified\n");
} else {
	console.log("  (dry-run: release artifact polling and verification skipped)\n");
}

console.log("Publishing npm packages...");
// Daily version suffixes like 2026.3.2-4 are NOT prereleases — they're the Nth release of the day.
// Only versions with non-numeric suffixes (e.g., -beta, -rc.1, -alpha) are prereleases.
const isPrerelease = /-[a-zA-Z]/.test(version);
// Publish each non-private package individually (bun publish -ws is not supported in Bun 1.3.x)
// The publish script resolves workspace:* deps to real versions before publishing and restores after
run(`node scripts/publish-workspaces.mjs --access public${isPrerelease ? " --tag next" : ""}`);
console.log();

// 8. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
if (!DRY_RUN) {
	addUnreleasedSection();
}
console.log();

// 9. Commit and push the next-cycle changelog section only after publication.
console.log("Committing changelog updates...");
run("git add .");
run('git commit -m "chore: add [Unreleased] section for next cycle"');
console.log();

console.log("Pushing changelog update...");
run("git push origin main");
console.log();

console.log(`=== Released v${version} ===`);
