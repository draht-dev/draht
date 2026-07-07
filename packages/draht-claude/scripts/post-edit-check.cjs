#!/usr/bin/env node
"use strict";

/**
 * Post-Edit Check Hook (PostToolUse: Edit|Write)
 * Lints the edited file immediately, so formatting/lint rules hold on every
 * edit instead of waiting for a commit or a prose-invoked gate.
 *
 * Reads the hook payload from stdin, runs a file-scoped `biome check` when the
 * project uses Biome, and exits 2 with the findings on stderr so the agent
 * sees and fixes them. Exits 0 (silent) in projects without Biome, for
 * non-code files, and on any unexpected error — this hook must never wedge a
 * session.
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function readStdin() {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

try {
	const payload = JSON.parse(readStdin() || "{}");
	const filePath = payload?.tool_input?.file_path;
	if (!filePath || !fs.existsSync(filePath)) process.exit(0);
	if (!CODE_EXTENSIONS.has(path.extname(filePath))) process.exit(0);

	const cwd = payload?.cwd || process.cwd();
	if (!fs.existsSync(path.join(cwd, "biome.json"))) process.exit(0);

	const runner = fs.existsSync(path.join(cwd, "bun.lock")) || fs.existsSync(path.join(cwd, "bun.lockb"))
		? "bunx"
		: "npx";
	try {
		execSync(`${runner} biome check --error-on-warnings ${JSON.stringify(filePath)} 2>&1`, {
			timeout: 15000,
			encoding: "utf-8",
			cwd,
		});
	} catch (error) {
		const output = (error.stdout || error.stderr || "").toString();
		if (error.signal || !output.trim()) process.exit(0); // timeout or tool failure — don't block
		if (output.includes("No files were processed")) process.exit(0); // file ignored by biome config
		console.error(`Lint issues in ${filePath} (fix before proceeding):`);
		console.error(output.slice(0, 1500));
		process.exit(2);
	}
	process.exit(0);
} catch {
	process.exit(0);
}
