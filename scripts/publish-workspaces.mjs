#!/usr/bin/env node
/**
 * Publish all non-private workspace packages using `bun publish`.
 * Replaces `bun publish -ws` which is not supported in Bun 1.3.x.
 *
 * Usage: node scripts/publish-workspaces.mjs [--dry-run] [--tag <tag>] [--access <access>]
 */

import { execSync } from "child_process";
import { readFileSync, readdirSync, existsSync } from "fs";
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

let failed = false;

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

if (failed) {
	console.error("\nSome packages failed to publish.");
	process.exit(1);
}

console.log("\nAll packages published successfully.");
