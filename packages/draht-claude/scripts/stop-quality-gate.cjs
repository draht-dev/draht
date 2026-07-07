#!/usr/bin/env node
"use strict";

/**
 * Stop-Time Quality Gate Hook (Stop)
 * Runs the draht quality gate when the agent tries to end its turn with
 * uncommitted source changes in a .planning project — so the gate fires even
 * when the command prose that should have invoked it was skipped.
 *
 * Loop safety: exits 0 when stop_hook_active is set (we already blocked one
 * stop this turn), so a persistently red gate blocks at most one stop.
 * Opt out per-project with hooks.stopGate: false in .planning/config.json.
 */

const { execSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function readStdin() {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

try {
	const payload = JSON.parse(readStdin() || "{}");
	if (payload?.stop_hook_active) process.exit(0);

	const cwd = payload?.cwd || process.cwd();
	const planning = path.join(cwd, ".planning");
	if (!fs.existsSync(planning)) process.exit(0);

	// Config opt-out
	try {
		const config = JSON.parse(fs.readFileSync(path.join(planning, "config.json"), "utf-8"));
		if (config?.hooks?.stopGate === false) process.exit(0);
	} catch { /* no config — gate stays on */ }

	// Only gate when uncommitted source changes exist — a conversational turn
	// with a clean tree has nothing to verify.
	let dirty = "";
	try {
		dirty = execSync("git status --porcelain 2>/dev/null", { encoding: "utf-8", cwd, timeout: 10000 });
	} catch {
		process.exit(0); // not a git repo
	}
	const dirtySource = dirty
		.split("\n")
		.filter(Boolean)
		.map((l) => l.slice(3))
		.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
	if (dirtySource.length === 0) process.exit(0);

	// --no-tests: types + lint only. Test runs belong to the post-task hook and
	// /verify-work; a full suite on every turn-end would be unusable.
	const gate = path.join(__dirname, "gsd-quality-gate.cjs");
	const result = spawnSync("node", [gate, "--no-tests"], { encoding: "utf-8", cwd, timeout: 170000 });
	if (result.status !== 0 && !result.error) {
		console.error("Quality gate failed on uncommitted source changes — fix before ending the turn:");
		console.error((result.stdout || "").slice(0, 1500));
		process.exit(2);
	}
	process.exit(0);
} catch {
	process.exit(0);
}
