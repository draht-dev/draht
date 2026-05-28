#!/usr/bin/env node
/**
 * Sync the canonical draht-tools CLI from packages/draht-tools into the
 * consumer packages that ship it alongside their own publish artifact.
 *
 * Source of truth: packages/draht-tools/bin/draht-tools.cjs
 * Consumers:
 *   - packages/draht-claude/bin/draht-tools.cjs  (Claude Code plugin marketplace copy)
 *   - packages/draht-codex/bin/draht-tools.cjs   (Codex plugin marketplace copy)
 *   - packages/coding-agent/bin/draht-tools.cjs  (npm bin entry)
 *
 * Usage:
 *   node scripts/sync-draht-tools.mjs           # copy + report
 *   node scripts/sync-draht-tools.mjs --check   # exit 1 if drifted (for CI)
 */

import { copyFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = join(ROOT, "packages/draht-tools/bin/draht-tools.cjs");
const TARGETS = [
	join(ROOT, "packages/draht-claude/bin/draht-tools.cjs"),
	join(ROOT, "packages/draht-codex/bin/draht-tools.cjs"),
	join(ROOT, "packages/coding-agent/bin/draht-tools.cjs"),
];

const checkMode = process.argv.includes("--check");

if (!existsSync(SRC)) {
	console.error(`error: source missing: ${SRC}`);
	process.exit(1);
}
const src = readFileSync(SRC);
let drifted = false;

for (const target of TARGETS) {
	if (!existsSync(target)) {
		if (checkMode) { drifted = true; console.error(`drift: missing ${target}`); continue; }
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(SRC, target);
		chmodSync(target, 0o755);
		console.log(`+ ${target}`);
		continue;
	}
	const existing = readFileSync(target);
	if (!existing.equals(src)) {
		if (checkMode) { drifted = true; console.error(`drift: ${target}`); continue; }
		copyFileSync(SRC, target);
		chmodSync(target, 0o755);
		console.log(`↻ ${target}`);
	} else if (!checkMode) {
		console.log(`= ${target}`);
	}
}

if (checkMode && drifted) {
	console.error("\nRun: node scripts/sync-draht-tools.mjs");
	process.exit(1);
}
if (checkMode) console.log("draht-tools.cjs in sync across consumers");
