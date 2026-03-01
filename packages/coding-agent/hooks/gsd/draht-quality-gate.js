#!/usr/bin/env node
"use strict";

/**
 * Draht Quality Gate Hook
 * Runs after task completion to enforce quality standards.
 * Called by the build agent after each verify step.
 *
 * Usage: node gsd-quality-gate.js [--strict]
 * Exit 0 = quality OK, Exit 1 = quality issues
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");

const strict = process.argv.includes("--strict");
const issues = [];

// 1. TypeScript check
try {
	execSync("bun run tsgo --noEmit 2>&1", { timeout: 60000, encoding: "utf-8" });
} catch (error) {
	const output = error.stdout || error.stderr || "";
	const errorCount = (output.match(/error TS/g) || []).length;
	if (errorCount > 0) {
		issues.push({ severity: strict ? "error" : "warning", message: `${errorCount} TypeScript error(s)`, details: output.slice(0, 500) });
	}
}

// 2. Biome lint check (if biome.json exists)
if (fs.existsSync("biome.json")) {
	try {
		execSync("bunx biome check --error-on-warnings . 2>&1", { timeout: 30000, encoding: "utf-8" });
	} catch (error) {
		const output = error.stdout || error.stderr || "";
		issues.push({ severity: strict ? "error" : "warning", message: "Biome lint issues", details: output.slice(0, 500) });
	}
}

// 3. Run tests
try {
	const testOutput = execSync("bun test 2>&1", { timeout: 120000, encoding: "utf-8" });
	const failMatch = testOutput.match(/(\d+) fail/);
	if (failMatch && parseInt(failMatch[1], 10) > 0) {
		issues.push({ severity: strict ? "error" : "warning", message: `${failMatch[1]} test(s) failing` });
	}
} catch (error) {
	const output = error.stdout || error.stderr || "";
	const failMatch = output.match(/(\d+) fail/);
	if (failMatch && parseInt(failMatch[1], 10) > 0) {
		issues.push({ severity: strict ? "error" : "warning", message: `${failMatch[1]} test(s) failing` });
	}
}

// 4. Check for console.log in source files (not tests)
try {
	const result = execSync(
		"grep -rn 'console\\.log' src/ --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v '// debug' | head -5",
		{ encoding: "utf-8" }
	).trim();
	if (result) {
		issues.push({ severity: "warning", message: `console.log found in source`, details: result });
	}
} catch { /* grep returns 1 when no match — that's good */ }

// 5. Check for TODO/FIXME/HACK comments in changed files
try {
	const diff = execSync("git diff --cached --name-only 2>/dev/null || git diff --name-only HEAD~1", { encoding: "utf-8" }).trim();
	if (diff) {
		const files = diff.split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
		for (const file of files) {
			try {
				const content = fs.readFileSync(file, "utf-8");
				const todos = content.match(/\/\/\s*(TODO|FIXME|HACK|XXX):/gi) || [];
				if (todos.length > 0) {
					issues.push({ severity: "info", message: `${file}: ${todos.length} TODO/FIXME comment(s)` });
				}
			} catch { /* file may not exist */ }
		}
	}
} catch { /* ignore */ }

// Output
const errors = issues.filter((i) => i.severity === "error");
const warnings = issues.filter((i) => i.severity === "warning");
const infos = issues.filter((i) => i.severity === "info");

if (errors.length > 0) {
	console.log(`\n❌ Quality Gate FAILED (${errors.length} error(s)):`);
	for (const e of errors) {
		console.log(`  ❌ ${e.message}`);
		if (e.details) console.log(`     ${e.details.split("\n")[0]}`);
	}
}

if (warnings.length > 0) {
	console.log(`\n⚠️  ${warnings.length} warning(s):`);
	for (const w of warnings) {
		console.log(`  ⚠️  ${w.message}`);
	}
}

if (infos.length > 0) {
	console.log(`\nℹ️  ${infos.length} note(s):`);
	for (const i of infos) console.log(`  ℹ️  ${i.message}`);
}

if (errors.length === 0 && warnings.length === 0) {
	console.log("✅ Quality gate passed");
}

process.exit(errors.length > 0 ? 1 : 0);
