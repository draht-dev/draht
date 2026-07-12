#!/usr/bin/env node
/**
 * Import-boundary gate for geist (spec §17.1, R31-FOUND.4).
 *
 * geist is architecturally a SEPARATE product that happens to live in the draht
 * monorepo. Its harness-free layers must never gain code-level access to draht:
 *
 *   packages/geist-core     — harness-free product logic  → imports ZERO @draht/*
 *   packages/geist-acp      — ACP client / HarnessSession  → imports ZERO @draht/*
 *   packages/geist-console  — React /ui                    → imports ZERO @draht/*
 *   quest/                  — Kotlin headset app           → imports ZERO @draht/*
 *
 * ONLY packages/draht-acp — the thin ACP shim wrapping @draht/coding-agent — is
 * allowed to import @draht/*, and so is deliberately NOT scanned here.
 *
 * Naming nuance: every package in this monorepo is npm-scoped `@draht/*`,
 * INCLUDING the geist family itself. So a bare "any @draht/* import is
 * forbidden" rule would wrongly flag geist-core importing its own sibling
 * `@draht/geist-protocol`. The GEIST_FAMILY allowlist below is the set of
 * sibling packages that are legitimate intra-family imports; anything else
 * matching /^@draht\// inside a boundary-checked package is a violation.
 *
 * quest/ is Kotlin and has no legitimate @draht/* import at all (it mirrors
 * wire types by hand — see check-geist-mirrors.mjs), so ANY @draht/* specifier
 * there is a violation with no allowlist, and a package.json appearing anywhere
 * under quest/ is itself a violation (spec §8: quest/ is NOT an npm workspace).
 *
 * Usage:
 *   node scripts/check-geist-boundary.mjs   # exit 1 on any boundary violation
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Sibling packages a boundary-checked geist package MAY import (intra-family).
// Everything else matching /^@draht\// is a violation.
const GEIST_FAMILY = new Set([
	"@draht/geist",
	"@draht/geist-core",
	"@draht/geist-acp",
	"@draht/geist-protocol",
	"@draht/geist-picker",
	"@draht/geist-console",
	"@draht/draht-acp",
]);

// TS/JS layers that must not import outside the geist family. These dirs may not
// all exist yet while sibling scaffold tasks run in parallel — a missing dir is
// zero violations, not an error, so this script stays correct when run later.
const BOUNDARY_SRC_DIRS = [
	join(ROOT, "packages/geist-core/src"),
	join(ROOT, "packages/geist-acp/src"),
	join(ROOT, "packages/geist-console/src"),
];

const QUEST_DIR = join(ROOT, "quest");

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".gradle", ".git", ".idea"]);

// Import/require specifier extractors. The string literal of an import is always
// on a single line even when the import statement spans several, so a per-line
// scan is sufficient and avoids a full parser.
const SPECIFIER_PATTERNS = [
	/\bfrom\s+["']([^"']+)["']/g, //            import x from "y" | export * from "y"
	/\bimport\s+["']([^"']+)["']/g, //          import "y"  (side-effect)
	/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("y")  (dynamic)
	/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("y")
];

function walk(dir, exts) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...walk(full, exts));
		} else if (!exts || exts.some((e) => entry.name.endsWith(e))) {
			out.push(full);
		}
	}
	return out;
}

function extractSpecifiers(line) {
	const specs = [];
	for (const re of SPECIFIER_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(line)) !== null) specs.push(m[1]);
	}
	return specs;
}

function scanImports(file) {
	const hits = [];
	const lines = readFileSync(file, "utf-8").split("\n");
	lines.forEach((line, idx) => {
		for (const specifier of extractSpecifiers(line)) hits.push({ line: idx + 1, specifier });
	});
	return hits;
}

function packageNameOf(specifier) {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function rel(file) {
	return file.slice(ROOT.length + 1);
}

const violations = [];

// ── 1. geist TS/JS layers: only intra-family @draht/* imports allowed ─────────
for (const dir of BOUNDARY_SRC_DIRS) {
	for (const file of walk(dir, CODE_EXTS)) {
		for (const { line, specifier } of scanImports(file)) {
			if (!/^@draht\//.test(specifier)) continue;
			if (GEIST_FAMILY.has(packageNameOf(specifier))) continue;
			violations.push(`${rel(file)}:${line}  imports "${specifier}" (outside the geist family)`);
		}
	}
}

// ── 2. quest/: no @draht/* import at all, and no npm package.json ─────────────
for (const file of walk(QUEST_DIR, null)) {
	if (basename(file) === "package.json") {
		violations.push(`${rel(file)}  quest/ must NOT be an npm workspace (spec §8)`);
		continue;
	}
	if (!CODE_EXTS.includes(extname(file))) continue;
	for (const { line, specifier } of scanImports(file)) {
		if (/^@draht\//.test(specifier)) {
			violations.push(`${rel(file)}:${line}  imports "${specifier}" (quest/ may import zero @draht/*)`);
		}
	}
}

// ── Report ────────────────────────────────────────────────────────────────────
if (violations.length > 0) {
	console.error(`geist import boundary violated (${violations.length} problem(s)):\n`);
	for (const v of violations) console.error(`  ✗ ${v}`);
	console.error(
		"\ngeist-core / geist-acp / geist-console / quest are harness-free — they must not import @draht/* (only packages/draht-acp may). Spec §17.1.",
	);
	process.exit(1);
}
console.log("geist import boundary clean");
