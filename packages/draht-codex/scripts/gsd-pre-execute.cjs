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

// 7. Check DOMAIN.md exists and has required sections
const domainPath = path.join(PLANNING, "DOMAIN.md");
if (!fs.existsSync(domainPath)) {
	warnings.push("No .planning/DOMAIN.md found — domain model not documented. Run /new-project or /map-codebase to create it.");
} else {
	const domainContent = fs.readFileSync(domainPath, "utf-8");
	if (!domainContent.includes("## Bounded Contexts")) {
		errors.push("DOMAIN.md is missing '## Bounded Contexts' section.");
	}
	if (!domainContent.includes("## Ubiquitous Language")) {
		errors.push("DOMAIN.md is missing '## Ubiquitous Language' section.");
	}
}

// 8. Check TEST-STRATEGY.md exists
if (!fs.existsSync(path.join(PLANNING, "TEST-STRATEGY.md"))) {
	warnings.push("No .planning/TEST-STRATEGY.md found — test strategy not documented. Run /new-project or /map-codebase to create it.");
}

// 9. Check all plans have non-empty <test> sections
if (fs.existsSync(phasesDir)) {
	const entries2 = fs.readdirSync(phasesDir);
	const phaseDir2 = entries2.find((e) => e.startsWith(String(phaseNum).padStart(2, "0") + "-"));
	if (phaseDir2) {
		const phaseFiles2 = fs.readdirSync(path.join(phasesDir, phaseDir2));
		const plans2 = phaseFiles2.filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
		for (const planFile of plans2) {
			const content = fs.readFileSync(path.join(phasesDir, phaseDir2, planFile), "utf-8");
			// Extract all <test>...</test> blocks and check they are non-empty
			const testMatches = [...content.matchAll(/<test>([\s\S]*?)<\/test>/g)];
			if (testMatches.length === 0) {
				errors.push(`${planFile}: Missing <test> sections — TDD requires tests for every task`);
			} else {
				for (const m of testMatches) {
					if (!m[1].trim()) {
						errors.push(`${planFile}: Empty <test> section found — fill in test cases before executing`);
					}
				}
			}
		}
	}
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
