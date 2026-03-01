#!/usr/bin/env node
"use strict";

/**
 * Draht Pre-Execute Hook
 * Runs before gsd-execute-phase to validate preconditions.
 *
 * Usage: node gsd-pre-execute.js <phase-number>
 * Exit 0 = proceed, Exit 1 = abort
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const phaseNum = process.argv[2];
if (!phaseNum) {
	console.error("Usage: gsd-pre-execute.js <phase-number>");
	process.exit(1);
}

const PLANNING = ".planning";
const errors = [];
const warnings = [];

// 1. Check .planning/ exists
if (!fs.existsSync(PLANNING)) {
	errors.push("No .planning/ directory found. Run gsd-new-project first.");
}

// 2. Check STATE.md exists
if (!fs.existsSync(path.join(PLANNING, "STATE.md"))) {
	errors.push("No STATE.md found. Project not initialized.");
}

// 3. Check ROADMAP.md exists and phase is defined
const roadmapPath = path.join(PLANNING, "ROADMAP.md");
if (fs.existsSync(roadmapPath)) {
	const roadmap = fs.readFileSync(roadmapPath, "utf-8");
	if (!roadmap.includes(`Phase ${phaseNum}`)) {
		errors.push(`Phase ${phaseNum} not found in ROADMAP.md`);
	}
} else {
	errors.push("No ROADMAP.md found.");
}

// 4. Check phase directory exists with plans
const phasesDir = path.join(PLANNING, "phases");
if (fs.existsSync(phasesDir)) {
	const entries = fs.readdirSync(phasesDir);
	const phaseDir = entries.find((e) => e.startsWith(String(phaseNum).padStart(2, "0") + "-"));
	if (!phaseDir) {
		errors.push(`No phase directory found for phase ${phaseNum}. Run gsd-plan-phase first.`);
	} else {
		const phaseFiles = fs.readdirSync(path.join(phasesDir, phaseDir));
		const plans = phaseFiles.filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
		if (plans.length === 0) {
			errors.push(`No plans found in phase ${phaseNum}. Run gsd-plan-phase first.`);
		}

		// Check plans have required elements
		for (const planFile of plans) {
			const content = fs.readFileSync(path.join(phasesDir, phaseDir, planFile), "utf-8");
			if (!content.includes("<task")) {
				warnings.push(`${planFile}: No <task> elements — plan may be incomplete`);
			}
			if (!content.includes("<verify>")) {
				warnings.push(`${planFile}: Missing <verify> steps — tasks won't be verifiable`);
			}
		}
	}
}

// 5. Check git status
try {
	const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
	if (status) {
		const lines = status.split("\n").length;
		warnings.push(`${lines} uncommitted file(s) — consider committing first`);
	}
} catch {
	warnings.push("Not a git repository — no commit tracking");
}

// 6. Check for CONTINUE-HERE.md (unfinished session)
if (fs.existsSync(path.join(PLANNING, "CONTINUE-HERE.md"))) {
	warnings.push("CONTINUE-HERE.md exists — previous session may be unfinished. Consider gsd-resume-work.");
}

// Output
if (warnings.length > 0) {
	console.log(`⚠️  ${warnings.length} warning(s):`);
	for (const w of warnings) console.log(`  - ${w}`);
}

if (errors.length > 0) {
	console.log(`\n❌ ${errors.length} error(s) — cannot proceed:`);
	for (const e of errors) console.log(`  - ${e}`);
	process.exit(1);
}

console.log(`✅ Pre-execute checks passed for phase ${phaseNum}`);
process.exit(0);
