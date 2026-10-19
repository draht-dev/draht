#!/usr/bin/env node
"use strict";

/**
 * Stop-Time Quality Gate Hook (Stop)
 * Runs the draht quality gate when the agent tries to end its turn with
 * uncommitted JavaScript or TypeScript changes, independently of planning
 * metadata or whether command prose invoked verification.
 *
 * Explicit project checks cover every configured language and committed work.
 * Passing evidence is reused only while its input scope is unchanged. A failed
 * repeated Stop remains failed; the host retry flag cannot bypass verification.
 */

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { runChecks } = require("./checks-runtime.cjs");

function readStdin() {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

function hasSourceChanges(status) {
	const entries = status.split("\0");
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const files = [entry.slice(3)];
		// In porcelain -z, a rename/copy records destination then original path.
		if (/[RC]/.test(entry.slice(0, 2))) files.push(entries[++index] || "");
		if (files.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))) return true;
	}
	return false;
}

function failGate(result) {
	const reason = result.error?.code || result.signal ||
		(typeof result.status === "number" ? `exit ${result.status}` : "unknown exit");
	console.error(`Quality gate failed on uncommitted source changes (${reason}) — fix before ending the turn:`);
	for (const output of [result.stdout, result.stderr, result.error?.message]) {
		if (output) console.error(String(output).slice(0, 1500));
	}
	process.exit(2);
}

try {
	const payload = JSON.parse(readStdin() || "{}");

	const cwd = payload?.cwd || process.cwd();
	const project = runChecks({ cwd });
	if (project.configured || project.status === "failed") {
		if (project.status === "failed") {
			console.error(project.summary);
			for (const check of project.checks) if (check.output) console.error(check.output.slice(0, 1500));
			process.exit(2);
		}
		process.exit(0);
	}
	const planning = path.join(cwd, ".planning");

	// Planning metadata is optional; retain existing projects' explicit opt-out.
	try {
		const config = JSON.parse(fs.readFileSync(path.join(planning, "config.json"), "utf-8"));
		if (config?.hooks?.stopGate === false) process.exit(0);
	} catch { /* no config — gate stays on */ }

	// Only gate when uncommitted source changes exist — a conversational turn
	// with a clean tree has nothing to verify.
	let dirty = "";
	try {
		dirty = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			encoding: "utf-8", cwd, timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		process.exit(0); // not a git repo
	}
	if (!hasSourceChanges(dirty)) process.exit(0);

	// Run configured types/lint checks, without GSD heuristics or a full test
	// suite on every turn-end. The gate retains its project strictness policy.
	const gate = path.join(__dirname, "gsd-quality-gate.cjs");
	let result;
	try {
		result = spawnSync(process.execPath, [gate, "--no-tests", "--checks-only"], { encoding: "utf-8", cwd, timeout: 170000 });
	} catch (error) {
		failGate({ error });
	}
	if (result.error || result.signal || result.status !== 0) failGate(result);
	process.exit(0);
} catch (error) {
	console.error(`Quality gate could not run: ${error.message}`);
	process.exit(2);
}
