#!/usr/bin/env node
/**
 * Drift gate for the graph-engine (Go binary fetch) installer block, which is
 * duplicated verbatim between packages/draht-claude/cli.mjs and
 * packages/draht-codex/cli.mjs (tar/zip extraction, checksum verification,
 * installGraphBinary, ensureGraphEngine, ...). Unlike draht-tools.cjs (a true
 * byte-copy synced by scripts/sync-draht-tools.mjs), these two files are NOT
 * byte-identical — each block legitimately references its own package name in
 * a handful of log strings ("draht-claude" vs "draht-codex", emoji style,
 * etc). This script normalizes away string/template-literal CONTENTS (where
 * that legitimate wording difference lives) and then diffs the remaining
 * code structure, so a fix to the tar reader, checksum logic, or any other
 * actual behavior lands in both packages or this check fails.
 *
 * Usage:
 *   node scripts/check-graph-engine-parity.mjs           # print a diff on drift
 *   node scripts/check-graph-engine-parity.mjs --check   # exit 1 on drift (for CI)
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const FILES = [
	join(ROOT, "packages/draht-claude/cli.mjs"),
	join(ROOT, "packages/draht-codex/cli.mjs"),
];

const START_MARKER = "// ─── graph engine (Go binary fetch)";
const END_MARKER = "async function cmdInstall";

function extractBlock(text, file) {
	const start = text.indexOf(START_MARKER);
	const end = text.indexOf(END_MARKER, start);
	if (start === -1 || end === -1) {
		console.error(`check:graph-engine-parity: could not locate the graph-engine block markers in ${file}`);
		process.exit(1);
	}
	return text.slice(start, end);
}

// Blank out string/template literal CONTENTS (not the delimiters, so the
// normalized text still shows where a log() call is), then drop `//` line
// comments and blank lines entirely — both are where the legitimate
// per-package wording differences live (package name in log strings, prose
// in comments). Deliberately simple (no escape-sequence handling, no /* */
// block comments — this file has none): good enough for this file's actual
// content, and a parse error here means the source changed shape, which is
// itself worth a look.
function normalize(block) {
	const stripped = block
		.replace(/`(?:[^`\\]|\\.)*`/g, "``")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\]|\\.)*'/g, "''");
	return stripped
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, "").trim())
		.filter(Boolean)
		.join("\n");
}

const blocks = FILES.map((f) => ({ file: f, raw: extractBlock(readFileSync(f, "utf-8"), f) }));
const normalized = blocks.map((b) => normalize(b.raw));

const checkMode = process.argv.includes("--check");

if (normalized[0] !== normalized[1]) {
	console.error("check:graph-engine-parity: the graph-engine installer block has drifted");
	console.error(`  between ${blocks[0].file}`);
	console.error(`      and ${blocks[1].file}`);
	console.error("(structural diff — string/template literal CONTENTS were ignored since those");
	console.error(" legitimately differ per package; everything else should not)");
	const a = normalized[0].split("\n");
	const b = normalized[1].split("\n");
	const max = Math.max(a.length, b.length);
	let shown = 0;
	for (let i = 0; i < max && shown < 20; i++) {
		if (a[i] !== b[i]) {
			console.error(`  line ${i + 1}:`);
			console.error(`    claude: ${a[i] ?? "<missing>"}`);
			console.error(`    codex:  ${b[i] ?? "<missing>"}`);
			shown++;
		}
	}
	process.exit(1);
}

console.log("check:graph-engine-parity: draht-claude/cli.mjs and draht-codex/cli.mjs graph-engine blocks match");
if (!checkMode) process.exit(0);
