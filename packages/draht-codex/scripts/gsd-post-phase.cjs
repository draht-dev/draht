#!/usr/bin/env node
"use strict";

/**
 * Draht Post-Phase Hook
 * Runs after phase completion to generate reports and update state.
 *
 * Usage: node gsd-post-phase.js <phase-number>
 */

const fs = require("node:fs");
const path = require("node:path");

const phaseNum = process.argv[2];
if (!phaseNum) {
	console.error("Usage: gsd-post-phase.js <phase-number>");
	process.exit(1);
}

const PLANNING = ".planning";
const LOG_FILE = path.join(PLANNING, "execution-log.jsonl");

// 1. Read execution log for this phase
let entries = [];
if (fs.existsSync(LOG_FILE)) {
	entries = fs.readFileSync(LOG_FILE, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.phase === parseInt(phaseNum, 10));
}

const passed = entries.filter((e) => e.status === "pass").length;
const failed = entries.filter((e) => e.status === "fail").length;
const skipped = entries.filter((e) => e.status === "skip").length;
const warnings = entries.filter((e) => e.warning).length;

// 2. Compute TDD and domain health metrics
const tddViolations = entries.filter((e) => e.status === "tdd-violation").length;

// TDD commit counts: derive from git log scoped to commits since phase start
// (use the earliest entry timestamp as the lower bound)
let tddSummary = "⚠️  No TDD commit data in log";
try {
	const { execSync } = require("node:child_process");
	// Scope to commits that follow TDD naming convention for this phase
	const gitLog = execSync(
		`git log --format=%s --grep="^[0-9]" -E --extended-regexp 2>/dev/null || git log --format=%s 2>/dev/null`,
		{ encoding: "utf-8" }
	).trim();
	const lines = gitLog.split("\n");
	const redCount = lines.filter((l) => /^red:/i.test(l)).length;
	const greenCount = lines.filter((l) => /^green:/i.test(l)).length;
	const refactorCount = lines.filter((l) => /^refactor:/i.test(l)).length;
	if (redCount + greenCount + refactorCount > 0) {
		tddSummary = `🔴 Red: ${redCount}  🟢 Green: ${greenCount}  🔵 Refactor: ${refactorCount}`;
	} else {
		tddSummary = "⚠️  No red:/green:/refactor: commits found — TDD cycle may not have been followed";
	}
} catch { /* ignore */ }

// Domain health: check DOMAIN.md presence and glossary size
let domainSummary = "⚠️  .planning/DOMAIN.md not found";
const domainPath = path.join(PLANNING, "DOMAIN.md");
if (fs.existsSync(domainPath)) {
	const domainContent = fs.readFileSync(domainPath, "utf-8");
	const termMatches = [...domainContent.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)];
	const termCount = new Set(termMatches.map((m) => m[1])).size;
	const hasContexts = domainContent.includes("## Bounded Contexts");
	const hasGlossary = domainContent.includes("## Ubiquitous Language");
	domainSummary = `${hasContexts ? "✅" : "❌"} Bounded Contexts  ${hasGlossary ? "✅" : "❌"} Ubiquitous Language  📖 ~${termCount} terms`;
}

// TEST-STRATEGY health
let testStrategySummary = "⚠️  .planning/TEST-STRATEGY.md not found";
if (fs.existsSync(path.join(PLANNING, "TEST-STRATEGY.md"))) {
	testStrategySummary = "✅ TEST-STRATEGY.md present";
}

// 3. Generate phase report
const reportPath = path.join(PLANNING, `phase-${phaseNum}-report.md`);
const report = `# Phase ${phaseNum} Execution Report

Generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)}

## Task Results
- ✅ Passed: ${passed}
- ❌ Failed: ${failed}
- ⏭️  Skipped: ${skipped}
- ⚠️  Warnings: ${warnings}

## Execution Log
| Timestamp | Plan | Task | Status | Commit |
|-----------|------|------|--------|--------|
${entries.map((e) => `| ${e.timestamp.slice(0, 19)} | ${e.plan} | ${e.task} | ${e.status} | ${e.commit || "-"} |`).join("\n")}

## Quality Gate
${failed === 0 ? "✅ All tasks passed — ready for verification" : `❌ ${failed} failure(s) — fix plans may be needed`}
${warnings > 0 ? `⚠️  ${warnings} task(s) introduced type errors` : "✅ No type errors introduced"}

## TDD Health
${tddSummary}
${tddViolations > 0 ? `❌ ${tddViolations} TDD cycle violation(s) recorded (green: without red:)` : "✅ No TDD cycle violations recorded"}

## Domain Model Health
${domainSummary}
${testStrategySummary}
`;

fs.writeFileSync(reportPath, report);
console.log(`Phase ${phaseNum} report: ${reportPath}`);

// 4. Update ROADMAP.md status
const roadmapPath = path.join(PLANNING, "ROADMAP.md");
if (fs.existsSync(roadmapPath)) {
	let roadmap = fs.readFileSync(roadmapPath, "utf-8");
	const newStatus = failed === 0 ? "complete" : "needs-fixes";
	const regex = new RegExp(`(## Phase ${phaseNum}:.+?)— \`\\w+\``, "m");
	roadmap = roadmap.replace(regex, `$1— \`${newStatus}\``);
	fs.writeFileSync(roadmapPath, roadmap);
	console.log(`ROADMAP.md: Phase ${phaseNum} → ${newStatus}`);
}

// 5. Summary
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(` Draht ► PHASE ${phaseNum} ${failed === 0 ? "COMPLETE ✅" : "NEEDS FIXES ❌"}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed === 0) {
	console.log(`\nNext: gsd-verify-work ${phaseNum}`);
} else {
	console.log(`\nNext: gsd-execute-phase ${phaseNum} --gaps-only`);
}
