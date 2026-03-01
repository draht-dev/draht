#!/usr/bin/env node
"use strict";

/**
 * Draht Post-Task Hook
 * Runs after each task execution to validate and record results.
 *
 * Usage: node gsd-post-task.js <phase> <plan> <task-num> <status> [commit-hash]
 * Status: pass | fail | skip
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const [phaseNum, planNum, taskNum, status, commitHash] = process.argv.slice(2);
if (!phaseNum || !planNum || !taskNum || !status) {
	console.error("Usage: gsd-post-task.js <phase> <plan> <task-num> <status> [commit-hash]");
	process.exit(1);
}

const PLANNING = ".planning";
const LOG_FILE = path.join(PLANNING, "execution-log.jsonl");

// 0. TDD cycle compliance check
// If the current commit message starts with "green:", the previous commit for this
// task should start with "red:" — enforce the Red → Green order.
if (commitHash) {
	try {
		// Find the commit message for commitHash and the one before it
		const currentMsg = execSync(`git log --format=%s -n 1 ${commitHash} 2>/dev/null`, { encoding: "utf-8" }).trim();
		if (/^green:/i.test(currentMsg)) {
			// Scope search to commits that mention this phase/plan/task in their message
			// to avoid false positives from unrelated older commits
			const taskPrefix = `${phaseNum}-${planNum}-${taskNum}`;
			const recentMsgs = execSync(`git log --format=%s -n 50 ${commitHash}~1 2>/dev/null`, { encoding: "utf-8" })
				.trim()
				.split("\n")
				.filter((m) => m.includes(taskPrefix) || /^(red|green|refactor):/i.test(m));
			// Find the nearest TDD-cycle commit scoped to this task
			const prevTaskMsg = recentMsgs.find((m) => /^(red|green|refactor):/i.test(m) && m.includes(taskPrefix));
			if (!prevTaskMsg || !/^red:/i.test(prevTaskMsg)) {
				console.log(`⚠️  TDD violation: "green:" commit detected but no preceding "red:" commit found for task ${phaseNum}-${planNum}-${taskNum}`);
				fs.appendFileSync(LOG_FILE, JSON.stringify({
					timestamp: new Date().toISOString(),
					phase: parseInt(phaseNum, 10),
					plan: parseInt(planNum, 10),
					task: parseInt(taskNum, 10),
					status: "tdd-violation",
					warning: "green: commit without preceding red: commit",
					commit: commitHash,
				}) + "\n");
			}
		}
	} catch {
		// Not a git repo or commit not found — ignore
	}
}

// 1. Append to execution log
const entry = {
	timestamp: new Date().toISOString(),
	phase: parseInt(phaseNum, 10),
	plan: parseInt(planNum, 10),
	task: parseInt(taskNum, 10),
	status,
	commit: commitHash || null,
};

fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");

// 2. Run type check if status is pass
if (status === "pass") {
	try {
		execSync("bun run tsgo --noEmit 2>&1", { timeout: 30000, encoding: "utf-8" });
		// Run tests
		try {
			const testOutput = execSync("bun test 2>&1", { timeout: 60000, encoding: "utf-8" });
			const testMatch = testOutput.match(/(\d+) pass/);
			const testCount = testMatch ? testMatch[1] : "?";
			console.log(`✅ Task ${phaseNum}-${planNum}-${taskNum}: passed + types clean + ${testCount} tests pass`);
		} catch (testErr) {
			const testOut = testErr.stdout || testErr.stderr || "";
			const failMatch = testOut.match(/(\d+) fail/);
			if (failMatch) {
				console.log(`⚠️  Task ${phaseNum}-${planNum}-${taskNum}: passed + types clean but ${failMatch[1]} test(s) failed`);
			} else {
				console.log(`✅ Task ${phaseNum}-${planNum}-${taskNum}: passed + types clean (no test runner found)`);
			}
		}
	} catch (error) {
		const output = error.stdout || "";
		const errorCount = (output.match(/error TS/g) || []).length;
		if (errorCount > 0) {
			console.log(`⚠️  Task ${phaseNum}-${planNum}-${taskNum}: passed but ${errorCount} type error(s) introduced`);
			// Append warning to log
			fs.appendFileSync(LOG_FILE, JSON.stringify({
				...entry,
				warning: `${errorCount} type errors introduced`,
			}) + "\n");
		} else {
			console.log(`✅ Task ${phaseNum}-${planNum}-${taskNum}: passed`);
		}
	}
} else if (status === "fail") {
	console.log(`❌ Task ${phaseNum}-${planNum}-${taskNum}: FAILED`);

	// Check if we should create a fix plan
	const logContent = fs.readFileSync(LOG_FILE, "utf-8");
	const taskFailures = logContent.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.phase === parseInt(phaseNum, 10) && e.plan === parseInt(planNum, 10) && e.task === parseInt(taskNum, 10) && e.status === "fail");

	if (taskFailures.length >= 3) {
		console.log(`\n⚠️  Task has failed 3+ times. Consider creating a fix plan:`);
		console.log(`   draht create-fix-plan ${phaseNum} ${planNum} "Task ${taskNum} failed repeatedly"`);
	}
} else {
	console.log(`⏭️  Task ${phaseNum}-${planNum}-${taskNum}: skipped`);
}

// 3. Update STATE.md last activity
const statePath = path.join(PLANNING, "STATE.md");
if (fs.existsSync(statePath)) {
	let state = fs.readFileSync(statePath, "utf-8");
	state = state.replace(
		/## Last Activity:.*/,
		`## Last Activity: ${new Date().toISOString().replace("T", " ").slice(0, 19)}`
	);
	fs.writeFileSync(statePath, state);
}
