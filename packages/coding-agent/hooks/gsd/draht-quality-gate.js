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

// 5. Domain glossary compliance
// Extract terms from DOMAIN.md and flag new PascalCase classes not in the glossary
const domainMdPath = ".planning/DOMAIN.md";
if (fs.existsSync(domainMdPath)) {
	try {
		const domainContent = fs.readFileSync(domainMdPath, "utf-8");
		// Collect all PascalCase tokens that appear in the glossary section
		const glossarySection = domainContent.match(/## Ubiquitous Language([\s\S]*?)(?:^##|\Z)/m)?.[1] || "";
		// Each glossary entry is assumed to start the line with a PascalCase term (e.g. "**Order**" or "- Order:")
		const glossaryTerms = new Set(
			[...glossarySection.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)].map((m) => m[1])
		);

		// Scan changed source files for PascalCase class/interface/type declarations
		try {
			const changedFiles = execSync(
				"git diff --cached --name-only 2>/dev/null || git diff --name-only HEAD~1",
				{ encoding: "utf-8" }
			).trim().split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

			const unknownTerms = [];
			for (const file of changedFiles) {
				if (!fs.existsSync(file)) continue;
				const src = fs.readFileSync(file, "utf-8");
				const declarations = [...src.matchAll(/(?:class|interface|type|enum)\s+([A-Z][a-zA-Z0-9]+)/g)].map((m) => m[1]);
				for (const term of declarations) {
					if (!glossaryTerms.has(term)) {
						unknownTerms.push(`${file}: ${term}`);
					}
				}
			}
			if (unknownTerms.length > 0) {
				issues.push({
					severity: "warning",
					message: `${unknownTerms.length} PascalCase type(s) not in DOMAIN.md glossary`,
					details: unknownTerms.slice(0, 5).join(", "),
				});
			}
		} catch { /* ignore git errors */ }
	} catch { /* ignore read errors */ }
}

// 6. Bounded context boundary check — flag suspicious cross-directory imports
try {
	const changedSrcFiles = execSync(
		"git diff --cached --name-only 2>/dev/null || git diff --name-only HEAD~1",
		{ encoding: "utf-8" }
	).trim().split("\n").filter((f) => /^src\/[^/]+\//.test(f) && (f.endsWith(".ts") || f.endsWith(".tsx")));

	const crossContextImports = [];
	for (const file of changedSrcFiles) {
		if (!fs.existsSync(file)) continue;
		// Determine this file's context (first path segment under src/)
		const ownContext = file.split("/")[1];
		const src = fs.readFileSync(file, "utf-8");
		const imports = [...src.matchAll(/from\s+['"](\.\.\/.+?)['"]/g)].map((m) => m[1]);
		for (const imp of imports) {
			// Resolve relative import against the file's directory
			const resolved = path.normalize(path.join(path.dirname(file), imp));
			const parts = resolved.split(path.sep);
			const srcIdx = parts.indexOf("src");
			if (srcIdx !== -1 && parts[srcIdx + 1] && parts[srcIdx + 1] !== ownContext) {
				crossContextImports.push(`${file} → ${parts.slice(srcIdx).join("/")}`);
			}
		}
	}
	if (crossContextImports.length > 0) {
		issues.push({
			severity: "warning",
			message: `${crossContextImports.length} suspicious cross-context import(s) detected`,
			details: crossContextImports.slice(0, 3).join("; "),
		});
	}
} catch { /* ignore */ }

// 7. TDD health — check test-to-source file ratio
try {
	const allSrc = execSync(
		"find src -name '*.ts' -not -name '*.test.ts' -not -name '*.spec.ts' 2>/dev/null | wc -l",
		{ encoding: "utf-8" }
	).trim();
	const allTests = execSync(
		"find src -name '*.test.ts' -o -name '*.spec.ts' 2>/dev/null | wc -l",
		{ encoding: "utf-8" }
	).trim();
	const srcCount = parseInt(allSrc, 10) || 0;
	const testCount = parseInt(allTests, 10) || 0;
	if (srcCount > 0) {
		const ratio = testCount / srcCount;
		if (ratio < 0.3) {
			issues.push({
				severity: "warning",
				message: `TDD health: test-to-source ratio is ${(ratio * 100).toFixed(0)}% (${testCount} tests / ${srcCount} sources) — target ≥ 30%`,
			});
		}
	}
} catch { /* ignore — src/ may not exist */ }

// 8. Check for TODO/FIXME/HACK comments in changed files
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
