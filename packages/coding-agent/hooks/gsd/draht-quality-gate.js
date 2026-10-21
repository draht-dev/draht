#!/usr/bin/env node
"use strict";

/**
 * Draht Quality Gate Hook
 * Runs after task completion to enforce quality standards.
 * Called by the build agent after each verify step.
 *
 * Usage: node gsd-quality-gate.js [--strict] [--no-tests]
 * --no-tests skips the test-suite run.
 * --checks-only runs configured type, lint, and test checks without workflow heuristics.
 * Exit 0 = quality OK, Exit 1 = quality issues
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { runChecks } = require("../checks/checks-runtime.cjs");

// ── Toolchain detection — mirrors src/gsd/hook-utils.ts ──────────────────────
function detectToolchain(cwd) {
	if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) {
		return { pm: "bun", testCmd: "bun test", coverageCmd: "bun test --coverage", lintCmd: "bunx biome check ." };
	}
	if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
		return { pm: "pnpm", testCmd: "pnpm test", coverageCmd: "pnpm run test:coverage", lintCmd: "pnpm run lint" };
	}
	if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
		return { pm: "yarn", testCmd: "yarn test", coverageCmd: "yarn run test:coverage", lintCmd: "yarn run lint" };
	}
	return { pm: "npm", testCmd: "npm test", coverageCmd: "npm run test:coverage", lintCmd: "npm run lint" };
}

function readHookConfig(cwd) {
	const defaults = { coverageThreshold: 80, tddMode: "advisory", qualityGateStrict: true };
	const configPath = path.join(cwd, ".planning", "config.json");
	if (!fs.existsSync(configPath)) return defaults;
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		const h = raw.hooks || {};
		return {
			coverageThreshold: typeof h.coverageThreshold === "number" ? h.coverageThreshold : defaults.coverageThreshold,
			tddMode: h.tddMode === "strict" || h.tddMode === "advisory" ? h.tddMode : defaults.tddMode,
			qualityGateStrict: typeof h.qualityGateStrict === "boolean" ? h.qualityGateStrict : defaults.qualityGateStrict,
		};
	} catch { return defaults; }
}

// Inline domain validator — mirrors src/gsd/domain-validator.ts
function extractGlossaryTerms(content) {
	const terms = new Set();
	const sectionMatch = content.match(/## Ubiquitous Language([\s\S]*?)(?:\n## |$)/);
	const section = sectionMatch ? sectionMatch[1] : content;
	for (const m of section.matchAll(/\*\*([A-Z][a-zA-Z0-9]+)\*\*/g)) terms.add(m[1]);
	for (const m of section.matchAll(/^[-*]\s+([A-Z][a-zA-Z0-9]+)\s*:/gm)) terms.add(m[1]);
	for (const m of section.matchAll(/\|\s*([A-Z][a-zA-Z0-9]+)\s*\|/g)) terms.add(m[1]);
	return terms;
}

function loadDomainContent(cwd) {
	const modelPath = path.join(cwd, ".planning", "DOMAIN-MODEL.md");
	if (fs.existsSync(modelPath)) return fs.readFileSync(modelPath, "utf-8");
	const domainPath = path.join(cwd, ".planning", "DOMAIN.md");
	if (fs.existsSync(domainPath)) return fs.readFileSync(domainPath, "utf-8");
	return "";
}

// Match the compiler's upward search without invoking a missing tool in non-TS projects.
function hasTypeScriptConfig(cwd) {
	let directory = cwd;
	while (true) {
		if (fs.existsSync(path.join(directory, "tsconfig.json"))) return true;
		const parent = path.dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

function lintCommand(cwd, pm) {
	let directory = cwd;
	let biome = false;
	while (true) {
		biome ||= ["biome.json", "biome.jsonc"].some((file) => fs.existsSync(path.join(directory, file)));
		const packagePath = path.join(directory, "package.json");
		if (fs.existsSync(packagePath)) {
			const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
			if (typeof pkg.scripts?.lint === "string" && pkg.scripts.lint.trim()) return `${pm} run lint`;
			break;
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return biome ? `${pm === "bun" ? "bunx" : "npx --no-install"} biome check . --error-on-warnings` : null;
}

function hasTestCommand(cwd, pm) {
	if (pm === "bun") return true;
	let directory = cwd;
	while (true) {
		const packagePath = path.join(directory, "package.json");
		if (fs.existsSync(packagePath)) {
			const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
			return typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim().length > 0;
		}
		const parent = path.dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}

function commandFailureReason(error) {
	if (error.code === "ETIMEDOUT") return "timed out";
	if (error.signal) return `signal ${error.signal}`;
	if (typeof error.status === "number") return `exit ${error.status}`;
	return error.code || error.message || "unknown process error";
}

function commandFailureOutput(error) {
	return [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
const cwd = process.cwd();
const projectChecks = runChecks({ cwd, force: process.argv.includes("--force") });
if (projectChecks.configured || projectChecks.status === "failed") {
	console.log(projectChecks.summary);
	for (const check of projectChecks.checks) if (check.output) console.log(`${check.name}: ${check.output}`);
}
const toolchain = detectToolchain(cwd);
const hookConfig = readHookConfig(cwd);
const strict = process.argv.includes("--strict") || hookConfig.qualityGateStrict;
const skipTests = process.argv.includes("--no-tests");
const checksOnly = process.argv.includes("--checks-only");
const issues = projectChecks.status === "failed" ? [{ severity: "error", message: projectChecks.summary }] : [];

if (!projectChecks.configured) {
// 1. TypeScript check
if (hasTypeScriptConfig(cwd)) {
	try {
		const tsCmd = toolchain.pm === "bun" ? "bun run tsc --noEmit 2>&1" : "npx tsc --noEmit 2>&1";
		execSync(tsCmd, { timeout: 60000, encoding: "utf-8", cwd });
	} catch (error) {
		const output = commandFailureOutput(error);
		const errorLines = output.split("\n").filter((line) => /error TS/.test(line));
		issues.push({
			severity: strict ? "error" : "warning",
			message: errorLines.length > 0
				? `${errorLines.length} TypeScript error(s)`
				: `TypeScript command failed (${commandFailureReason(error)})`,
			details: (errorLines.length > 0 ? errorLines.join("\n") : output).slice(0, 500),
		});
	}
} else {
	console.log("TypeScript check skipped: no tsconfig.json");
}

// 2. Respect the package's lint command; use Biome directly only when configured.
try {
	const lint = lintCommand(cwd, toolchain.pm);
	if (lint) execSync(`${lint} 2>&1`, { timeout: 30000, encoding: "utf-8", cwd });
	else console.log("Lint check skipped: no applicable lint script or Biome configuration");
} catch (error) {
	const output = commandFailureOutput(error);
	issues.push({ severity: strict ? "error" : "warning", message: "Lint issues", details: output.slice(0, 500) });
}

// 3. Run tests. Nonzero exits always fail; reporter text adds detail.
if (!skipTests) {
	try {
		if (hasTestCommand(cwd, toolchain.pm)) {
			const testOutput = execSync(`${toolchain.testCmd} 2>&1`, { timeout: 120000, encoding: "utf-8", cwd });
			const failMatch = testOutput.match(/(\d+) fail/);
			if (failMatch && parseInt(failMatch[1], 10) > 0) {
				issues.push({ severity: strict ? "error" : "warning", message: `${failMatch[1]} test(s) failing` });
			}
		} else {
			console.log("Tests skipped: no package test script");
		}
	} catch (error) {
		const output = commandFailureOutput(error);
		const failMatch = output.match(/(\d+) fail/);
		issues.push({
			severity: strict ? "error" : "warning",
			message: failMatch && parseInt(failMatch[1], 10) > 0
				? `${failMatch[1]} test(s) failing`
				: `Test command failed (${commandFailureReason(error)})`,
			details: output.slice(0, 500),
		});
	}
}

}

if (!checksOnly) {
	// 4. Check for console.log in source files (not tests)
	try {
		const result = execSync(
			"grep -rn 'console\\.log' src/ --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v '// debug' | head -5",
			{ encoding: "utf-8", cwd }
		).trim();
		if (result) {
			issues.push({ severity: "warning", message: "console.log found in source", details: result });
		}
	} catch { /* grep returns 1 when no match — that's fine */ }

	// 5. Domain glossary compliance (checks DOMAIN-MODEL.md, falls back to DOMAIN.md)
	const domainContent = loadDomainContent(cwd);
	if (domainContent) {
		try {
			const glossaryTerms = extractGlossaryTerms(domainContent);
			const changedFiles = execSync(
				"git diff --cached --name-only 2>/dev/null || git diff --name-only HEAD~1",
				{ encoding: "utf-8", cwd }
			).trim().split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

			const unknownTerms = [];
			for (const file of changedFiles) {
				if (!fs.existsSync(path.join(cwd, file))) continue;
				const src = fs.readFileSync(path.join(cwd, file), "utf-8");
				const declarations = [...src.matchAll(/(?:class|interface|type|enum)\s+([A-Z][a-zA-Z0-9]+)/g)].map((m) => m[1]);
				for (const term of declarations) {
					if (!glossaryTerms.has(term)) unknownTerms.push(`${file}: ${term}`);
				}
			}
			if (unknownTerms.length > 0) {
				issues.push({
					severity: hookConfig.tddMode === "strict" ? "error" : "warning",
					message: `${unknownTerms.length} PascalCase type(s) not in domain glossary (DOMAIN-MODEL.md)`,
					details: unknownTerms.slice(0, 5).join(", "),
				});
			}
		} catch { /* ignore */ }
	}

	// 6. Bounded context boundary check — flag suspicious cross-directory imports
	try {
		const changedSrcFiles = execSync(
			"git diff --cached --name-only 2>/dev/null || git diff --name-only HEAD~1",
			{ encoding: "utf-8", cwd }
		).trim().split("\n").filter((f) => /^src\/[^/]+\//.test(f) && (f.endsWith(".ts") || f.endsWith(".tsx")));

		const crossContextImports = [];
		for (const file of changedSrcFiles) {
			if (!fs.existsSync(path.join(cwd, file))) continue;
			const ownContext = file.split("/")[1];
			const src = fs.readFileSync(path.join(cwd, file), "utf-8");
			const imports = [...src.matchAll(/from\s+['"](\.\.\/.+?)['"]/g)].map((m) => m[1]);
			for (const imp of imports) {
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
			{ encoding: "utf-8", cwd }
		).trim();
		const allTests = execSync(
			"find src -name '*.test.ts' -o -name '*.spec.ts' 2>/dev/null | wc -l",
			{ encoding: "utf-8", cwd }
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
		const diff = execSync(
			"git diff --cached --name-only 2>/dev/null || git diff --name-only HEAD~1",
			{ encoding: "utf-8", cwd }
		).trim();
		if (diff) {
			const files = diff.split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
			for (const file of files) {
				try {
					const content = fs.readFileSync(path.join(cwd, file), "utf-8");
					const todos = content.match(/\/\/\s*(TODO|FIXME|HACK|XXX):/gi) || [];
					if (todos.length > 0) {
						issues.push({ severity: "info", message: `${file}: ${todos.length} TODO/FIXME comment(s)` });
					}
				} catch { /* file may not exist */ }
			}
		}
	} catch { /* ignore */ }
}

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
