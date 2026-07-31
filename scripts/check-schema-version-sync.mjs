#!/usr/bin/env node
/**
 * Asserts GRAPH_SCHEMA_VERSION stays in sync across its independently
 * hand-maintained copies:
 *   - packages/draht-tools/bin/draht-tools.cjs: visBuildMap()'s
 *     `schemaVersion: 5` literal (what MAP.json actually gets stamped with)
 *     AND the GRAPH_SCHEMA_VERSION constant the resolver checks binaries
 *     against.
 *   - packages/draht-claude/cli.mjs and packages/draht-codex/cli.mjs: the
 *     GRAPH_SCHEMA_VERSION constant each writes into the install-time
 *     .draht-graph.json provenance stamp.
 *
 * These four sites have no shared import (three separate npm packages, one
 * of them CommonJS) so nothing enforces agreement at runtime. Both drift
 * directions fail SILENTLY at runtime: bump the JS schema without the
 * constants and stamped Go binaries keep being accepted while producing an
 * older-schema MAP.json; bump the constants without a matching release and
 * every stamped install is rejected, silently falling back to the JS engine.
 * This must therefore be a build-time check.
 *
 * Usage: node scripts/check-schema-version-sync.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function extract(file, pattern, label) {
	const text = readFileSync(file, "utf-8");
	const m = text.match(pattern);
	if (!m) {
		console.error(`check:schema-version-sync: could not find ${label} in ${file}`);
		process.exit(1);
	}
	return Number(m[1]);
}

const drahtTools = join(ROOT, "packages/draht-tools/bin/draht-tools.cjs");
const claude = join(ROOT, "packages/draht-claude/cli.mjs");
const codex = join(ROOT, "packages/draht-codex/cli.mjs");

const sites = {
	"draht-tools.cjs visBuildMap() schemaVersion literal": extract(drahtTools, /schemaVersion:\s*(\d+),/, "visBuildMap()'s schemaVersion literal"),
	"draht-tools.cjs GRAPH_SCHEMA_VERSION": extract(drahtTools, /const GRAPH_SCHEMA_VERSION = (\d+);/, "GRAPH_SCHEMA_VERSION"),
	"draht-claude/cli.mjs GRAPH_SCHEMA_VERSION": extract(claude, /const GRAPH_SCHEMA_VERSION = (\d+);/, "GRAPH_SCHEMA_VERSION"),
	"draht-codex/cli.mjs GRAPH_SCHEMA_VERSION": extract(codex, /const GRAPH_SCHEMA_VERSION = (\d+);/, "GRAPH_SCHEMA_VERSION"),
};

const distinct = new Set(Object.values(sites));
if (distinct.size > 1) {
	console.error("check:schema-version-sync: GRAPH_SCHEMA_VERSION has drifted across its hand-maintained copies:");
	for (const [label, value] of Object.entries(sites)) console.error(`  ${value}  ${label}`);
	console.error("\nBump every copy together, or the stamp/version gate silently misbehaves in one direction or the other.");
	process.exit(1);
}

console.log(`check:schema-version-sync: ok (schemaVersion ${[...distinct][0]} in sync across ${Object.keys(sites).length} sites)`);
