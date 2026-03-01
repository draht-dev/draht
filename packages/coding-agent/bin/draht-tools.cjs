#!/usr/bin/env node
"use strict";

/**
 * Draht Tools — CLI for the Get Shit Done methodology.
 * Manages .planning/ directory structure, state tracking, and git integration.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const PLANNING_DIR = ".planning";
const BANNER_WIDTH = 55;

// ============================================================================
// Helpers
// ============================================================================

function banner(stage) {
	const line = "━".repeat(BANNER_WIDTH);
	return `${line}\n DRAHT ► ${stage}\n${line}`;
}

function planningPath(...segments) {
	return path.join(process.cwd(), PLANNING_DIR, ...segments);
}

function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function readMd(filePath) {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function writeMd(filePath, content) {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, content, "utf-8");
}

function writeJson(filePath, data) {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function timestamp() {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function dateStamp() {
	return new Date().toISOString().slice(0, 10);
}

function slugify(text, maxLen = 40) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, maxLen);
}

function padNum(n, digits = 2) {
	return String(n).padStart(digits, "0");
}

function hasGit() {
	try {
		execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function gitCommit(message) {
	if (!hasGit()) return null;
	try {
		execSync(`git add ${PLANNING_DIR}/`, { stdio: "ignore" });
		execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: "ignore" });
		const hash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
		return hash;
	} catch {
		return null;
	}
}

function gitCommitAll(message) {
	if (!hasGit()) return null;
	try {
		execSync("git add -A", { stdio: "ignore" });
		execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: "ignore" });
		const hash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
		return hash;
	} catch {
		return null;
	}
}

function getPhaseDir(phaseNum) {
	const dir = planningPath("phases");
	if (!fs.existsSync(dir)) return null;
	const entries = fs.readdirSync(dir);
	const match = entries.find((e) => e.startsWith(padNum(phaseNum) + "-"));
	return match ? path.join(dir, match) : null;
}

function getPhaseSlug(phaseNum) {
	const dir = getPhaseDir(phaseNum);
	if (!dir) return null;
	return path.basename(dir).replace(/^\d+-/, "");
}

function parsePhaseFromRoadmap(roadmapContent, phaseNum) {
	const regex = new RegExp(
		`## Phase ${phaseNum}:\\s*(.+?)\\s*—\\s*\`(\\w+)\``,
		"m"
	);
	const match = roadmapContent.match(regex);
	if (match) return { name: match[1].trim(), status: match[2] };
	// Try without status
	const regex2 = new RegExp(`## Phase ${phaseNum}:\\s*(.+?)\\n`, "m");
	const match2 = roadmapContent.match(regex2);
	if (match2) return { name: match2[1].trim(), status: "unknown" };
	return null;
}

function getState() {
	return readMd(planningPath("STATE.md"));
}

function getRoadmap() {
	return readMd(planningPath("ROADMAP.md"));
}

function getConfig() {
	return readJson(planningPath("config.json")) || {
		mode: "yolo",
		depth: "standard",
		workflow: { research: true, plan_check: true, verifier: true },
		git: { commit_docs: true },
	};
}

// ============================================================================
// Commands
// ============================================================================

const commands = {};

// --- init ---
commands.init = function () {
	const exists = fs.existsSync(planningPath("PROJECT.md"));
	if (exists) {
		console.log("Project already initialized. Use `draht progress` to see status.");
		process.exit(1);
	}
	ensureDir(planningPath());
	const hasCode =
		fs.existsSync("package.json") ||
		fs.existsSync("src") ||
		fs.existsSync("Cargo.toml") ||
		fs.existsSync("go.mod");
	console.log(banner("INIT"));
	console.log(`\nPlanning directory: ${PLANNING_DIR}/`);
	if (hasCode) {
		console.log("\n⚠️  Existing code detected. Consider running: draht map-codebase");
	}
	if (!hasGit()) {
		console.log("\n⚠️  No git repository. Consider running: git init");
	}
	console.log("\nReady for project initialization.");
};

// --- map-codebase ---
commands["map-codebase"] = function (dir) {
	const cwd = dir || process.cwd();
	const outDir = planningPath("codebase");
	ensureDir(outDir);

	console.log(banner("MAPPING CODEBASE"));

	// Gather file tree
	let tree = "";
	try {
		tree = execSync(
			`find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.planning/*' | head -200`,
			{ cwd, encoding: "utf-8" }
		);
	} catch { /* empty */ }

	// Gather package info
	let pkgJson = null;
	try {
		pkgJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
	} catch { /* empty */ }

	// Write STACK.md
	writeMd(path.join(outDir, "STACK.md"), `# Technology Stack\n\nGenerated: ${timestamp()}\n\n## File Tree (first 200 files)\n\`\`\`\n${tree}\`\`\`\n\n## Package Info\n\`\`\`json\n${pkgJson ? JSON.stringify({ name: pkgJson.name, dependencies: pkgJson.dependencies, devDependencies: pkgJson.devDependencies }, null, 2) : "No package.json found"}\n\`\`\`\n\n## TODO\n- [ ] Fill in languages, versions, frameworks\n- [ ] Document build tools and runtime\n`);

	// Write placeholder files
	writeMd(path.join(outDir, "ARCHITECTURE.md"), `# Architecture\n\nGenerated: ${timestamp()}\n\n## TODO\n- [ ] Document file/directory patterns\n- [ ] Map module boundaries\n- [ ] Describe data flow\n`);

	writeMd(path.join(outDir, "CONVENTIONS.md"), `# Conventions\n\nGenerated: ${timestamp()}\n\n## TODO\n- [ ] Document code style patterns\n- [ ] Document testing patterns\n- [ ] Document error handling approach\n`);

	writeMd(path.join(outDir, "CONCERNS.md"), `# Concerns\n\nGenerated: ${timestamp()}\n\n## TODO\n- [ ] Identify technical debt\n- [ ] Flag security concerns\n- [ ] Note missing tests\n`);

	// Domain model extraction
	let domainHints = "";
	try {
		// Extract types/interfaces as potential entities
		const types = execSync(
			`grep -rn 'export\\s\\+\\(interface\\|type\\|class\\)' --include='*.ts' --include='*.go' . 2>/dev/null | grep -v node_modules | grep -v dist | head -50`,
			{ cwd, encoding: "utf-8" }
		).trim();
		if (types) domainHints += `## Types/Interfaces (potential entities)\n\`\`\`\n${types}\n\`\`\`\n\n`;
	} catch { /* empty */ }
	try {
		// Extract directory structure as potential bounded contexts
		const dirs = execSync(
			`find . -type d -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | sort`,
			{ cwd, encoding: "utf-8" }
		).trim();
		if (dirs) domainHints += `## Directory Structure (potential bounded contexts)\n\`\`\`\n${dirs}\n\`\`\`\n`;
	} catch { /* empty */ }

	writeMd(path.join(outDir, "DOMAIN-HINTS.md"), `# Domain Model Hints\n\nGenerated: ${timestamp()}\n\nExtracted from codebase to help identify domain model.\n\n${domainHints}\n## TODO\n- [ ] Identify entities vs value objects\n- [ ] Map bounded contexts from directory structure\n- [ ] Define ubiquitous language glossary\n`);

	console.log(`\nCreated:\n  ${outDir}/STACK.md\n  ${outDir}/ARCHITECTURE.md\n  ${outDir}/CONVENTIONS.md\n  ${outDir}/CONCERNS.md\n  ${outDir}/DOMAIN-HINTS.md`);
	console.log("\n→ Review and fill in the TODOs, then run: draht commit-docs \"map existing codebase\"");
};

// --- create-project ---
commands["create-project"] = function (...args) {
	const name = args.join(" ") || "Untitled Project";
	const tmpl = `# Project: ${name}\n\n## Vision\n[Fill in]\n\n## Problem\n[What problem does this solve?]\n\n## Target User\n[Who is this for?]\n\n## Tech Stack\n[Languages, frameworks, infrastructure]\n\n## Domain Model\n\n### Bounded Contexts\n- **[Context Name]** — [responsibility]\n\n### Entities\n- **[Entity]** — [description, key attributes]\n\n### Value Objects\n- **[ValueObject]** — [description]\n\n### Aggregates\n- **[Aggregate Root]** — [entities it owns]\n\n### Ubiquitous Language\n| Term | Definition |\n|------|------------|\n| [Term] | [What it means in this domain] |\n\n## Constraints\n[Budget, timeline, platform requirements]\n\n## Success Criteria\n[How do we know this works?]\n\n---\nCreated: ${timestamp()}\n`;
	writeMd(planningPath("PROJECT.md"), tmpl);
	console.log(`Created: ${PLANNING_DIR}/PROJECT.md`);
};

// --- create-requirements ---
commands["create-requirements"] = function () {
	const tmpl = `# Requirements\n\n## v1 — Must Have\n- [ ] [Requirement 1] *(Context: [bounded context])*\n\n## v2 — Nice to Have\n- [ ] [Requirement 1] *(Context: [bounded context])*\n\n## Bounded Context Mapping\n| Requirement | Bounded Context | Aggregate |\n|-------------|----------------|----------|\n| R1 | [context] | [aggregate] |\n\n## Out of Scope\n- [Explicitly excluded]\n\n---\nCreated: ${timestamp()}\n`;
	writeMd(planningPath("REQUIREMENTS.md"), tmpl);
	console.log(`Created: ${PLANNING_DIR}/REQUIREMENTS.md`);
};

// --- create-roadmap ---
commands["create-roadmap"] = function () {
	const tmpl = `# Roadmap\n\n## Phase 1: [Name] — \`pending\`\n**Goal:** [Outcome, not activity]\n**Requirements:** [Which requirements this covers]\n**Acceptance:** [How we know it's done]\n\n---\nCreated: ${timestamp()}\n`;
	writeMd(planningPath("ROADMAP.md"), tmpl);
	console.log(`Created: ${PLANNING_DIR}/ROADMAP.md`);
};

// --- create-domain-model ---
commands["create-domain-model"] = function () {
	const project = readMd(planningPath("PROJECT.md"));
	if (!project) { console.error("No PROJECT.md found — run create-project first"); process.exit(1); }

	const tmpl = `# Domain Model\n\n## Bounded Contexts\n[Extract from PROJECT.md — identify distinct areas of responsibility]\n\n## Context Map\n[How bounded contexts interact — upstream/downstream, shared kernel, etc.]\n\n## Entities\n[Core domain objects with identity]\n\n## Value Objects\n[Immutable objects defined by attributes]\n\n## Aggregates\n[Cluster of entities with a root — transactional boundary]\n\n## Domain Events\n[Things that happen in the domain]\n\n## Ubiquitous Language Glossary\n| Term | Context | Definition |\n|------|---------|------------|\n| [term] | [context] | [definition] |\n\n---\nGenerated from PROJECT.md: ${timestamp()}\n`;
	writeMd(planningPath("DOMAIN-MODEL.md"), tmpl);
	console.log(`Created: ${PLANNING_DIR}/DOMAIN-MODEL.md`);
	console.log("Fill in the domain model based on PROJECT.md context.");
};

// --- init-state ---
commands["init-state"] = function () {
	const tmpl = `# State\n\n## Current Phase: 1\n## Status: initialized\n\n## Decisions\n(none yet)\n\n## Blockers\nNone.\n\n## Quick Tasks Completed\n(none)\n\n## Last Activity: ${timestamp()}\n`;
	writeMd(planningPath("STATE.md"), tmpl);
	writeJson(planningPath("config.json"), getConfig());
	console.log(`Created: ${PLANNING_DIR}/STATE.md`);
	console.log(`Created: ${PLANNING_DIR}/config.json`);
};

// --- phase-info ---
commands["phase-info"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht phase-info N"); process.exit(1); }

	const roadmap = getRoadmap();
	if (!roadmap) { console.error("No ROADMAP.md found"); process.exit(1); }

	const info = parsePhaseFromRoadmap(roadmap, num);
	const phaseDir = getPhaseDir(num);
	const contextFile = phaseDir ? path.join(phaseDir, `${padNum(num)}-CONTEXT.md`) : null;
	const context = contextFile ? readMd(contextFile) : null;

	console.log(banner(`PHASE ${num} INFO`));
	if (info) console.log(`\nName: ${info.name}\nStatus: ${info.status}`);
	if (phaseDir) console.log(`Directory: ${phaseDir}`);
	if (context) console.log(`\n--- Context ---\n${context}`);
	else console.log("\nNo context captured yet. Run: gsd-discuss-phase " + num);
};

// --- save-context ---
commands["save-context"] = function (n, ...rest) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht save-context N"); process.exit(1); }

	const slug = getPhaseSlug(num) || `phase-${num}`;
	const dir = planningPath("phases", `${padNum(num)}-${slug}`);
	ensureDir(dir);

	const contextPath = path.join(dir, `${padNum(num)}-CONTEXT.md`);
	if (fs.existsSync(contextPath)) {
		console.log(`Context already exists at ${contextPath}`);
		console.log("Edit it directly or pass content via stdin.");
	} else {
		const tmpl = `# Phase ${num} Context\n\n## Domain Boundary\n[What this phase covers]\n\n## Decisions\n[Captured during discussion]\n\n## Claude's Discretion\n[Areas where Claude can decide]\n\n## Deferred Ideas\n[Saved for later]\n\n---\nCreated: ${timestamp()}\n`;
		writeMd(contextPath, tmpl);
		console.log(`Created: ${contextPath}`);
	}
};

// --- load-phase-context ---
commands["load-phase-context"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht load-phase-context N"); process.exit(1); }

	const files = [];
	const project = readMd(planningPath("PROJECT.md"));
	if (project) files.push({ name: "PROJECT.md", content: project });

	const reqs = readMd(planningPath("REQUIREMENTS.md"));
	if (reqs) files.push({ name: "REQUIREMENTS.md", content: reqs });

	const roadmap = getRoadmap();
	if (roadmap) files.push({ name: "ROADMAP.md", content: roadmap });

	const phaseDir = getPhaseDir(num);
	if (phaseDir) {
		const context = readMd(path.join(phaseDir, `${padNum(num)}-CONTEXT.md`));
		if (context) files.push({ name: `${padNum(num)}-CONTEXT.md`, content: context });
	}

	// Codebase docs
	const cbDir = planningPath("codebase");
	if (fs.existsSync(cbDir)) {
		for (const f of fs.readdirSync(cbDir)) {
			if (f.endsWith(".md")) {
				files.push({ name: `codebase/${f}`, content: readMd(path.join(cbDir, f)) });
			}
		}
	}

	// Research docs
	const resDir = planningPath("research");
	if (fs.existsSync(resDir)) {
		for (const f of fs.readdirSync(resDir)) {
			if (f.endsWith(".md")) {
				files.push({ name: `research/${f}`, content: readMd(path.join(resDir, f)) });
			}
		}
	}

	console.log(banner(`PHASE ${num} CONTEXT`));
	for (const f of files) {
		console.log(`\n=== ${f.name} ===\n${f.content}`);
	}
};

// --- create-plan ---
commands["create-plan"] = function (n, p, ...titleWords) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht create-plan N P [title]"); process.exit(1); }

	const slug = getPhaseSlug(phaseNum) || `phase-${phaseNum}`;
	const dir = planningPath("phases", `${padNum(phaseNum)}-${slug}`);
	ensureDir(dir);

	const title = titleWords.join(" ") || `Plan ${planNum}`;
	const planPath = path.join(dir, `${padNum(phaseNum)}-${padNum(planNum)}-PLAN.md`);

	const tmpl = `---
phase: ${phaseNum}
plan: ${planNum}
depends_on: []
must_haves:
  - "[Observable truth this plan delivers]"
---

# Phase ${phaseNum}, Plan ${planNum}: ${title}

## Goal
[What this plan achieves from user perspective]

## Context
[Key decisions that affect this plan]

## Tasks

<task type="auto">
  <n>[Task name]</n>
  <files>[affected files]</files>
  <test>[Write tests first — what should pass when done]</test>
  <action>
    [Implementation to make tests pass]
  </action>
  <refactor>[Optional cleanup after green]</refactor>
  <verify>[How to verify]</verify>
  <done>[What "done" looks like]</done>
</task>

---
Created: ${timestamp()}
`;
	writeMd(planPath, tmpl);
	console.log(`Created: ${planPath}`);
};

// --- discover-plans ---
commands["discover-plans"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht discover-plans N"); process.exit(1); }

	const phaseDir = getPhaseDir(num);
	if (!phaseDir) { console.error(`Phase ${num} directory not found`); process.exit(1); }

	const files = fs.readdirSync(phaseDir).sort();
	const plans = files.filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
	const summaries = files.filter((f) => f.endsWith("-SUMMARY.md"));
	const fixPlans = files.filter((f) => f.includes("FIX-PLAN.md"));

	const completedPlanNums = new Set(
		summaries.map((s) => {
			const match = s.match(/\d+-(\d+)-SUMMARY/);
			return match ? match[1] : null;
		}).filter(Boolean)
	);

	const incomplete = plans.filter((p) => {
		const match = p.match(/\d+-(\d+)-PLAN/);
		return match ? !completedPlanNums.has(match[1]) : true;
	});

	console.log(banner(`PHASE ${num} PLANS`));
	console.log(`\nTotal plans: ${plans.length}`);
	console.log(`Completed: ${summaries.length}`);
	console.log(`Remaining: ${incomplete.length}`);
	console.log(`Fix plans: ${fixPlans.length}`);

	if (incomplete.length > 0) {
		console.log(`\nIncomplete plans:`);
		for (const p of incomplete) console.log(`  - ${p}`);
	}

	// Parse dependencies for ordering
	const planData = plans.map((p) => {
		const content = readMd(path.join(phaseDir, p));
		const depsMatch = content?.match(/depends_on:\s*\[(.*?)\]/);
		const deps = depsMatch ? depsMatch[1].split(",").map((d) => d.trim()).filter(Boolean) : [];
		return { file: p, deps };
	});

	// Output as JSON for programmatic use
	console.log(`\n--- JSON ---`);
	console.log(JSON.stringify({ plans: planData, incomplete, fixPlans }, null, 2));
};

// --- read-plan ---
commands["read-plan"] = function (n, p) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht read-plan N P"); process.exit(1); }

	const phaseDir = getPhaseDir(phaseNum);
	if (!phaseDir) { console.error(`Phase ${phaseNum} not found`); process.exit(1); }

	const planFile = `${padNum(phaseNum)}-${padNum(planNum)}-PLAN.md`;
	const content = readMd(path.join(phaseDir, planFile));
	if (!content) { console.error(`Plan file not found: ${planFile}`); process.exit(1); }

	console.log(content);
};

// --- validate-plans ---
commands["validate-plans"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht validate-plans N"); process.exit(1); }

	const phaseDir = getPhaseDir(num);
	if (!phaseDir) { console.error(`Phase ${num} not found`); process.exit(1); }

	const files = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md"));
	const issues = [];

	for (const file of files) {
		const content = readMd(path.join(phaseDir, file));
		if (!content) continue;

		// Check for required elements
		if (!content.includes("<task")) issues.push(`${file}: No <task> elements found`);
		if (!content.includes("<verify>")) issues.push(`${file}: Missing <verify> in tasks`);
		if (!content.includes("<done>")) issues.push(`${file}: Missing <done> in tasks`);
		if (!content.includes("must_haves")) issues.push(`${file}: Missing must_haves in frontmatter`);

		// Count tasks
		const taskCount = (content.match(/<task/g) || []).length;
		if (taskCount > 5) issues.push(`${file}: ${taskCount} tasks (max recommended: 5)`);
		if (taskCount === 0) issues.push(`${file}: No tasks defined`);
	}

	console.log(banner(`VALIDATE PHASE ${num}`));
	console.log(`\nPlans checked: ${files.length}`);
	if (issues.length === 0) {
		console.log("✅ All plans valid");
	} else {
		console.log(`\n⚠️  ${issues.length} issue(s):`);
		for (const issue of issues) console.log(`  - ${issue}`);
	}
};

// --- commit-task ---
commands["commit-task"] = function (n, p, t, ...desc) {
	const phaseNum = padNum(parseInt(n, 10));
	const planNum = padNum(parseInt(p, 10));
	const taskNum = t || "1";
	const description = desc.join(" ") || "implement task";

	const hash = gitCommitAll(`feat(${phaseNum}-${planNum}): ${description}`);
	if (hash) {
		console.log(`Committed: ${hash} — feat(${phaseNum}-${planNum}): ${description}`);
		// TDD check: warn if no test files in commit
		try {
			const files = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, { encoding: "utf-8" }).trim();
			const hasTests = files.split("\n").some((f) => /\.(test|spec)\.(ts|tsx|js|jsx)$|_test\.(go|ts)$/.test(f));
			if (!hasTests) {
				console.log("⚠️  No test files in this commit — TDD requires tests first");
			}
		} catch { /* ignore */ }
	} else {
		console.log("Nothing to commit (or no git)");
	}
};

// --- write-summary ---
commands["write-summary"] = function (n, p) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht write-summary N P"); process.exit(1); }

	const phaseDir = getPhaseDir(phaseNum);
	if (!phaseDir) { console.error(`Phase ${phaseNum} not found`); process.exit(1); }

	const summaryPath = path.join(phaseDir, `${padNum(phaseNum)}-${padNum(planNum)}-SUMMARY.md`);
	const tmpl = `# Phase ${phaseNum}, Plan ${planNum} Summary\n\n## Completed Tasks\n| # | Task | Status | Commit |\n|---|------|--------|--------|\n| 1 | [task] | ✅ Done | [hash] |\n\n## Files Changed\n- [files]\n\n## Verification Results\n- [results]\n\n## Notes\n[deviations, decisions]\n\n---\nCompleted: ${timestamp()}\n`;
	writeMd(summaryPath, tmpl);
	console.log(`Created: ${summaryPath}`);
};

// --- verify-phase ---
commands["verify-phase"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht verify-phase N"); process.exit(1); }

	const phaseDir = getPhaseDir(num);
	if (!phaseDir) { console.error(`Phase ${num} not found`); process.exit(1); }

	const plans = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
	const summaries = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-SUMMARY.md"));

	console.log(banner(`VERIFY PHASE ${num}`));
	console.log(`\nPlans: ${plans.length}`);
	console.log(`Summaries: ${summaries.length}`);

	if (summaries.length >= plans.length) {
		console.log("\n✅ All plans have summaries — phase execution complete");
		// Write verification file
		const verPath = path.join(phaseDir, `${padNum(num)}-VERIFICATION.md`);
		writeMd(verPath, `# Phase ${num} Verification\n\nAll ${plans.length} plans executed.\nVerified: ${timestamp()}\n`);
	} else {
		console.log(`\n⚠️  ${plans.length - summaries.length} plan(s) still incomplete`);
	}
};

// --- extract-deliverables ---
commands["extract-deliverables"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht extract-deliverables N"); process.exit(1); }

	const phaseDir = getPhaseDir(num);
	if (!phaseDir) { console.error(`Phase ${num} not found`); process.exit(1); }

	const plans = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md"));
	const deliverables = [];

	for (const planFile of plans) {
		const content = readMd(path.join(phaseDir, planFile));
		if (!content) continue;

		// Extract must_haves
		const mustHaveMatch = content.match(/must_haves:\s*\n((?:\s+-\s+.+\n?)*)/);
		if (mustHaveMatch) {
			const items = mustHaveMatch[1].match(/- ["']?(.+?)["']?\s*$/gm) || [];
			for (const item of items) {
				deliverables.push({ source: planFile, type: "must_have", text: item.replace(/^\s*-\s*["']?|["']?\s*$/g, "") });
			}
		}

		// Extract <done> tags
		const doneMatches = content.matchAll(/<done>([\s\S]*?)<\/done>/g);
		for (const match of doneMatches) {
			deliverables.push({ source: planFile, type: "done", text: match[1].trim() });
		}
	}

	console.log(banner(`PHASE ${num} DELIVERABLES`));
	console.log(`\nFound ${deliverables.length} testable items:\n`);
	deliverables.forEach((d, i) => {
		console.log(`  ${i + 1}. [${d.type}] ${d.text} (from ${d.source})`);
	});

	console.log(`\n--- JSON ---`);
	console.log(JSON.stringify(deliverables, null, 2));
};

// --- create-fix-plan ---
commands["create-fix-plan"] = function (n, p, ...issueWords) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht create-fix-plan N P [issue]"); process.exit(1); }

	const slug = getPhaseSlug(phaseNum) || `phase-${phaseNum}`;
	const dir = planningPath("phases", `${padNum(phaseNum)}-${slug}`);
	const issue = issueWords.join(" ") || "Fix identified issues";

	const fixPath = path.join(dir, `${padNum(phaseNum)}-${padNum(planNum)}-FIX-PLAN.md`);
	const tmpl = `---
gap_closure: true
fixes_plan: ${planNum}
issue: "${issue}"
---

# Fix Plan for Phase ${phaseNum}, Plan ${planNum}

## Issue
${issue}

## Tasks

<task type="auto">
  <n>[Fix description]</n>
  <files>[affected files]</files>
  <action>[Fix instructions]</action>
  <verify>[How to verify fix]</verify>
  <done>[What "fixed" looks like]</done>
</task>

---
Created: ${timestamp()}
`;
	writeMd(fixPath, tmpl);
	console.log(`Created: ${fixPath}`);
};

// --- write-uat ---
commands["write-uat"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht write-uat N"); process.exit(1); }

	const phaseDir = getPhaseDir(num);
	if (!phaseDir) { console.error(`Phase ${num} not found`); process.exit(1); }

	const uatPath = path.join(phaseDir, `${padNum(num)}-UAT.md`);
	const tmpl = `# Phase ${num} User Acceptance Testing\n\n## Test Date: ${dateStamp()}\n\n## Results\n| # | Deliverable | Status | Notes |\n|---|-------------|--------|-------|\n| 1 | [description] | ✅ Pass | |\n\n## Summary\n- Passed: X/Y\n- Failed: 0/Y\n- Skipped: 0/Y\n\n## Fix Plans Created\n(none)\n`;
	writeMd(uatPath, tmpl);
	console.log(`Created: ${uatPath}`);
};

// --- next-quick-number ---
commands["next-quick-number"] = function () {
	const dir = planningPath("quick");
	if (!fs.existsSync(dir)) { console.log("001"); return; }
	const entries = fs.readdirSync(dir).sort();
	const last = entries[entries.length - 1];
	const num = last ? parseInt(last.match(/^(\d+)/)?.[1] || "0", 10) + 1 : 1;
	console.log(padNum(num, 3));
};

// --- create-quick-plan ---
commands["create-quick-plan"] = function (n, ...descWords) {
	const num = padNum(parseInt(n, 10), 3);
	const desc = descWords.join(" ") || "Quick task";
	const slug = slugify(desc);
	const dir = planningPath("quick", `${num}-${slug}`);
	ensureDir(dir);

	const planPath = path.join(dir, `${num}-PLAN.md`);
	const tmpl = `# Quick Task ${num}: ${desc}\n\n## Tasks\n\n<task type="auto">\n  <n>[Task]</n>\n  <files>[files]</files>\n  <action>[instructions]</action>\n  <verify>[verify]</verify>\n  <done>[done]</done>\n</task>\n\n---\nCreated: ${timestamp()}\n`;
	writeMd(planPath, tmpl);
	console.log(`Created: ${planPath}`);
};

// --- write-quick-summary ---
commands["write-quick-summary"] = function (n) {
	const num = padNum(parseInt(n, 10), 3);
	const dir = planningPath("quick");
	if (!fs.existsSync(dir)) { console.error("No quick tasks directory"); process.exit(1); }
	const match = fs.readdirSync(dir).find((e) => e.startsWith(num));
	if (!match) { console.error(`Quick task ${num} not found`); process.exit(1); }

	const summaryPath = path.join(dir, match, `${num}-SUMMARY.md`);
	const tmpl = `# Quick Task ${num} Summary\n\n## Tasks Completed\n| # | Task | Status | Commit |\n|---|------|--------|--------|\n| 1 | [task] | ✅ Done | [hash] |\n\n## Files Changed\n- [files]\n\n---\nCompleted: ${timestamp()}\n`;
	writeMd(summaryPath, tmpl);
	console.log(`Created: ${summaryPath}`);
};

// --- update-state ---
commands["update-state"] = function () {
	const statePath = planningPath("STATE.md");
	let state = readMd(statePath);
	if (!state) { console.error("No STATE.md found"); process.exit(1); }

	// Update last activity
	state = state.replace(/## Last Activity:.*/, `## Last Activity: ${timestamp()}`);
	writeMd(statePath, state);
	console.log(`Updated: ${statePath}`);
};

// --- progress ---
commands.progress = function () {
	const state = getState();
	const roadmap = getRoadmap();
	if (!state || !roadmap) {
		console.log("No Draht project found. Run: draht init");
		process.exit(1);
	}

	console.log(banner("PROJECT STATUS"));

	// Parse phases from roadmap
	const phaseRegex = /## Phase (\d+):\s*(.+?)\s*—\s*`(\w+)`/g;
	let match;
	const phases = [];
	while ((match = phaseRegex.exec(roadmap))) {
		phases.push({ num: parseInt(match[1], 10), name: match[2], status: match[3] });
	}

	if (phases.length === 0) {
		console.log("\nNo phases found in ROADMAP.md");
	} else {
		console.log("\nPhases:");
		for (const phase of phases) {
			const icon = phase.status === "complete" ? "✅" : phase.status === "in-progress" ? "🔄" : "⬜";
			const phaseDir = getPhaseDir(phase.num);
			let planInfo = "";
			if (phaseDir) {
				const plans = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
				const summaries = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-SUMMARY.md"));
				planInfo = ` (${summaries.length}/${plans.length} plans)`;
			}
			console.log(`  ${icon} Phase ${phase.num}: ${phase.name} — ${phase.status}${planInfo}`);
		}
	}

	// Quick tasks
	const quickDir = planningPath("quick");
	if (fs.existsSync(quickDir)) {
		const quickCount = fs.readdirSync(quickDir).length;
		console.log(`\nQuick Tasks: ${quickCount}`);
	}

	// Blockers from state
	const blockerMatch = state.match(/## Blockers\n([\s\S]*?)(?=\n##|\n---|\Z)/);
	if (blockerMatch) {
		const blockers = blockerMatch[1].trim();
		if (blockers && blockers !== "None." && blockers !== "(none)") {
			console.log(`\n⚠️  Blockers:\n${blockers}`);
		}
	}

	// Last activity
	const lastMatch = state.match(/## Last Activity:\s*(.+)/);
	if (lastMatch) console.log(`\nLast activity: ${lastMatch[1]}`);
};

// --- pause ---
commands.pause = function () {
	const state = getState();
	if (!state) { console.error("No STATE.md found"); process.exit(1); }

	let gitStatus = "";
	try { gitStatus = execSync("git status --porcelain", { encoding: "utf-8" }).trim(); } catch { /* empty */ }

	const tmpl = `# Continue Here\n\n## Session Paused: ${timestamp()}\n\n## Current Position\n[Fill from STATE.md]\n\n## What Was Happening\n[Brief description]\n\n## Uncommitted Changes\n${gitStatus || "None"}\n\n## Next Steps\n1. [What to do next]\n\n## Open Questions\n- [Any unresolved decisions]\n`;
	writeMd(planningPath("CONTINUE-HERE.md"), tmpl);
	console.log(`Created: ${PLANNING_DIR}/CONTINUE-HERE.md`);
};

// --- resume ---
commands.resume = function () {
	const continueFile = readMd(planningPath("CONTINUE-HERE.md"));
	if (continueFile) {
		console.log(banner("RESUMING WORK"));
		console.log(`\n${continueFile}`);
	} else {
		const state = getState();
		if (state) {
			console.log(banner("RESUMING WORK (from STATE.md)"));
			console.log(`\n${state}`);
		} else {
			console.log("No Draht project found.");
		}
	}
};

// --- commit-docs ---
commands["commit-docs"] = function (...msg) {
	const message = msg.join(" ") || "update planning docs";
	const hash = gitCommit(`docs: ${message}`);
	if (hash) console.log(`Committed: ${hash} — docs: ${message}`);
	else console.log("Nothing to commit (or no git)");
};

// --- research-phase ---
commands["research-phase"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht research-phase N"); process.exit(1); }

	const slug = getPhaseSlug(num) || `phase-${num}`;
	const dir = planningPath("phases", `${padNum(num)}-${slug}`);
	ensureDir(dir);

	const resPath = path.join(dir, `${padNum(num)}-RESEARCH.md`);
	const tmpl = `# Phase ${num} Research\n\nGenerated: ${timestamp()}\n\n## Best Practices\n[Fill in]\n\n## Patterns & Anti-Patterns\n[Fill in]\n\n## Library Recommendations\n[Fill in]\n\n## Edge Cases & Gotchas\n[Fill in]\n`;
	writeMd(resPath, tmpl);
	console.log(`Created: ${resPath}`);
	console.log("→ Fill in research findings, then plan the phase.");
};

// ============================================================================
// Help & Dispatch
// ============================================================================

commands.help = function () {
	console.log(`
Draht Tools — Get Shit Done CLI

Usage: draht <command> [args]

Project Setup:
  init                          Check preconditions, create .planning/
  map-codebase [dir]            Analyze existing codebase
  create-project [name]         Create PROJECT.md
  create-requirements           Create REQUIREMENTS.md
  create-domain-model           Generate DOMAIN-MODEL.md from PROJECT.md
  create-roadmap                Create ROADMAP.md
  init-state                    Create STATE.md + config.json

Phase Management:
  phase-info N                  Show phase details
  save-context N                Create/show CONTEXT.md for phase
  load-phase-context N          Load all context for planning
  research-phase N              Create research template for phase
  create-plan N P [title]       Create PLAN.md template
  discover-plans N              List and order plans in a phase
  read-plan N P                 Output plan content
  validate-plans N              Check plans for required elements

Execution:
  commit-task N P T [desc]      Git commit for a task
  write-summary N P             Create SUMMARY.md for completed plan
  verify-phase N                Check all plans have summaries

Verification:
  extract-deliverables N        List testable items from plans
  create-fix-plan N P [issue]   Create FIX-PLAN.md for failed tests
  write-uat N                   Create UAT report

Quick Tasks:
  next-quick-number             Get next quick task number
  create-quick-plan NNN [desc]  Create quick task plan
  write-quick-summary NNN       Create quick task summary

Session:
  pause                         Create CONTINUE-HERE.md
  resume                        Load last session state
  progress                      Show project status
  update-state                  Update STATE.md timestamp

Git:
  commit-docs [message]         Commit .planning/ changes
  commit-task N P T [desc]      Commit all changes as task

Version: 1.0.0
	`);
};

// Dispatch
const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
	commands.help();
} else if (commands[cmd]) {
	commands[cmd](...args);
} else {
	console.error(`Unknown command: ${cmd}\nRun: draht help`);
	process.exit(1);
}
