#!/usr/bin/env node
/**
 * Import-boundary gate for geist (spec §17.1, R31-FOUND.4).
 *
 * geist is architecturally a SEPARATE product that happens to live in the draht
 * monorepo. Every non-shim geist package must stay free of code-level access to
 * draht — the kernel AND the privileged shim:
 *
 *   packages/geist           — CLI + composition root
 *   packages/geist-core      — harness-free product logic
 *   packages/geist-acp       — ACP client / HarnessSession
 *   packages/geist-protocol  — wire types & config contracts
 *   packages/geist-picker    — in-page element picker
 *   packages/geist-console   — React /ui
 *   quest/                   — Kotlin headset app → zero @draht/* references
 *
 * Each of the six packages above may import ONLY its non-privileged geist
 * siblings. `@draht/draht-acp` is the privileged shim — the one package allowed
 * to import the Draht kernel — so importing IT from a boundary package would
 * re-privilege draht through the back door (spec §19 risk row); the shim is
 * deliberately NOT in the allowlist and deliberately NOT scanned here.
 *
 * Naming nuance: every package in this monorepo is npm-scoped `@draht/*`,
 * INCLUDING the geist family itself. So a bare "any @draht/* import is
 * forbidden" rule would wrongly flag geist-core importing its own sibling
 * `@draht/geist-protocol`. The GEIST_FAMILY allowlist below is the set of
 * sibling packages that are legitimate intra-family imports; anything else
 * matching /^@draht\// inside a boundary-checked package is a violation.
 *
 * The whole package directory is scanned — src, test, fixtures, config files —
 * because a privileged import in a test leaks kernel access into the package's
 * evidence just as surely as one in src (the 2026-07-13 audit reopened Phase 31
 * precisely because enforcement was narrower than the claim).
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
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Sibling packages a boundary-checked geist package MAY import (intra-family,
// non-privileged — @draht/draht-acp is NOT here and must never be). Everything
// else matching /^@draht\// is a violation.
const GEIST_FAMILY = new Set([
	"@draht/geist",
	"@draht/geist-core",
	"@draht/geist-acp",
	"@draht/geist-protocol",
	"@draht/geist-picker",
	"@draht/geist-console",
]);

// The six non-shim geist packages (R31-FOUND.4). Whole package dirs — src,
// test, fixtures, top-level config — are scanned, not just src/.
const BOUNDARY_PACKAGES = [
	join(ROOT, "packages/geist"),
	join(ROOT, "packages/geist-core"),
	join(ROOT, "packages/geist-acp"),
	join(ROOT, "packages/geist-protocol"),
	join(ROOT, "packages/geist-picker"),
	join(ROOT, "packages/geist-console"),
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

// ── 1. geist packages: only non-privileged intra-family @draht/* imports, ─────
//      and no path imports escaping the package root (a relative import into
//      packages/coding-agent is the same breach without the npm scope).
for (const dir of BOUNDARY_PACKAGES) {
	for (const file of walk(dir, CODE_EXTS)) {
		for (const { line, specifier } of scanImports(file)) {
			if (specifier.startsWith(".") || specifier.startsWith("/")) {
				const resolved = resolve(dirname(file), specifier);
				if (resolved !== dir && !resolved.startsWith(dir + sep)) {
					violations.push(
						`${rel(file)}:${line}  imports "${specifier}" (path import escapes ${rel(dir)})`,
					);
				}
				continue;
			}
			if (!/^@draht\//.test(specifier)) continue;
			if (GEIST_FAMILY.has(packageNameOf(specifier))) continue;
			violations.push(`${rel(file)}:${line}  imports "${specifier}" (outside the non-privileged geist family)`);
		}
	}
}

// ── 2. quest/: zero @draht/* references in ANY file, and no npm package.json ──
// quest/ is Kotlin: imports there never look like JS specifiers, so the scan is
// plain full text — a reference in a comment or string is a violation exactly
// like an import (R31-FOUND.7: "every @draht/* reference"). Binary artifacts
// (gradle wrapper jars, images, keystores) are skipped by extension.
const QUEST_BINARY_EXTS = new Set([
	".jar",
	".png",
	".webp",
	".jpg",
	".so",
	".zip",
	".keystore",
	".jks",
	".bin",
	".aab",
	".apk",
]);
for (const file of walk(QUEST_DIR, null)) {
	if (basename(file) === "package.json") {
		violations.push(`${rel(file)}  quest/ must NOT be an npm workspace (spec §8)`);
		continue;
	}
	if (QUEST_BINARY_EXTS.has(extname(file))) continue;
	readFileSync(file, "utf-8")
		.split("\n")
		.forEach((text, idx) => {
			if (text.includes("@draht/")) {
				violations.push(
					`${rel(file)}:${idx + 1}  references "@draht/" (quest/ must hold zero @draht/* references)`,
				);
			}
		});
}

// ── Report ────────────────────────────────────────────────────────────────────
if (violations.length > 0) {
	console.error(`geist import boundary violated (${violations.length} problem(s)):\n`);
	for (const v of violations) console.error(`  ✗ ${v}`);
	console.error(
		"\ngeist / geist-core / geist-acp / geist-protocol / geist-picker / geist-console / quest are harness-free — they must not import the Draht kernel or the privileged @draht/draht-acp shim (only packages/draht-acp may import the kernel). Spec §17.1, R31-FOUND.4.",
	);
	process.exit(1);
}
console.log("geist import boundary clean");
