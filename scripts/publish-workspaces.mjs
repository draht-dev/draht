#!/usr/bin/env node
/**
 * Publish all non-private workspace packages using `bun publish`.
 * Replaces `bun publish -ws` which is not supported in Bun 1.3.x.
 *
 * Resolves `workspace:*` dependencies to real version numbers before publishing,
 * then restores the original package.json files afterwards.
 *
 * Usage: node scripts/publish-workspaces.mjs [--dry-run] [--tag <tag>] [--access <access>]
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const tagIdx = args.indexOf("--tag");
const tag = tagIdx !== -1 ? args[tagIdx + 1] : null;
const accessIdx = args.indexOf("--access");
const access = accessIdx !== -1 ? args[accessIdx + 1] : "public";

const packagesDir = "packages";
const dirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);

// Build a map of workspace package name -> version
const versionMap = {};
for (const dir of dirs) {
	const pkgPath = join(packagesDir, dir, "package.json");
	if (!existsSync(pkgPath)) continue;
	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
	versionMap[pkg.name] = pkg.version;
}

// Collect original package.json contents so we can restore after publishing
const originals = new Map();

function resolveWorkspaceDeps(pkgPath) {
	const raw = readFileSync(pkgPath, "utf-8");
	const pkg = JSON.parse(raw);
	let changed = false;

	for (const depType of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		if (!pkg[depType]) continue;
		for (const [name, version] of Object.entries(pkg[depType])) {
			if (typeof version === "string" && version.startsWith("workspace:")) {
				const resolvedVersion = versionMap[name];
				if (!resolvedVersion) {
					console.error(`Cannot resolve workspace dependency ${name} — not found in workspace`);
					process.exit(1);
				}
				// workspace:* -> ^version, workspace:^ -> ^version, workspace:~ -> ~version
				let prefix = "^";
				if (version === "workspace:~" || version.startsWith("workspace:~")) prefix = "~";
				pkg[depType][name] = `${prefix}${resolvedVersion}`;
				changed = true;
			}
		}
	}

	if (changed) {
		originals.set(pkgPath, raw);
		writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
		console.log(`  Resolved workspace:* deps in ${pkgPath}`);
	}
}

function restoreOriginals() {
	for (const [pkgPath, content] of originals) {
		writeFileSync(pkgPath, content);
	}
	if (originals.size > 0) {
		console.log(`\nRestored ${originals.size} package.json file(s) to workspace:* references.`);
	}
}

// Resolve workspace references before publishing
console.log("Resolving workspace:* dependencies...");
for (const dir of dirs) {
	const pkgPath = join(packagesDir, dir, "package.json");
	if (!existsSync(pkgPath)) continue;
	resolveWorkspaceDeps(pkgPath);
}

let failed = false;

try {
	for (const dir of dirs) {
		const pkgPath = join(packagesDir, dir, "package.json");
		if (!existsSync(pkgPath)) continue;

		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		if (pkg.private) continue;

		const flags = [`--access ${access}`];
		if (tag) flags.push(`--tag ${tag}`);
		if (DRY_RUN) flags.push("--dry-run");

		const cmd = `bun publish ${flags.join(" ")}`;
		const cwd = join(packagesDir, dir);

		console.log(`\n--- Publishing ${pkg.name} (${cwd}) ---`);
		console.log(`$ ${cmd}`);

		try {
			execSync(cmd, { cwd, stdio: "inherit" });
		} catch (e) {
			console.error(`Failed to publish ${pkg.name}`);
			failed = true;
		}
	}
} finally {
	// Always restore originals, even if publishing fails
	restoreOriginals();
}

if (failed) {
	console.error("\nSome packages failed to publish.");
	process.exit(1);
}

console.log("\nAll packages published successfully.");
