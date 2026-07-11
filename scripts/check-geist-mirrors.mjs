#!/usr/bin/env node
/**
 * Drift gate: geist wire types (zod, packages/geist-protocol) ↔ their Kotlin
 * `data class` mirrors under quest/ (spec §6 tooling row: "Zod + Kotlin mirrors
 * + check-geist-mirrors"; R31-FOUND.5).
 *
 * The bridge defines every WS/protocol shape once, as a zod schema in
 * geist-protocol. The Quest (Kotlin) app cannot import those TS types, so a
 * hand-written Kotlin mirror is maintained per shape. This check fails when a
 * schema declared as "must be mirrored" has no Kotlin counterpart of the
 * matching name — so a wire type added to the bridge without a Kotlin mirror is
 * caught by `npm run check`, not at runtime on the headset.
 *
 * MIRRORED_SCHEMAS is the explicit, hand-maintained set of exported identifiers
 * from geist-protocol/src/index.ts that MUST have a Kotlin mirror. It starts
 * EMPTY: Phase 31 has no Kotlin panels and mirrors nothing yet. This is honest,
 * not a stub — the machinery below really fails the moment a name is added here
 * without its `data class`. Later phases (M0+ Kotlin panels) append identifiers
 * as their mirrors land, e.g. ["FleetStateSchema", "PermissionRequestSchema"].
 *
 * Convention: a zod export `FooSchema` mirrors Kotlin `data class Foo` (the
 * trailing "Schema" is stripped); an export without that suffix is used
 * verbatim. Each entry MUST be an explicitly named export of index.ts — a name
 * reachable only via `export *` is treated as not exported and fails loudly, on
 * purpose, so mirrored types stay first-class in the barrel.
 *
 * Usage:
 *   node scripts/check-geist-mirrors.mjs   # exit 1 on missing/renamed mirror
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROTOCOL_INDEX = join(ROOT, "packages/geist-protocol/src/index.ts");
const QUEST_DIR = join(ROOT, "quest");

// See header. EMPTY until the first Kotlin mirror lands (later phases append).
const MIRRORED_SCHEMAS = [];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".gradle", ".git", ".idea"]);

function kotlinClassNameFor(exportName) {
	return exportName.endsWith("Schema") ? exportName.slice(0, -"Schema".length) : exportName;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(dir, exts) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...walk(full, exts));
		} else if (exts.some((e) => entry.name.endsWith(e))) {
			out.push(full);
		}
	}
	return out;
}

// Explicitly named exports of the barrel: `export const Foo` and the names
// listed in `export { Foo, Bar as Baz }` (the exported name is taken after `as`).
function exportedNames(file) {
	const names = new Set();
	if (!existsSync(file)) return names;
	const src = readFileSync(file, "utf-8");
	for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
	for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const raw of m[1].split(",")) {
			const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
			if (name) names.add(name);
		}
	}
	return names;
}

const exported = exportedNames(PROTOCOL_INDEX);
const kotlinSources = walk(QUEST_DIR, [".kt", ".kts"]).map((f) => readFileSync(f, "utf-8"));

const problems = [];
for (const schema of MIRRORED_SCHEMAS) {
	if (!exported.has(schema)) {
		problems.push(`"${schema}" is listed in MIRRORED_SCHEMAS but is not an exported member of packages/geist-protocol/src/index.ts`);
		continue;
	}
	const cls = kotlinClassNameFor(schema);
	const dataClassRe = new RegExp(`\\bdata class\\s+${escapeRegExp(cls)}\\b`);
	if (!kotlinSources.some((src) => dataClassRe.test(src))) {
		problems.push(`no Kotlin \`data class ${cls}\` found under quest/ for mirrored schema "${schema}"`);
	}
}

if (problems.length > 0) {
	console.error(`geist protocol↔Kotlin mirror drift (${problems.length} problem(s)):\n`);
	for (const p of problems) console.error(`  ✗ ${p}`);
	console.error("\nAdd the Kotlin `data class` mirror under quest/, or remove the schema from MIRRORED_SCHEMAS in scripts/check-geist-mirrors.mjs.");
	process.exit(1);
}

console.log(
	MIRRORED_SCHEMAS.length === 0
		? "geist protocol↔Kotlin mirrors clean (MIRRORED_SCHEMAS empty — nothing mirrored yet)"
		: `geist protocol↔Kotlin mirrors in sync (${MIRRORED_SCHEMAS.length} schema(s))`,
);
