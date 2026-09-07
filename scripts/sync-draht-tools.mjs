#!/usr/bin/env node
/**
 * Sync the canonical draht-tools CLI (and its kg engine) from packages/draht-tools
 * into the consumer packages that ship it alongside their own publish artifact.
 *
 * Sources of truth:
 *   - packages/draht-tools/bin/draht-tools.cjs  (GSD CLI + living map)
 *   - packages/draht-tools/bin/draht-kg.cjs     (graphify-parity symbol graph engine)
 * Consumers:
 *   - packages/draht-claude/bin/   (Claude Code plugin marketplace copy)
 *   - packages/draht-codex/bin/    (Codex plugin marketplace copy)
 *   - packages/coding-agent/bin/   (npm bin entry)
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
const FILES = ["draht-tools.cjs", "draht-kg.cjs"];
const SRC_DIR = join(ROOT, "packages/draht-tools/bin");
const TARGET_DIRS = [
	join(ROOT, "packages/draht-claude/bin"),
	join(ROOT, "packages/draht-codex/bin"),
	join(ROOT, "packages/coding-agent/bin"),
];

const checkMode = process.argv.includes("--check");
let drifted = false;

for (const file of FILES) {
	const srcPath = join(SRC_DIR, file);
	if (!existsSync(srcPath)) {
		console.error(`error: source missing: ${srcPath}`);
		process.exit(1);
	}
	const src = readFileSync(srcPath);
	for (const dir of TARGET_DIRS) {
		const target = join(dir, file);
		if (!existsSync(target)) {
			if (checkMode) { drifted = true; console.error(`drift: missing ${target}`); continue; }
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(srcPath, target);
			chmodSync(target, 0o755);
			console.log(`+ ${target}`);
			continue;
		}
		const existing = readFileSync(target);
		if (!existing.equals(src)) {
			if (checkMode) { drifted = true; console.error(`drift: ${target}`); continue; }
			copyFileSync(srcPath, target);
			chmodSync(target, 0o755);
			console.log(`↻ ${target}`);
		} else if (!checkMode) {
			console.log(`= ${target}`);
		}
	}
}

if (checkMode && drifted) {
	console.error("\nRun: node scripts/sync-draht-tools.mjs");
	process.exit(1);
}
if (checkMode) console.log("draht-tools bin files in sync across consumers");
