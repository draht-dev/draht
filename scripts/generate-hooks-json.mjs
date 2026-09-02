#!/usr/bin/env node
/**
 * Generate the canonical hooks.json for each plugin consumer from the single
 * in-script template below, so hook definitions can't silently drift between
 * packages/draht-claude and packages/draht-codex.
 *
 * Source of truth: the hooksTemplate() function in this file.
 * Consumers:
 *   - packages/draht-claude/hooks/hooks.json  (uses ${CLAUDE_PLUGIN_ROOT})
 *   - packages/draht-codex/hooks/hooks.json   (uses ${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}})
 *
 * Usage:
 *   node scripts/generate-hooks-json.mjs           # generate + report
 *   node scripts/generate-hooks-json.mjs --check   # exit 1 if drifted (for CI)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Placeholder substituted with each consumer's plugin-root expression below.
const PLUGIN_ROOT_TOKEN = "__PLUGIN_ROOT__";

function hooksTemplate() {
	return {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/session-start.cjs"`,
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/prompt-context.cjs"`,
						},
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/judge-hook.cjs" UserPromptSubmit`,
							timeout: 10,
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "Edit|Write|MultiEdit",
					hooks: [
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/post-edit-check.cjs"`,
							timeout: 30,
						},
					],
				},
			],
			Stop: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/stop-quality-gate.cjs"`,
							timeout: 180,
						},
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/judge-hook.cjs" Stop`,
							timeout: 20,
						},
					],
				},
			],
			// The judge queue parks a permission request as a card and waits for
			// the human swipe, so its timeout is an hour rather than seconds: the
			// hook is blocked for exactly as long as the person takes. With the
			// judge TUI not running the hook returns immediately and the host's
			// own permission dialog appears, so the long timeout never bites.
			PermissionRequest: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `node "${PLUGIN_ROOT_TOKEN}/scripts/judge-hook.cjs" PermissionRequest`,
							timeout: 3600,
						},
					],
				},
			],
		},
	};
}

const TARGETS = [
	{
		path: join(ROOT, "packages/draht-claude/hooks/hooks.json"),
		pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
	},
	{
		path: join(ROOT, "packages/draht-codex/hooks/hooks.json"),
		pluginRoot: "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}",
	},
];

function render(pluginRoot) {
	const json = JSON.stringify(hooksTemplate(), null, 2);
	return `${json.split(PLUGIN_ROOT_TOKEN).join(pluginRoot)}\n`;
}

const checkMode = process.argv.includes("--check");
let drifted = false;

for (const target of TARGETS) {
	const generated = render(target.pluginRoot);

	if (!existsSync(target.path)) {
		if (checkMode) {
			drifted = true;
			console.error(`drift: missing ${target.path}`);
			continue;
		}
		mkdirSync(dirname(target.path), { recursive: true });
		writeFileSync(target.path, generated);
		console.log(`+ ${target.path}`);
		continue;
	}

	const existing = readFileSync(target.path, "utf8");
	if (existing !== generated) {
		if (checkMode) {
			drifted = true;
			console.error(`drift: ${target.path}`);
			continue;
		}
		writeFileSync(target.path, generated);
		console.log(`↻ ${target.path}`);
	} else if (!checkMode) {
		console.log(`= ${target.path}`);
	}
}

if (checkMode && drifted) {
	console.error("\nRun: node scripts/generate-hooks-json.mjs");
	process.exit(1);
}
if (checkMode) console.log("hooks.json in sync across consumers");
