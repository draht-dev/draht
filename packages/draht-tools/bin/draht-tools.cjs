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
		console.log("Project already initialized. Use `draht-tools progress` to see status.");
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
		console.log("\n⚠️  Existing code detected. Consider running: draht-tools map-codebase");
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

	// Build the living knowledge graph (MAP.json + MAP.html + GRAPH_REPORT.md) alongside the docs,
	// so `map-codebase` is a single command that produces both the prose docs and the graphify map.
	let kg = null;
	try {
		kg = visWriteOutputs(cwd);
	} catch (err) {
		console.error(`\n⚠️  Knowledge graph build failed (run \`draht-tools map-graph\` to retry): ${err.message}`);
	}

	console.log(`\nCreated:\n  ${outDir}/STACK.md\n  ${outDir}/ARCHITECTURE.md\n  ${outDir}/CONVENTIONS.md\n  ${outDir}/CONCERNS.md\n  ${outDir}/DOMAIN-HINTS.md`);
	if (kg) {
		console.log(`  ${path.relative(cwd, kg.jsonPath)}\n  ${path.relative(cwd, kg.htmlPath)}\n  ${path.relative(cwd, kg.reportPath)}`);
		console.log(`\nIndexed ${kg.map.stats.files} modules · ${kg.map.clusters.length} clusters · view it live: draht-tools map-serve`);
	}
	console.log("\n→ Review and fill in the TODOs, then run: draht-tools commit-docs \"map existing codebase\"");
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
	if (!num) { console.error("Usage: draht-tools phase-info N"); process.exit(1); }

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
	else console.log("\nNo context captured yet. Run: /discuss-phase " + num);
};

// --- save-context ---
// Supports stdin: echo "content" | draht-tools save-context N
commands["save-context"] = async function (n, ...rest) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht-tools save-context N"); process.exit(1); }

	const slug = getPhaseSlug(num) || `phase-${num}`;
	const dir = planningPath("phases", `${padNum(num)}-${slug}`);
	ensureDir(dir);

	const contextPath = path.join(dir, `${padNum(num)}-CONTEXT.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	if (stdinContent) {
		writeMd(contextPath, stdinContent);
		console.log(`Created: ${contextPath}`);
	} else if (fs.existsSync(contextPath)) {
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
	if (!num) { console.error("Usage: draht-tools load-phase-context N"); process.exit(1); }

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
// Supports stdin: echo "content" | draht-tools create-plan N P [title]
commands["create-plan"] = async function (n, p, ...titleWords) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht-tools create-plan N P [title]"); process.exit(1); }

	const slug = getPhaseSlug(phaseNum) || `phase-${phaseNum}`;
	const dir = planningPath("phases", `${padNum(phaseNum)}-${slug}`);
	ensureDir(dir);

	const title = titleWords.join(" ") || `Plan ${planNum}`;
	const planPath = path.join(dir, `${padNum(phaseNum)}-${padNum(planNum)}-PLAN.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		// Use stdin content directly
		content = stdinContent;
	} else {
		// Generate template
		content = `---
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
	}

	writeMd(planPath, content);
	console.log(`Created: ${planPath}`);
};

// --- discover-plans ---
commands["discover-plans"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht-tools discover-plans N"); process.exit(1); }

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
	if (!phaseNum || !planNum) { console.error("Usage: draht-tools read-plan N P"); process.exit(1); }

	const phaseDir = getPhaseDir(phaseNum);
	if (!phaseDir) { console.error(`Phase ${phaseNum} not found`); process.exit(1); }

	const planFile = `${padNum(phaseNum)}-${padNum(planNum)}-PLAN.md`;
	const content = readMd(path.join(phaseDir, planFile));
	if (!content) { console.error(`Plan file not found: ${planFile}`); process.exit(1); }

	console.log(content);
};

// --- validate-plans ---
// Placeholder patterns that indicate a task isn't actually executable.
// Borrowed from superpowers' writing-plans discipline: tasks with these aren't
// usable input for an implementer subagent.
const PLACEHOLDER_PATTERNS = [
	{ pattern: /\[TBD\]/i, label: "[TBD]" },
	{ pattern: /\[files?\]/i, label: "[file] or [files]" },
	{ pattern: /\[description\]/i, label: "[description]" },
	{ pattern: /\[task\s*name\]/i, label: "[task name]" },
	{ pattern: /\bappropriate\s+error\s+handling\b/i, label: '"appropriate error handling"' },
	{ pattern: /\bsimilar\s+to\s+task\s+[NX0-9]+\b/i, label: '"similar to Task N"' },
	{ pattern: /\bsee\s+previous\s+task\b/i, label: '"see previous task"' },
	{ pattern: /\bfill\s+in\s+later\b/i, label: '"fill in later"' },
	{ pattern: /\bfigure\s+(?:this\s+)?out\s+later\b/i, label: '"figure out later"' },
];

function findPlaceholders(content) {
	const hits = [];
	for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
		if (pattern.test(content)) hits.push(label);
	}
	return hits;
}

function findEmptySections(content) {
	// Detect <test>, <action>, <verify>, <done> blocks that are empty or contain only whitespace/placeholders
	const sections = ["test", "action", "verify", "done", "files"];
	const empty = [];
	for (const tag of sections) {
		const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
		let match;
		while ((match = re.exec(content)) !== null) {
			const inner = match[1].trim();
			if (inner.length === 0 || /^\.\.\.$/.test(inner) || /^\[.*\]$/.test(inner)) {
				empty.push(`<${tag}>`);
			}
		}
	}
	return empty;
}

commands["validate-plans"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht-tools validate-plans N"); process.exit(1); }

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

		// Placeholder linter — flag tasks that aren't actually executable
		const placeholders = findPlaceholders(content);
		if (placeholders.length > 0) {
			issues.push(`${file}: contains placeholder text → ${placeholders.join(", ")} (tasks must be concrete to dispatch to subagents)`);
		}

		// Empty section linter — <test>, <action>, <verify>, <done>, <files> must have real content
		const emptySections = findEmptySections(content);
		if (emptySections.length > 0) {
			issues.push(`${file}: empty or placeholder-only sections → ${emptySections.join(", ")}`);
		}
	}

	console.log(banner(`VALIDATE PHASE ${num}`));
	console.log(`\nPlans checked: ${files.length}`);
	if (issues.length === 0) {
		console.log("✅ All plans valid");
	} else {
		console.log(`\n⚠️  ${issues.length} issue(s):`);
		for (const issue of issues) console.log(`  - ${issue}`);
		process.exit(1);
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
// Supports stdin: echo "content" | draht-tools write-summary N P
commands["write-summary"] = async function (n, p) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht-tools write-summary N P"); process.exit(1); }

	const phaseDir = getPhaseDir(phaseNum);
	if (!phaseDir) { console.error(`Phase ${phaseNum} not found`); process.exit(1); }

	const summaryPath = path.join(phaseDir, `${padNum(phaseNum)}-${padNum(planNum)}-SUMMARY.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		content = stdinContent;
	} else {
		content = `# Phase ${phaseNum}, Plan ${planNum} Summary\n\n## Completed Tasks\n| # | Task | Status | Commit |\n|---|------|--------|--------|\n| 1 | [task] | ✅ Done | [hash] |\n\n## Files Changed\n- [files]\n\n## Verification Results\n- [results]\n\n## Notes\n[deviations, decisions]\n\n---\nCompleted: ${timestamp()}\n`;
	}

	writeMd(summaryPath, content);
	console.log(`Created: ${summaryPath}`);
};

// --- verify-phase ---
commands["verify-phase"] = function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht-tools verify-phase N"); process.exit(1); }

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
	if (!num) { console.error("Usage: draht-tools extract-deliverables N"); process.exit(1); }

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
// Supports stdin: echo "content" | draht-tools create-fix-plan N P [issue]
commands["create-fix-plan"] = async function (n, p, ...issueWords) {
	const phaseNum = parseInt(n, 10);
	const planNum = parseInt(p, 10);
	if (!phaseNum || !planNum) { console.error("Usage: draht-tools create-fix-plan N P [issue]"); process.exit(1); }

	const slug = getPhaseSlug(phaseNum) || `phase-${phaseNum}`;
	const dir = planningPath("phases", `${padNum(phaseNum)}-${slug}`);
	ensureDir(dir);
	const issue = issueWords.join(" ") || "Fix identified issues";

	const fixPath = path.join(dir, `${padNum(phaseNum)}-${padNum(planNum)}-FIX-PLAN.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		content = stdinContent;
	} else {
		content = `---
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
	}

	writeMd(fixPath, content);
	console.log(`Created: ${fixPath}`);
};

// --- write-uat ---
// Supports stdin: echo "content" | draht-tools write-uat N
commands["write-uat"] = async function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht-tools write-uat N"); process.exit(1); }

	const phaseDir = getPhaseDir(num);
	if (!phaseDir) { console.error(`Phase ${num} not found`); process.exit(1); }

	const uatPath = path.join(phaseDir, `${padNum(num)}-UAT.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		content = stdinContent;
	} else {
		content = `# Phase ${num} User Acceptance Testing\n\n## Test Date: ${dateStamp()}\n\n## Results\n| # | Deliverable | Status | Notes |\n|---|-------------|--------|-------|\n| 1 | [description] | ✅ Pass | |\n\n## Summary\n- Passed: X/Y\n- Failed: 0/Y\n- Skipped: 0/Y\n\n## Fix Plans Created\n(none)\n`;
	}

	writeMd(uatPath, content);
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
// Supports stdin: echo "content" | draht-tools create-quick-plan NNN [desc]
commands["create-quick-plan"] = async function (n, ...descWords) {
	const num = padNum(parseInt(n, 10), 3);
	const desc = descWords.join(" ") || "Quick task";
	const slug = slugify(desc);
	const dir = planningPath("quick", `${num}-${slug}`);
	ensureDir(dir);

	const planPath = path.join(dir, `${num}-PLAN.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		// Use stdin content directly
		content = stdinContent;
	} else {
		// Generate template
		content = `# Quick Task ${num}: ${desc}\n\n## Tasks\n\n<task type="auto">\n  <n>[Task]</n>\n  <files>[files]</files>\n  <action>[instructions]</action>\n  <verify>[verify]</verify>\n  <done>[done]</done>\n</task>\n\n---\nCreated: ${timestamp()}\n`;
	}

	writeMd(planPath, content);
	console.log(`Created: ${planPath}`);
};

// --- write-quick-summary ---
// Supports stdin: echo "content" | draht-tools write-quick-summary NNN
commands["write-quick-summary"] = async function (n) {
	const num = padNum(parseInt(n, 10), 3);
	const dir = planningPath("quick");
	if (!fs.existsSync(dir)) { console.error("No quick tasks directory"); process.exit(1); }
	const match = fs.readdirSync(dir).find((e) => e.startsWith(num));
	if (!match) { console.error(`Quick task ${num} not found`); process.exit(1); }

	const summaryPath = path.join(dir, match, `${num}-SUMMARY.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		content = stdinContent;
	} else {
		content = `# Quick Task ${num} Summary\n\n## Tasks Completed\n| # | Task | Status | Commit |\n|---|------|--------|--------|\n| 1 | [task] | ✅ Done | [hash] |\n\n## Files Changed\n- [files]\n\n---\nCompleted: ${timestamp()}\n`;
	}

	writeMd(summaryPath, content);
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
		console.log("No Draht project found. Run: draht-tools init");
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
// Supports stdin: echo "content" | draht-tools research-phase N
commands["research-phase"] = async function (n) {
	const num = parseInt(n, 10);
	if (!num) { console.error("Usage: draht-tools research-phase N"); process.exit(1); }

	const slug = getPhaseSlug(num) || `phase-${num}`;
	const dir = planningPath("phases", `${padNum(num)}-${slug}`);
	ensureDir(dir);

	const resPath = path.join(dir, `${padNum(num)}-RESEARCH.md`);

	// Check for stdin content (piped input)
	let stdinContent = "";
	if (!process.stdin.isTTY) {
		stdinContent = await new Promise((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk) => { data += chunk; });
			process.stdin.on("end", () => { resolve(data.trim()); });
		});
	}

	let content;
	if (stdinContent) {
		content = stdinContent;
	} else {
		content = `# Phase ${num} Research\n\nGenerated: ${timestamp()}\n\n## Best Practices\n[Fill in]\n\n## Patterns & Anti-Patterns\n[Fill in]\n\n## Library Recommendations\n[Fill in]\n\n## Edge Cases & Gotchas\n[Fill in]\n`;
	}

	writeMd(resPath, content);
	console.log(`Created: ${resPath}`);
	if (!stdinContent) console.log("→ Fill in research findings, then plan the phase.");
};

// ============================================================================
// Codebase visualization — MAP.json + MAP.html (living map for humans + agents)
// ============================================================================

const VIS_DEFAULT_IGNORES = new Set([
	"node_modules", ".git", "dist", "build", "out", "target", ".next",
	".turbo", ".cache", "coverage", ".nyc_output", ".planning",
	".venv", "venv", "__pycache__", ".pytest_cache", ".idea", ".vscode",
	".DS_Store", ".sst", ".astro", ".svelte-kit", "vendor", "tmp", ".tmp",
]);

const VIS_CODE_LANGS = new Set([
	"typescript", "javascript", "python", "go", "rust", "java",
	"kotlin", "swift", "ruby", "php", "csharp", "c", "cpp", "shell",
]);

const LAYER_ORDER_INTERNAL = ["presentation", "application", "domain", "infrastructure", "support"];
const LAYER_COLORS_INTERNAL = {
	presentation: "#79c0ff", application: "#7ee787", domain: "#d2a8ff",
	infrastructure: "#f0883e", support: "#8b949e",
};

// Functional groups — CodeViz-style "containers" that nest workspace packages by purpose.
// Maps from explicit package name → group id. Anything not listed falls through to FALLBACK_GROUP_RULES.
const DEFAULT_GROUPS = [
	{ id: "group:frontend",        name: "Frontend",          color: "#79c0ff",
	  description: "User-facing web surfaces",
	  members: ["@draht/web-ui", "@draht/landing"] },
	{ id: "group:cli-runtime",     name: "CLI & Runtime",      color: "#ffdf5d",
	  description: "Command-line tools and runtime gateways",
	  members: ["draht-claude", "@draht/coding-agent", "@draht/tools", "@draht/tui", "@draht/gateway"] },
	{ id: "group:core",            name: "Core",              color: "#d2a8ff",
	  description: "Cross-cutting libraries used everywhere",
	  members: ["@draht/ai", "@draht/agent-core", "@draht/router"] },
	{ id: "group:domain-services", name: "Domain Services",   color: "#7ee787",
	  description: "Business logic and domain capabilities",
	  members: ["@draht/mom", "@draht/knowledge", "@draht/orchestrator", "@draht/invoice", "@draht/compliance"] },
	{ id: "group:workflows-infra", name: "Workflows & Infra", color: "#f0883e",
	  description: "Build pipelines, deployment, templates, ops",
	  members: ["@draht/ci", "@draht/deploy-guardian", "@draht/pods", "@draht/workflows", "@draht/infra", "@draht/templates"] },
	{ id: "group:root",            name: "Repo Root",         color: "#8b949e",
	  description: "Monorepo root package",
	  members: ["draht-monorepo"] },
];
// Fallback by name pattern (evaluated in order)
const FALLBACK_GROUP_RULES = [
	{ id: "group:frontend",        re: /^(web-ui|landing|ui|frontend|client|app|admin)$/ },
	{ id: "group:cli-runtime",     re: /^(cli|tui|gateway|coding|claude|tools|bin)|(?:^|-)extension(?:-|$)|^pi-/ },
	{ id: "group:core",            re: /^(ai|agent|router|llm|core|sdk|kernel)/ },
	{ id: "group:domain-services", re: /^(mom|knowledge|orchestrator|invoice|compliance|chat|search|memory)/ },
	{ id: "group:workflows-infra", re: /^(ci|deploy|pods|workflow|infra|template|guardian|ops)/ },
];

// Path-based fallback (when name doesn't match) — useful for example/extension dirs
const PATH_GROUP_RULES = [
	{ id: "group:cli-runtime", re: /(?:^|\/)(examples?|extensions?|samples?)\// },
	{ id: "group:frontend",    re: /(?:^|\/)(apps?|web|frontend|client)\// },
	{ id: "group:workflows-infra", re: /(?:^|\/)(scripts?|tools?|infra|deploy|ops)\// },
];

function deriveGroups(containers, pkgs, root) {
	const groups = DEFAULT_GROUPS.map((g) => Object.assign({}, g, { members: [], source: "auto", moduleCount: 0 }));
	const otherGroup = { id: "group:other", name: "Other", color: "#8b949e",
		description: "Packages not yet classified", members: [], source: "auto", moduleCount: 0 };

	const findGroup = (containerName, pkg) => {
		// Exact name match against DEFAULT_GROUPS
		for (let i = 0; i < DEFAULT_GROUPS.length; i++) {
			if (DEFAULT_GROUPS[i].members.includes(containerName)) return groups[i];
		}
		// Fallback regex on the scope-stripped name
		const bare = containerName.replace(/^@[^/]+\//, "").toLowerCase();
		for (const rule of FALLBACK_GROUP_RULES) {
			if (rule.re.test(bare)) {
				const idx = DEFAULT_GROUPS.findIndex((g) => g.id === rule.id);
				if (idx >= 0) return groups[idx];
			}
		}
		// Inherit from a parent workspace package when this one lives inside another's directory
		// (e.g., packages/web-ui/example inherits from @draht/web-ui).
		if (pkg && pkg.path && pkg.path !== ".") {
			const parentPkg = pkgs.find((p) => p.name !== pkg.name && p.path !== "." && pkg.path !== p.path && pkg.path.startsWith(p.path + "/"));
			if (parentPkg) {
				const parentGroup = findGroup(parentPkg.name, parentPkg);
				if (parentGroup && parentGroup.id !== "group:other") return parentGroup;
			}
		}
		// Path-based fallback for apps/, examples/, scripts/ etc.
		if (pkg && pkg.path && pkg.path !== ".") {
			for (const rule of PATH_GROUP_RULES) {
				if (rule.re.test(pkg.path.toLowerCase())) {
					const idx = DEFAULT_GROUPS.findIndex((g) => g.id === rule.id);
					if (idx >= 0) return groups[idx];
				}
			}
		}
		// Bin-presence cue → CLI & Runtime
		if (pkg && pkg.path !== ".") {
			try {
				const pjPath = path.join(root || process.cwd(), pkg.path, "package.json");
				const pj = JSON.parse(fs.readFileSync(pjPath, "utf-8"));
				if (pj.bin) {
					const idx = DEFAULT_GROUPS.findIndex((g) => g.id === "group:cli-runtime");
					if (idx >= 0) return groups[idx];
				}
			} catch { /* empty */ }
		}
		return otherGroup;
	};

	for (const c of containers) {
		const g = findGroup(c.name, pkgs.find((p) => p.name === c.name));
		g.members.push(c.id);
		g.moduleCount += c.moduleCount || 0;
		c.groupId = g.id;
	}
	const all = groups.filter((g) => g.members.length > 0);
	if (otherGroup.members.length > 0) all.push(otherGroup);
	return all;
}

function applyGroupsCuration(groups, root) {
	try {
		const file = path.join(root, PLANNING_DIR, "codebase", "GROUPS.json");
		if (!fs.existsSync(file)) return groups;
		const user = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!Array.isArray(user.groups)) return groups;
		const byId = new Map(groups.map((g) => [g.id, g]));
		for (const ug of user.groups) {
			if (!ug.id) continue;
			const existing = byId.get(ug.id);
			const merged = Object.assign({}, existing || {}, ug, { source: "curated" });
			byId.set(ug.id, merged);
		}
		// Enforce single-group-per-package: later (curated) groups win
		const seen = new Set();
		const out = [];
		for (const g of byId.values()) {
			const m = (g.members || []).filter((id) => {
				if (seen.has(id)) return false;
				seen.add(id);
				return true;
			});
			out.push(Object.assign({}, g, { members: m }));
		}
		return out;
	} catch { return groups; }
}

const VIS_LANG_BY_EXT = {
	".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
	".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
	".swift": "swift", ".rb": "ruby", ".php": "php", ".cs": "csharp",
	".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
	".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
	".toml": "toml", ".html": "html", ".css": "css", ".scss": "scss",
	".sh": "shell", ".bash": "shell", ".zsh": "shell", ".sql": "sql",
};

function visLangFor(file) {
	const ext = path.extname(file).toLowerCase();
	return VIS_LANG_BY_EXT[ext] || "other";
}

function visWalk(root, options = {}) {
	const ignore = options.ignore || VIS_DEFAULT_IGNORES;
	const maxFiles = options.maxFiles || 5000;
	const files = [];
	const stack = [root];
	while (stack.length && files.length < maxFiles) {
		const dir = stack.pop();
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			if (ignore.has(e.name)) continue;
			if (e.name.startsWith(".") && !["..", "."].includes(e.name)) {
				if (ignore.has(e.name)) continue;
			}
			const full = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile()) files.push(full);
			if (files.length >= maxFiles) break;
		}
	}
	return files;
}

// Parse JS/TS imports into structured entries: { specifier, names: [{local, imported}], default, namespace }
function visParseImports(content, language) {
	const out = [];
	if (language !== "typescript" && language !== "javascript") {
		// Fallback for other langs — return raw specifiers only
		const raw = visExtractRawImports(content, language);
		for (const s of raw) out.push({ specifier: s, names: [], default: null, namespace: null });
		return out;
	}
	// ES import statements
	const importRe = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]+)\})?\s*from\s*["']([^"']+)["']/g;
	let m;
	while ((m = importRe.exec(content)) !== null) {
		const def = m[1] || null;
		const ns = m[2] || null;
		const named = m[3];
		const spec = m[4];
		const names = [];
		if (named) {
			for (const part of named.split(",")) {
				const t = part.trim().replace(/^type\s+/, "");
				if (!t) continue;
				const asMatch = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
				if (asMatch) names.push({ imported: asMatch[1], local: asMatch[2] });
				else names.push({ imported: t, local: t });
			}
		}
		out.push({ specifier: spec, default: def, namespace: ns, names });
	}
	// require / dynamic import
	const reqRe = /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
	while ((m = reqRe.exec(content)) !== null) {
		out.push({ specifier: m[1], default: null, namespace: null, names: [] });
	}
	// re-exports: export { foo } from "./x"
	const reExportRe = /export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
	while ((m = reExportRe.exec(content)) !== null) {
		const names = m[1].split(",").map((s) => {
			const t = s.trim().replace(/^type\s+/, "");
			const asMatch = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
			return asMatch ? { imported: asMatch[1], local: asMatch[2] }
				: { imported: t, local: t };
		}).filter((n) => n.imported);
		out.push({ specifier: m[2], default: null, namespace: null, names, reExport: true });
	}
	// star re-exports: export * from "./x" or export * as Foo from "./x"
	const starReExportRe = /export\s+\*(?:\s+as\s+([A-Za-z_$][\w$]*))?\s+from\s+["']([^"']+)["']/g;
	while ((m = starReExportRe.exec(content)) !== null) {
		out.push({ specifier: m[2], default: null, namespace: m[1] || "*", names: [], reExport: true });
	}
	return out;
}

function visExtractRawImports(content, language) {
	const imports = [];
	if (language === "python") {
		const re = /(?:^|\n)\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/g;
		let m;
		while ((m = re.exec(content)) !== null) imports.push(m[1] || m[2]);
	} else if (language === "go") {
		const re = /(?:^|\n)\s*import\s+(?:"([^"]+)"|\(([^)]+)\))/g;
		let m;
		while ((m = re.exec(content)) !== null) {
			if (m[1]) imports.push(m[1]);
			if (m[2]) for (const l of m[2].split("\n")) {
				const im = l.match(/"([^"]+)"/);
				if (im) imports.push(im[1]);
			}
		}
	} else if (language === "rust") {
		const re = /(?:^|\n)\s*use\s+([a-zA-Z0-9_:]+)/g;
		let m;
		while ((m = re.exec(content)) !== null) imports.push(m[1]);
	}
	return imports;
}

// Extract exports — distinguish exported names so we can build a real call graph
function visExtractExports(rawContent, language) {
	const out = [];
	const lines = rawContent.split("\n");
	const findLeadingDoc = (idx) => {
		let i = idx - 1;
		// Skip blank decorator/annotation lines so JSDoc directly above @decorator export still gets attached
		while (i >= 0 && /^\s*@[A-Za-z]/.test(lines[i])) i--;
		// /** ... */ block immediately above?
		if (i >= 0 && /\*\/\s*$/.test(lines[i])) {
			const block = [];
			while (i >= 0) {
				block.unshift(lines[i]);
				if (/^\s*\/\*\*?/.test(lines[i])) break;
				i--;
			}
			if (i >= 0) {
				return block.join("\n")
					.replace(/^\s*\/\*\*?/, "")
					.replace(/\*\/\s*$/, "")
					.replace(/^\s*\*\s?/gm, "")
					.replace(/^\s*@\w+.*$/gm, "")
					.split("\n").map((s) => s.trim()).filter(Boolean).join(" ")
					.slice(0, 240);
			}
		}
		// Run of // comments immediately above?
		const block = [];
		while (i >= 0 && /^\s*\/\//.test(lines[i])) {
			block.unshift(lines[i].replace(/^\s*\/\/\s?/, ""));
			i--;
		}
		if (block.length) return block.join(" ").trim().slice(0, 240);
		return null;
	};

	if (language === "typescript" || language === "javascript") {
		const exportRe = /^\s*export\s+(?:default\s+)?(?:async\s+)?(class|interface|type|function|const|let|enum|var)\s+([A-Za-z_$][\w$]*)/;
		const namedExportRe = /^\s*export\s*\{([^}]+)\}(?!\s+from)/;
		const defaultRe = /^\s*export\s+default\s/;
		const commandRe = /^\s*commands\s*\[\s*["']([^"']+)["']\s*\]\s*=/;
		for (let i = 0; i < lines.length; i++) {
			let m;
			if ((m = exportRe.exec(lines[i]))) {
				out.push({ name: m[2], kind: m[1], line: i + 1, doc: findLeadingDoc(i) });
			} else if ((m = namedExportRe.exec(lines[i]))) {
				const doc = findLeadingDoc(i);
				for (const part of m[1].split(",")) {
					const t = part.trim().replace(/^type\s+/, "");
					const asMatch = t.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
					if (asMatch) out.push({ name: asMatch[2] || asMatch[1], kind: "named", line: i + 1, doc });
				}
			} else if (defaultRe.test(lines[i]) && !out.some((e) => e.name === "default")) {
				out.push({ name: "default", kind: "default", line: i + 1, doc: findLeadingDoc(i) });
			} else if ((m = commandRe.exec(lines[i]))) {
				out.push({ name: m[1], kind: "command", line: i + 1, doc: findLeadingDoc(i) });
			}
			if (out.length > 200) break;
		}
	} else if (language === "python") {
		const re = /^(class|def)\s+([A-Za-z_][A-Za-z0-9_]*)/;
		for (let i = 0; i < lines.length; i++) {
			const m = re.exec(lines[i]);
			if (m) {
				let doc = null;
				for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
					const dm = lines[j].match(/^\s*("""|''')(.*)/);
					if (dm) { doc = dm[2].replace(/("""|''')\s*$/, "").trim().slice(0, 220) || null; break; }
				}
				out.push({ name: m[2], kind: m[1], line: i + 1, doc });
			}
			if (out.length > 200) break;
		}
	} else if (language === "go") {
		const re = /^\s*(?:func\s+(?:\([^)]+\)\s+)?([A-Z][a-zA-Z0-9_]*)|type\s+([A-Z][a-zA-Z0-9_]*))/;
		for (let i = 0; i < lines.length; i++) {
			const m = re.exec(lines[i]);
			if (m) out.push({ name: m[1] || m[2], kind: m[1] ? "func" : "type", line: i + 1, doc: findLeadingDoc(i) });
			if (out.length > 200) break;
		}
	} else if (language === "rust") {
		const re = /^\s*pub\s+(?:fn|struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/;
		for (let i = 0; i < lines.length; i++) {
			const m = re.exec(lines[i]);
			if (m) {
				let j = i - 1; const block = [];
				while (j >= 0 && /^\s*\/\/\//.test(lines[j])) { block.unshift(lines[j].replace(/^\s*\/\/\/\s?/, "")); j--; }
				out.push({ name: m[1], kind: "rust-pub", line: i + 1, doc: block.length ? block.join(" ").trim().slice(0, 240) : null });
			}
			if (out.length > 200) break;
		}
	}
	const seen = new Set();
	// Reject "section divider" comments like `// --- foo ---` or `// ======` that aren't real docs
	const looksLikeDoc = (d) => d && d.length > 8 && !/^[-=#*\s]+$|^-+\s*\w+\s*-+$/.test(d.trim());
	return out
		.filter((e) => { if (seen.has(e.name)) return false; seen.add(e.name); return true; })
		.map((e) => looksLikeDoc(e.doc) ? e : Object.assign({}, e, { doc: null }));
}

// Locate concrete sink callsites: which line + enclosing function performs each sink.
function visFindSinkSites(content, language) {
	if (!VIS_CODE_LANGS.has(language)) return [];
	const sites = [];
	const lines = content.split("\n");
	const KEYWORDS = new Set(["if","else","while","for","switch","catch","try","do","return","throw","new","await","async","typeof","instanceof","void","delete","yield","case","default","function","class","const","let","var"]);
	const findEnclosingFunction = (lineIdx) => {
		for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 200); i--) {
			let m;
			if ((m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) return m[1];
			if ((m = lines[i].match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/))) return m[1];
			if ((m = lines[i].match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/))) {
				if (!KEYWORDS.has(m[1])) return m[1];
			}
			if ((m = lines[i].match(/^\s*def\s+([A-Za-z_$][\w$]*)/))) return m[1];
			if ((m = lines[i].match(/^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_$][\w$]*)/))) return m[1];
		}
		return null;
	};
	const lineOf = (charIdx) => {
		let pos = 0;
		for (let i = 0; i < lines.length; i++) {
			if (pos + lines[i].length + 1 > charIdx) return i;
			pos += lines[i].length + 1;
		}
		return lines.length - 1;
	};
	for (const { kind, re } of SINK_PATTERNS) {
		const gre = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
		let m, count = 0;
		while ((m = gre.exec(content)) !== null && count < 2) {
			const lineIdx = lineOf(m.index);
			sites.push({
				kind, line: lineIdx + 1,
				snippet: (lines[lineIdx] || "").trim().slice(0, 140),
				inFunction: findEnclosingFunction(lineIdx),
			});
			count++;
		}
	}
	return sites;
}

// Side-effect / sink detection — classify what a module *does* in the world
const SINK_PATTERNS = [
	{ kind: "fs:write", re: /\bfs(?:Promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync|symlink|symlinkSync|chmod|chmodSync)\b/ },
	{ kind: "fs:read",  re: /\bfs(?:Promises)?\.(?:readFile|readFileSync|readdir|readdirSync|stat|statSync|access|accessSync|createReadStream)\b/ },
	{ kind: "net:fetch", re: /\b(?:fetch|axios\.(?:get|post|put|delete|patch|request)|undici|got\.(?:get|post))\s*\(/ },
	{ kind: "net:http",  re: /\b(?:https?\.request|https?\.get)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b/ },
	{ kind: "db:sql",    re: /\b(?:pool\.query|client\.query|db\.query|knex\(|sequelize\.|pg\.Pool|new\s+Pool|drizzle\()/ },
	{ kind: "db:orm",    re: /\b(?:prisma|mongoose|typeorm|drizzle)\.[\w$]+\.(?:create|update|delete|upsert|findMany|findFirst|findUnique|insertMany|deleteMany|updateMany|aggregate)\b/ },
	{ kind: "cli:io",    re: /\bprocess\.(?:stdout|stderr)\.(?:write|on)\b|\bconsole\.(?:log|error|warn|info)\b/ },
	{ kind: "process:exec", re: /\b(?:execSync|execFileSync|spawnSync|spawn|execFile|fork)\s*\(/ },
	{ kind: "process:exit", re: /\bprocess\.exit\s*\(/ },
	{ kind: "ai:call",   re: /\bnew\s+(?:Anthropic|OpenAI)\s*\(|\b(?:anthropic|openai|claude)\.(?:messages|chat|completions|complete|stream|create|invoke|generate)\b|@anthropic-ai\/sdk|@google\/generative-ai/i },
	{ kind: "env:read",  re: /\bprocess\.env\.[A-Z_]+/ },
];

function visDetectSinks(content) {
	const out = new Set();
	for (const { kind, re } of SINK_PATTERNS) {
		if (re.test(content)) out.add(kind);
	}
	return [...out];
}

// HTTP route detection — common Express/Koa/Fastify/Hono/Nest/etc.
const ROUTE_PATTERNS = [
	{ re: /\b(?:app|router|server|fastify|hono|api)\s*\.\s*(get|post|put|delete|patch|all|use|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/gi, methodIdx: 1, pathIdx: 2 },
	{ re: /@(Get|Post|Put|Delete|Patch|All)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, methodIdx: 1, pathIdx: 2 },
];
function visDetectRoutes(content) {
	const out = [];
	for (const { re, methodIdx, pathIdx } of ROUTE_PATTERNS) {
		let m; re.lastIndex = 0;
		while ((m = re.exec(content)) !== null) {
			out.push({ method: m[methodIdx].toUpperCase(), path: m[pathIdx] });
			if (out.length > 40) break;
		}
	}
	return out;
}

// Layer heuristic — uses path + sinks to classify a module
function visClassifyLayer(rel, sinks, hasRoutes, isBin, isExport) {
	const p = rel.toLowerCase();
	if (isBin || /\/(cli|bin|main)\.(?:ts|js|mjs|cjs)$/.test("/" + p) || /(^|\/)(cli|bin)\//.test(p)) return "presentation";
	if (hasRoutes || /(^|\/)(routes|handlers|controllers|api|http|server)\//.test(p)) return "presentation";
	if (/(^|\/)(domain|entities|aggregates|models|value-objects)\//.test(p)) return "domain";
	if (/(^|\/)(services|use[-_]?cases|application|workflows|commands|handlers|tools|features|modules)\//.test(p)) return "application";
	const isInfraSink = sinks.some((s) => s.startsWith("db:") || s.startsWith("net:") || s === "fs:write" || s.startsWith("process:exec"));
	if (isInfraSink) return "infrastructure";
	if (/(^|\/)(utils|helpers|lib|shared|common|types?|core)\//.test(p) && !isExport) return "support";
	if (isExport) return "application";
	return "support";
}

function visIsTest(rel) {
	return /(^|\/)(test|tests|__tests__|spec)\//.test(rel)
		|| /\.(test|spec)\.[a-z]+$/.test(rel);
}

// Discover workspace glob patterns from any of: pnpm-workspace.yaml,
// root package.json `workspaces`, lerna.json `packages`. Returns
// an array of glob strings (no leading `./`). Falls back to ["packages/*"]
// when no manifest is found, so legacy monorepos still work.
function visDiscoverWorkspacePatterns(root) {
	const patterns = new Set();
	// 1) pnpm-workspace.yaml
	try {
		const yamlPath = path.join(root, "pnpm-workspace.yaml");
		if (fs.existsSync(yamlPath)) {
			const text = fs.readFileSync(yamlPath, "utf-8");
			let inPackages = false;
			for (const rawLine of text.split("\n")) {
				const line = rawLine.replace(/\r$/, "");
				if (/^packages\s*:\s*(?:#.*)?$/.test(line)) { inPackages = true; continue; }
				if (!inPackages) continue;
				if (/^\S/.test(line) && !/^\s*-/.test(line)) { inPackages = false; continue; }
				const m = line.match(/^\s*-\s*['"]?([^'"\s#]+)['"]?/);
				if (m) patterns.add(m[1].replace(/^\.\//, "").replace(/\/$/, ""));
			}
		}
	} catch { /* empty */ }
	// 2) root package.json `workspaces`
	try {
		const rootPkgPath = path.join(root, "package.json");
		if (fs.existsSync(rootPkgPath)) {
			const pj = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
			const w = pj.workspaces;
			const list = Array.isArray(w) ? w : (w && Array.isArray(w.packages) ? w.packages : []);
			for (const p of list) {
				if (typeof p === "string") patterns.add(p.replace(/^\.\//, "").replace(/\/$/, ""));
			}
		}
	} catch { /* empty */ }
	// 3) lerna.json
	try {
		const lernaPath = path.join(root, "lerna.json");
		if (fs.existsSync(lernaPath)) {
			const lj = JSON.parse(fs.readFileSync(lernaPath, "utf-8"));
			for (const p of (lj.packages || [])) {
				if (typeof p === "string") patterns.add(p.replace(/^\.\//, "").replace(/\/$/, ""));
			}
		}
	} catch { /* empty */ }
	// 4) Sensible default if none of the above declared a workspace layout
	if (patterns.size === 0) patterns.add("packages/*");
	return [...patterns];
}

// Expand a glob pattern (e.g., "packages/*", "apps/*", "packages/functions/*",
// "openauthjs/packages/*", "packages/**") rooted at `root` into a list of absolute
// package.json paths. Supports `*` (single segment) and `**` (recursive descent).
function visExpandWorkspacePattern(root, pattern) {
	// Strip trailing /package.json if a manifest used "apps/*/package.json"
	pattern = pattern.replace(/\/package\.json$/, "");
	const segments = pattern.split("/").filter(Boolean);
	const out = [];
	const visit = (currentPath, remaining) => {
		if (remaining.length === 0) {
			const pj = path.join(currentPath, "package.json");
			if (fs.existsSync(pj)) out.push(pj);
			return;
		}
		let stat;
		try { stat = fs.statSync(currentPath); } catch { return; }
		if (!stat.isDirectory()) return;
		const [next, ...rest] = remaining;
		if (next === "*") {
			let entries;
			try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				if (VIS_DEFAULT_IGNORES.has(e.name)) continue;
				if (e.name.startsWith(".") && !["..", "."].includes(e.name)) continue;
				visit(path.join(currentPath, e.name), rest);
			}
		} else if (next === "**") {
			// Match this depth too (zero or more directories)
			visit(currentPath, rest);
			let entries;
			try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				if (VIS_DEFAULT_IGNORES.has(e.name)) continue;
				if (e.name.startsWith(".")) continue;
				visit(path.join(currentPath, e.name), remaining); // keep ** alive
			}
		} else if (next.includes("*")) {
			// Partial-wildcard segment ("foo-*", "*.bar") — match by regex
			const re = new RegExp("^" + next.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
			let entries;
			try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); } catch { return; }
			for (const e of entries) {
				if (!e.isDirectory()) continue;
				if (VIS_DEFAULT_IGNORES.has(e.name)) continue;
				if (!re.test(e.name)) continue;
				visit(path.join(currentPath, e.name), rest);
			}
		} else {
			// Literal segment
			visit(path.join(currentPath, next), rest);
		}
	};
	visit(root, segments);
	return out;
}

function visScanPackages(root) {
	const pkgs = [];
	const seen = new Set();
	// Always include root manifest
	const rootPj = path.join(root, "package.json");
	if (fs.existsSync(rootPj)) seen.add(rootPj);
	// Expand all workspace patterns
	const patterns = visDiscoverWorkspacePatterns(root);
	const candidates = fs.existsSync(rootPj) ? [rootPj] : [];
	for (const pat of patterns) {
		const isNegated = pat.startsWith("!");
		if (isNegated) continue; // pnpm/npm support negations; ignore for simplicity (rare in practice)
		const found = visExpandWorkspacePattern(root, pat);
		for (const f of found) {
			if (!seen.has(f)) { seen.add(f); candidates.push(f); }
		}
	}
	for (const p of candidates) {
		try {
			const j = JSON.parse(fs.readFileSync(p, "utf-8"));
			pkgs.push({
				name: j.name || path.basename(path.dirname(p)),
				version: j.version || null,
				path: path.relative(root, path.dirname(p)) || ".",
				description: j.description || null,
				dependencies: Object.keys(j.dependencies || {}),
				devDependencies: Object.keys(j.devDependencies || {}),
				peerDependencies: Object.keys(j.peerDependencies || {}),
				workspaceDeps: Object.entries(j.dependencies || {})
					.filter(([, v]) => typeof v === "string" && v.startsWith("workspace:"))
					.map(([k]) => k),
				workspacePatterns: p === rootPj ? patterns : undefined,
			});
		} catch { /* empty */ }
	}
	return pkgs;
}

function visReadPlanning(root) {
	const planning = path.join(root, PLANNING_DIR);
	const out = { state: null, roadmap: null, project: null, domain: null };
	const tryRead = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
	out.state = tryRead(path.join(planning, "STATE.md"));
	out.roadmap = tryRead(path.join(planning, "ROADMAP.md"));
	out.project = tryRead(path.join(planning, "PROJECT.md"));
	out.domain = tryRead(path.join(planning, "DOMAIN.md")) || tryRead(path.join(planning, "DOMAIN-MODEL.md"));
	return out;
}

// ── Knowledge-graph enrichment (graphify-style: rationale, symbols, clusters, surprises) ──

// Inline rationale markers — design intent captured in comments (graphify NOTE/WHY/HACK nodes).
const RATIONALE_TAG_RE = /\b(SECURITY|BUG|FIXME|HACK|XXX|TODO|WARNING|GOTCHA|PERF|NOTE|WHY)\b\s*[:\-]?\s*(.+)/;
const RATIONALE_SEVERITY = { SECURITY: 0, BUG: 1, FIXME: 2, HACK: 3, XXX: 4, WARNING: 5, GOTCHA: 6, PERF: 7, TODO: 8, NOTE: 9, WHY: 10 };
const COMMENT_STYLE = {
	typescript: { line: "//", block: ["/*", "*/"] }, javascript: { line: "//", block: ["/*", "*/"] },
	go: { line: "//", block: ["/*", "*/"] }, rust: { line: "//", block: ["/*", "*/"] },
	java: { line: "//", block: ["/*", "*/"] }, kotlin: { line: "//", block: ["/*", "*/"] },
	swift: { line: "//", block: ["/*", "*/"] }, csharp: { line: "//", block: ["/*", "*/"] },
	c: { line: "//", block: ["/*", "*/"] }, cpp: { line: "//", block: ["/*", "*/"] },
	php: { line: "//", block: ["/*", "*/"] }, sql: { line: "--", block: ["/*", "*/"] },
	python: { line: "#" }, shell: { line: "#" }, ruby: { line: "#" },
	html: { block: ["<!--", "-->"] }, markdown: { block: ["<!--", "-->"] },
};

// Extract comment TEXT (inverse of the strip logic) so the tag regex never matches code/strings.
function visExtractComments(content, language) {
	const s = COMMENT_STYLE[language];
	if (!s) return [];
	const out = [];
	const lines = content.split("\n");
	let inBlock = false, close = null;
	for (let i = 0; i < lines.length && out.length < 400; i++) {
		let ln = lines[i];
		if (inBlock) {
			const ci = ln.indexOf(close);
			if (ci < 0) { out.push({ line: i + 1, text: ln }); continue; }
			out.push({ line: i + 1, text: ln.slice(0, ci) });
			ln = ln.slice(ci + close.length); inBlock = false; close = null;
		}
		if (s.line) {
			let idx = ln.indexOf(s.line);
			while (idx > 0 && s.line === "//" && ln[idx - 1] === ":") idx = ln.indexOf(s.line, idx + 2); // skip http://
			if (idx >= 0) { out.push({ line: i + 1, text: ln.slice(idx + s.line.length) }); ln = ln.slice(0, idx); }
		}
		if (s.block) {
			const [open, cl] = s.block;
			const oi = ln.indexOf(open);
			if (oi >= 0) {
				const ci = ln.indexOf(cl, oi + open.length);
				if (ci >= 0) out.push({ line: i + 1, text: ln.slice(oi + open.length, ci) });
				else { out.push({ line: i + 1, text: ln.slice(oi + open.length) }); inBlock = true; close = cl; }
			}
		}
	}
	return out;
}

function visExtractRationale(content, language, rel) {
	const out = [];
	for (const c of visExtractComments(content, language)) {
		const m = RATIONALE_TAG_RE.exec(c.text);
		if (m && m[2].trim()) { out.push({ file: rel, line: c.line, tag: m[1], text: m[2].trim().slice(0, 120) }); if (out.length >= 30) break; }
	}
	return out;
}

// Symbol-level nodes: exported symbols (already have line) + best-effort non-exported top-level decls.
function visBuildSymbols(exportsArr, content, language) {
	const syms = [];
	const seen = new Set();
	for (const e of exportsArr) {
		if (seen.has(e.name)) continue;
		seen.add(e.name);
		syms.push({ name: e.name, kind: e.kind, line: e.line, exported: true });
		if (syms.length >= 60) return syms;
	}
	const lines = content.split("\n");
	const addDecl = (re, kindOf) => {
		for (let i = 0; i < lines.length; i++) {
			const m = re.exec(lines[i]);
			if (m) { const name = m[1] || m[2]; if (name && !seen.has(name)) { seen.add(name); syms.push({ name, kind: kindOf(lines[i]), line: i + 1, exported: false }); if (syms.length >= 60) return true; } }
		}
		return false;
	};
	if (language === "typescript" || language === "javascript") {
		addDecl(/^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, (l) => /^\s*(?:async\s+)?class\b/.test(l) ? "class" : /^\s*(?:async\s+)?function\b/.test(l) ? "function" : "const");
	} else if (language === "python") {
		addDecl(/^(?:class|def)\s+([A-Za-z_][\w]*)/, (l) => /^class\b/.test(l) ? "class" : "def");
	} else if (language === "go") {
		addDecl(/^func\s+(?:\([^)]*\)\s+)?([a-z][\w]*)|^type\s+([a-z][\w]*)/, (l) => /^func\b/.test(l) ? "func" : "type");
	} else if (language === "rust") {
		addDecl(/^\s*(?:fn|struct|enum|trait)\s+([A-Za-z_][\w]*)/, () => "rust-item");
	}
	return syms;
}

// Deterministic structural clusters via async label propagation over the undirected import graph.
function visComputeClusters(modules, edges, moduleByRel, containerOf) {
	const adj = new Map();
	const link = (a, b) => { if (a === b) return; if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
	for (const e of edges) {
		if (e.kind !== "import") continue;
		if (!moduleByRel.has(e.from) || !moduleByRel.has(e.to)) continue;
		link(e.from, e.to); link(e.to, e.from);
	}
	const ids = modules.map((m) => m.id).sort();
	const label = new Map(ids.map((id) => [id, id]));
	for (let pass = 0; pass < 10; pass++) {
		let changed = false;
		for (const id of ids) { // async: later nodes this pass see earlier updates
			const nbrs = adj.get(id);
			if (!nbrs || nbrs.size === 0) continue;
			const freq = new Map();
			for (const n of nbrs) { const l = label.get(n); freq.set(l, (freq.get(l) || 0) + 1); }
			let best = label.get(id), bestC = -1;
			for (const [l, c] of freq) { if (c > bestC || (c === bestC && l < best)) { best = l; bestC = c; } }
			if (best !== label.get(id)) { label.set(id, best); changed = true; }
		}
		if (!changed) break;
	}
	const byLabel = new Map();
	for (const id of ids) {
		const m = moduleByRel.get(id);
		const hasEdges = adj.has(id) && adj.get(id).size > 0;
		const key = hasEdges ? label.get(id) : containerOf(m); // unlinked modules → package cluster
		if (!byLabel.has(key)) byLabel.set(key, []);
		byLabel.get(key).push(id);
	}
	// Monster-community guard: if one cluster swallows >50% of non-test modules, fall back to packages.
	const nonTest = modules.filter((m) => !m.isTest).length || 1;
	const maxSize = Math.max(0, ...[...byLabel.values()].map((v) => v.length));
	let groupsMap = byLabel;
	if (maxSize > nonTest * 0.5) {
		groupsMap = new Map();
		for (const m of modules) { const k = containerOf(m); if (!groupsMap.has(k)) groupsMap.set(k, []); groupsMap.get(k).push(m.id); }
	}
	const clusters = [];
	const clusterOf = new Map();
	for (const members of groupsMap.values()) {
		const sorted = members.slice().sort();
		const cid = "cluster:" + sorted[0];
		const pkgCount = {}, layerCount = {};
		for (const id of sorted) { const m = moduleByRel.get(id); const p = m.package || containerOf(m).replace(/^dir:/, ""); pkgCount[p] = (pkgCount[p] || 0) + 1; layerCount[m.layer] = (layerCount[m.layer] || 0) + 1; }
		const dominantPackage = Object.keys(pkgCount).sort((a, b) => pkgCount[b] - pkgCount[a] || (a < b ? -1 : 1))[0] || null;
		const dominantLayer = Object.keys(layerCount).sort((a, b) => layerCount[b] - layerCount[a] || (a < b ? -1 : 1))[0] || "support";
		const packages = Object.keys(pkgCount).sort();
		const clabel = packages.length === 1 ? String(dominantPackage).replace(/^@[^/]+\//, "") : (sorted[0].split("/")[0] + " · " + dominantLayer);
		for (const id of sorted) clusterOf.set(id, cid);
		clusters.push({ id: cid, label: clabel, size: sorted.length, members: sorted, dominantPackage, dominantLayer, packages });
	}
	clusters.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
	return { clusters, clusterOf };
}

// Surprising connections: import edges that bridge distant clusters / violate layering / cross groups.
const LAYER_RANK_INWARD = { presentation: 0, application: 1, domain: 2, infrastructure: 3 };
function visComputeSurprising(edges, callEdges, moduleByRel, clusterOf, groupOfContainer, containerOf) {
	const pairCount = new Map(); // O(E) cluster-pair index → O(1) bridge test
	for (const e of edges) {
		if (e.kind !== "import") continue;
		const ca = clusterOf.get(e.from), cb = clusterOf.get(e.to);
		if (!ca || !cb || ca === cb) continue;
		const k = ca + "|" + cb; pairCount.set(k, (pairCount.get(k) || 0) + 1);
	}
	const callSym = new Map();
	for (const ce of callEdges) { const k = ce.from + "|" + ce.to; if (!callSym.has(k)) callSym.set(k, []); if (callSym.get(k).length < 4 && !callSym.get(k).includes(ce.symbol)) callSym.get(k).push(ce.symbol); }
	const out = [];
	const seen = new Set();
	for (const e of edges) {
		if (e.kind !== "import") continue;
		const a = moduleByRel.get(e.from), b = moduleByRel.get(e.to);
		if (!a || !b) continue;
		const ca = clusterOf.get(e.from), cb = clusterOf.get(e.to);
		if (!ca || !cb || ca === cb) continue;
		const pk = e.from + "→" + e.to;
		if (seen.has(pk)) continue;
		seen.add(pk);
		let score = 0; const reasons = [];
		const la = LAYER_RANK_INWARD[a.layer], lb = LAYER_RANK_INWARD[b.layer];
		if (la != null && lb != null && la > lb) { score += 2; reasons.push(a.layer + "→" + b.layer + " (outward)"); }
		if ((pairCount.get(ca + "|" + cb) || 0) <= 1) { score += 2; reasons.push("bridge"); }
		const ga = groupOfContainer.get(containerOf(a)), gb = groupOfContainer.get(containerOf(b));
		if (ga && gb && ga !== gb) { score += 1; reasons.push("cross-group"); }
		if (score <= 0) continue;
		out.push({ from: e.from, to: e.to, score, reason: reasons.join(", "), sampleSymbols: callSym.get(e.from + "|" + e.to) || [] });
	}
	out.sort((x, y) => y.score - x.score || (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
	return out.slice(0, 20);
}

function visBuildMap(root) {
	const startedAt = Date.now();
	const files = visWalk(root);
	const pkgs = visScanPackages(root);
	const planning = visReadPlanning(root);

	// Build bin-file set: package.json `bin` entries → CLI entry points.
	// Bin / main paths often point to compiled output (dist/X.js) that's filtered out of the
	// scanned tree. Register source-tree fallbacks (src/X.{ts,tsx,js,mjs,cjs}) so the actual
	// source file gets recognized as the entry point at scan time.
	const binFiles = new Map(); // rel path → cli name
	const COMPILED_SEGMENT_RE = /(?:^|\/)(?:dist|build|lib|out)\//;
	const SOURCE_EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
	const registerBinPath = (rel, name, prefix) => {
		const fullKey = (prefix || "") + rel;
		binFiles.set(fullKey, name);
		// Source-tree fallback: dist/<stem>.{js,mjs,cjs} → src/<stem>.{ts,tsx,js,mjs,cjs}
		if (COMPILED_SEGMENT_RE.test(rel)) {
			const srcStem = rel.replace(COMPILED_SEGMENT_RE, (s) => s.replace(/(?<=\/|^)(dist|build|lib|out)\//, "src/")).replace(/\.(js|mjs|cjs)$/, "");
			for (const ext of SOURCE_EXTS) {
				const altRel = srcStem + ext;
				if (!binFiles.has((prefix || "") + altRel)) {
					binFiles.set((prefix || "") + altRel, name);
				}
			}
		}
	};
	for (const p of pkgs) {
		const pkgDir = p.path === "." ? "" : p.path;
		const pkgJsonPath = path.join(root, pkgDir, "package.json");
		try {
			const pj = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
			const bin = pj.bin;
			if (typeof bin === "string") {
				const rel = path.posix.join(pkgDir, bin).replace(/^\.\//, "");
				registerBinPath(rel, pj.name);
			} else if (bin && typeof bin === "object") {
				for (const [name, file] of Object.entries(bin)) {
					if (typeof file !== "string") continue;
					const rel = path.posix.join(pkgDir, file).replace(/^\.\//, "");
					registerBinPath(rel, name);
				}
			}
			if (pj.main) {
				const rel = path.posix.join(pkgDir, pj.main).replace(/^\.\//, "");
				registerBinPath(rel, "main:" + pj.name, "__main__:");
			}
		} catch { /* empty */ }
	}

	const langCounts = {};
	const modules = [];
	const moduleByRel = new Map();
	const totalLoc = { value: 0 };
	// Per-module rich data
	const perFile = new Map();
	const rationaleAll = []; // graphify-style inline rationale (NOTE/WHY/HACK/…) across all files

	for (const abs of files) {
		const rel = path.relative(root, abs).split(path.sep).join("/");
		const lang = visLangFor(abs);
		langCounts[lang] = (langCounts[lang] || 0) + 1;
		let size = 0, loc = 0;
		let parsedImports = [], exports = [], sinks = [], routes = [], sinkSites = [], symbols = [];
		let content = "";
		try {
			const stat = fs.statSync(abs);
			size = stat.size;
			if (size < 1024 * 1024 && lang !== "other") {
				content = fs.readFileSync(abs, "utf-8");
				loc = content.split("\n").length;
				totalLoc.value += loc;
				if (VIS_CODE_LANGS.has(lang)) {
					// Use raw content for export/JSDoc extraction (need comments) and stripped for sink/import detection
					const stripped = content
						.replace(/\/\*[\s\S]*?\*\//g, "")
						.replace(/(^|[^:])\/\/.*$/gm, "$1");
					parsedImports = visParseImports(stripped, lang);
					exports = visExtractExports(content, lang);
					sinks = visDetectSinks(stripped);
					sinkSites = visFindSinkSites(content, lang);
					routes = visDetectRoutes(stripped);
					symbols = visBuildSymbols(exports, content, lang); // symbol-level nodes (from untruncated exports + decls)
				}
				// Inline rationale works for any commented language (incl. markdown), not just code langs.
				for (const r of visExtractRationale(content, lang, rel)) rationaleAll.push(r);
			}
		} catch { /* empty */ }

		const isTest = visIsTest(rel);
		const pkg = pkgs.find((p) => p.path !== "." && rel.startsWith(p.path + "/"))?.name
			|| (pkgs[0]?.path === "." ? pkgs[0].name : null);
		const isBin = binFiles.has(rel);

		const m = {
			id: rel,
			path: rel,
			language: lang,
			size,
			loc,
			isTest,
			package: pkg,
			exports: exports.slice(0, 30),
			symbols,
			sinks,
			sinkSites: sinkSites.slice(0, 10),
			routes: routes.slice(0, 20),
			entryPoint: null,
		};
		if (isBin) {
			m.entryPoint = { kind: "cli", name: binFiles.get(rel) };
		} else if (routes.length > 0 && !isTest) {
			m.entryPoint = { kind: "http", routes: routes.slice(0, 8) };
		}
		// Mark package main exports as library entry points
		const mainKey = "__main__:" + rel;
		if (binFiles.has(mainKey)) {
			m.entryPoint = m.entryPoint || { kind: "library", name: binFiles.get(mainKey).replace(/^main:/, "") };
		}
		m.layer = visClassifyLayer(rel, sinks, routes.length > 0, isBin, exports.length > 0);
		modules.push(m);
		moduleByRel.set(rel, m);
		perFile.set(rel, { parsedImports, content, stripped: content });
	}

	// Resolve local imports → edges with symbol-level dataflow
	const tsLikeExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
	const tsxIndexExts = tsLikeExts;
	const edges = [];
	const callEdges = []; // { from, to, symbol }

	// Build workspace-package → entry-file lookup so cross-package imports become real edges
	const workspaceEntryByName = new Map();
	for (const p of pkgs) {
		const pkgDir = p.path === "." ? "" : p.path;
		const pkgJsonPath = path.join(root, pkgDir, "package.json");
		try {
			const pj = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
			const candidates = [];
			if (pj.main) candidates.push(pj.main);
			if (pj.module) candidates.push(pj.module);
			if (pj.exports) {
				const collect = (v) => {
					if (typeof v === "string") candidates.push(v);
					else if (v && typeof v === "object") for (const k of Object.values(v)) collect(k);
				};
				collect(pj.exports);
			}
			// Also try src/index.{ts,js}
			candidates.push("src/index.ts", "src/index.js", "index.ts", "index.js");
			let entry = null;
			for (const c of candidates) {
				if (typeof c !== "string") continue;
				const rel = path.posix.normalize(path.posix.join(pkgDir, c.replace(/^\.\//, ""))).replace(/\.\.\//g, "");
				for (const ext of ["", ...tsLikeExts]) {
					const r = ext ? rel.replace(/\.[^/.]+$/, "") + ext : rel;
					if (moduleByRel.has(r)) { entry = r; break; }
				}
				if (entry) break;
				// Try as-is
				if (moduleByRel.has(rel)) { entry = rel; break; }
			}
			if (entry) workspaceEntryByName.set(pj.name, entry);
		} catch { /* empty */ }
	}

	const resolveSpec = (fromDir, spec) => {
		// Relative path
		if (spec.startsWith(".") || spec.startsWith("/")) {
			const base = path.posix.normalize(path.posix.join(fromDir, spec));
			// Build stem candidates: original, plus extension-stripped (NodeNext: ./foo.js → ./foo.ts on disk)
			const stems = [base];
			if (/\.(js|mjs|cjs|jsx)$/.test(base)) {
				stems.push(base.replace(/\.(js|mjs|cjs|jsx)$/, ""));
			}
			for (const stem of stems) {
				for (const ext of ["", ...tsLikeExts]) {
					const c = ext ? stem + ext : stem;
					if (moduleByRel.has(c)) return c;
				}
				for (const ext of tsxIndexExts) {
					const c = path.posix.join(stem, "index" + ext);
					if (moduleByRel.has(c)) return c;
				}
			}
			return null;
		}
		// Workspace package: try exact match, then with subpath
		if (workspaceEntryByName.has(spec)) return workspaceEntryByName.get(spec);
		const slash = spec.indexOf("/", spec.startsWith("@") ? spec.indexOf("/") + 1 : 0);
		if (slash > 0) {
			const pkgName = spec.slice(0, slash);
			if (workspaceEntryByName.has(pkgName)) return workspaceEntryByName.get(pkgName);
		}
		return null;
	};

	for (const m of modules) {
		if (m.language !== "typescript" && m.language !== "javascript") continue;
		const fromDir = path.posix.dirname(m.path);
		const file = perFile.get(m.path);
		if (!file) continue;
		const usedLocals = new Map(); // local name -> { resolved, importedName }
		for (const imp of file.parsedImports) {
			const resolved = resolveSpec(fromDir, imp.specifier);
			if (!resolved) {
				edges.push({ from: m.id, to: imp.specifier, kind: "external", confidence: "EXTRACTED", resolved: false });
				continue;
			}
			edges.push({ from: m.id, to: resolved, kind: imp.reExport ? "re-export" : "import", confidence: "EXTRACTED" });
			// Re-exports don't introduce local usage — they pass the symbol through to the
			// importer of THIS module. We capture them separately for re-export traversal in flow BFS.
			if (imp.reExport) continue;
			if (imp.default) usedLocals.set(imp.default, { resolved, importedName: "default" });
			if (imp.namespace) usedLocals.set(imp.namespace, { resolved, importedName: "*" });
			for (const n of imp.names || []) {
				usedLocals.set(n.local, { resolved, importedName: n.imported });
			}
		}
		// For each imported local, scan for call sites: `localName(` or `localName.x(` (member call)
		if (usedLocals.size > 0) {
			const text = file.content || "";
			for (const [local, ref] of usedLocals) {
				const safe = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const callRe = new RegExp("\\b" + safe + "\\s*(?:\\.[A-Za-z_$][\\w$]*\\s*)?\\(", "g");
				let count = 0;
				while (callRe.exec(text)) { count++; if (count > 100) break; }
				if (count > 0) {
					// INFERRED: regex call-site heuristic. AMBIGUOUS when only ever member-called (x.y()) —
					// the called member is not necessarily the imported symbol.
					const directRe = new RegExp("\\b" + safe + "\\s*\\(", "g");
					const confidence = directRe.test(text) ? "INFERRED" : "AMBIGUOUS";
					callEdges.push({ from: m.id, to: ref.resolved, symbol: ref.importedName, count, confidence });
				}
			}
		}
	}

	// Containers: prefer packages; fall back to top-level dirs
	const containers = [];
	if (pkgs.length > 1) {
		for (const p of pkgs) {
			if (p.path === ".") continue;
			containers.push({
				id: "pkg:" + p.name,
				name: p.name,
				path: p.path,
				kind: "package",
				description: p.description,
				moduleCount: modules.filter((m) => m.path.startsWith(p.path + "/")).length,
			});
		}
	} else {
		const topDirs = new Set();
		for (const m of modules) {
			const first = m.path.split("/")[0];
			if (first && !first.includes(".")) topDirs.add(first);
		}
		for (const d of topDirs) {
			containers.push({
				id: "dir:" + d, name: d, path: d, kind: "directory", description: null,
				moduleCount: modules.filter((m) => m.path.startsWith(d + "/")).length,
			});
		}
	}
	const containerOf = (m) => {
		if (m.package) return "pkg:" + m.package;
		const first = m.path.split("/")[0];
		return "dir:" + first;
	};

	// Functional groups (CodeViz-style nested containers)
	const groups = applyGroupsCuration(deriveGroups(containers, pkgs, root), root);

	// In-degree / out-degree maps from import edges — used for "top files" ranking.
	const inDeg = new Map();
	const outDeg = new Map();
	for (const e of edges) {
		if (e.kind !== "import") continue;
		outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
		inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
	}
	// Non-test degree (excludes test-originated edges) — for god-node / hotspot ranking, so test
	// fixtures don't inflate "most depended-on".
	const inDegNT = new Map();
	const outDegNT = new Map();
	for (const e of edges) {
		if (e.kind !== "import") continue;
		const fm = moduleByRel.get(e.from);
		if (fm && fm.isTest) continue;
		outDegNT.set(e.from, (outDegNT.get(e.from) || 0) + 1);
		inDegNT.set(e.to, (inDegNT.get(e.to) || 0) + 1);
	}

	function computeTopFiles(container) {
		const mods = modules.filter((m) => containerOf(m) === container.id && !m.isTest);
		if (mods.length === 0) return [];
		const medianLoc = (() => {
			const arr = mods.map((m) => m.loc || 0).sort((a, b) => a - b);
			return arr[Math.floor(arr.length / 2)] || 0;
		})();
		const scored = mods.map((m) => {
			let score = 0;
			if (m.entryPoint) score += 6;
			if (m.routes && m.routes.length > 0) score += 3;
			score += Math.log2(1 + (m.loc || 0));
			score += Math.log2(1 + (outDeg.get(m.id) || 0));
			score += Math.log2(1 + (inDeg.get(m.id) || 0));
			if (/\/index\.(?:ts|tsx|js|mjs|cjs)$/.test(m.path)) score += 4;
			if ((m.exports || []).some((e) => e.doc)) score += 2;
			// Reason label
			let reason = "core file";
			if (m.entryPoint) {
				reason = m.entryPoint.kind === "cli" ? "CLI entry"
					: m.entryPoint.kind === "http" ? "HTTP handler"
					: "library entry";
			} else if (m.routes && m.routes.length > 0) reason = "HTTP handler";
			else if (/\/index\.(?:ts|tsx|js|mjs|cjs)$/.test(m.path)) reason = "package index";
			else if ((inDeg.get(m.id) || 0) >= 3) reason = "most depended-on";
			else if ((outDeg.get(m.id) || 0) >= 8) reason = "orchestrator";
			else if ((m.loc || 0) > medianLoc * 1.5) reason = "largest";
			return { path: m.path, reason, score: +score.toFixed(2), loc: m.loc || 0 };
		});
		scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const cap = mods.length < 6 ? 3 : 5;
		return scored.slice(0, cap);
	}

	for (const c of containers) {
		c.topFiles = computeTopFiles(c);
	}

	// Cross-container edges (collapsed dataflow at the architecture level)
	const containerEdgeMap = new Map(); // "from→to" -> { from, to, count, symbolFreq }
	for (const e of edges) {
		if (e.kind !== "import") continue;
		const a = moduleByRel.get(e.from), b = moduleByRel.get(e.to);
		if (!a || !b) continue;
		const ca = containerOf(a), cb = containerOf(b);
		if (ca === cb) continue;
		const key = ca + "→" + cb;
		if (!containerEdgeMap.has(key)) containerEdgeMap.set(key, { from: ca, to: cb, count: 0, symbolFreq: new Map(), callCount: 0 });
		containerEdgeMap.get(key).count++;
	}
	// Layer in symbol-level call data
	for (const ce of callEdges) {
		const a = moduleByRel.get(ce.from), b = moduleByRel.get(ce.to);
		if (!a || !b) continue;
		const ca = containerOf(a), cb = containerOf(b);
		if (ca === cb) continue;
		const key = ca + "→" + cb;
		const agg = containerEdgeMap.get(key);
		if (!agg) continue;
		agg.callCount += ce.count || 1;
		agg.symbolFreq.set(ce.symbol, (agg.symbolFreq.get(ce.symbol) || 0) + (ce.count || 1));
	}

	// Classify each container edge with a relationship verb (CodeViz-style labels)
	const pkgHasReactDep = (pkgName) => {
		const p = pkgs.find((x) => x.name === pkgName);
		if (!p) return false;
		const deps = (p.dependencies || []).concat(p.peerDependencies || []);
		return deps.some((d) => /^(react|preact|solid-js|svelte)$/.test(d));
	};
	function classifyContainerEdge(edge) {
		const symbols = [...edge.symbolFreq.keys()];
		const symbolSamples = [...edge.symbolFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
		const toPkgName = edge.to.replace(/^pkg:/, "");
		const labels = [];
		const matchesAny = (re) => symbols.some((s) => re.test(s));
		const matchesAll = (re) => symbols.length > 0 && symbols.every((s) => re.test(s));

		// Priority-ordered detection
		// 1. Renders — uppercase exports + React-ish callee
		if (pkgHasReactDep(toPkgName) && symbols.some((s) => /^[A-Z]/.test(s))) labels.push("Renders");
		// 2. Sends Events
		if (matchesAny(/^(emit|dispatch|publish|broadcast|notify|fire|trigger)|sendEvent|EventBus|EventEmitter|MessageBus|^bus$|^events?$|subscribe|onEvent/i)) labels.push("Sends Events");
		// 3. Persists — callee has FS-write/db sinks
		const toMods = modules.filter((m) => containerOf(m) === edge.to);
		const toSinks = new Set();
		for (const m of toMods) for (const s of (m.sinks || [])) toSinks.add(s);
		if (toSinks.has("fs:write") || toSinks.has("db:sql") || toSinks.has("db:orm")) labels.push("Persists");
		// 4. Updates
		if (matchesAny(/^(set|update|mutate|patch|put|replace|remove|delete)[A-Z]|^use[A-Z]\w*State$/)) labels.push("Updates");
		// 5. Reads State (excluded if Updates already matched)
		if (!labels.includes("Updates") && matchesAny(/^(get|read|fetch|load|find|list|query|select)[A-Z]/)) labels.push("Reads State");
		// 6. Configures
		if (matchesAny(/^(config|configure|setup|init|initialize|register|bootstrap|provide|wire)/i)) labels.push("Configures");
		// 7. Analyzes
		if (matchesAny(/^(analyz|inspect|check|validat|verify|audit|lint|scan)/i)) labels.push("Analyzes");
		// 8. Executes Actions
		if (matchesAny(/^(run|exec|execute|invoke|perform|do[A-Z])/i)) labels.push("Executes Actions");
		// 9. Uses — type-only or sparse
		if (edge.callCount === 0 || symbols.length < 3) labels.push("Uses");
		// 10. Calls — fallback
		if (labels.length === 0) labels.push("Calls");
		return { label: labels[0], labels, symbolSamples };
	}
	for (const edge of containerEdgeMap.values()) {
		const classification = classifyContainerEdge(edge);
		edge.label = classification.label;
		edge.labels = classification.labels;
		edge.symbolSamples = classification.symbolSamples;
		delete edge.symbolFreq; // not serialized
	}
	const containerEdges = [...containerEdgeMap.values()];

	// Entry points & sinks summary
	const entryPoints = modules
		.filter((m) => m.entryPoint)
		.map((m) => ({
			id: m.id,
			path: m.path,
			package: m.package,
			kind: m.entryPoint.kind,
			name: m.entryPoint.name || null,
			routes: m.entryPoint.routes || null,
		}));

	const sinkNodes = modules
		.filter((m) => m.sinks && m.sinks.length > 0)
		.map((m) => ({ id: m.id, path: m.path, package: m.package, sinks: m.sinks }));

	// Compute depth from entry points (BFS over dependency edges).
	// Re-export edges (`export { x } from "./x"`, common in package index.ts hubs) are real
	// reachability edges — include them so index hubs connect to their implementations instead
	// of registering as zero-out-degree dead-ends.
	const adj = new Map();
	for (const e of edges) {
		if (e.kind !== "import" && e.kind !== "re-export") continue;
		if (!adj.has(e.from)) adj.set(e.from, []);
		adj.get(e.from).push(e.to);
	}
	const depth = new Map();
	const queue = [];
	for (const ep of entryPoints) { depth.set(ep.id, 0); queue.push(ep.id); }
	while (queue.length) {
		const id = queue.shift();
		const d = depth.get(id);
		for (const next of (adj.get(id) || [])) {
			if (!depth.has(next)) { depth.set(next, d + 1); queue.push(next); }
		}
	}
	for (const m of modules) m.depth = depth.has(m.id) ? depth.get(m.id) : null;

	// ====================== Flow extraction (swim-lane sequences) ======================
	// For each entry point, walk cross-container edges + collect sinks reached.
	// Each cross-package hop and each sink touched is a numbered step.
	const SINK_LABEL = {
		"fs:write": "Filesystem", "fs:read": "Filesystem",
		"net:fetch": "Network", "net:http": "Network",
		"db:sql": "Database", "db:orm": "Database",
		"cli:io": "Stdout", "process:exec": "Subprocess",
		"process:exit": "Process", "ai:call": "AI provider", "env:read": "Environment",
	};
	const sinkBoxId = (kind) => "sink:" + (SINK_LABEL[kind] || kind);
	const containerOf2 = (mod) => mod ? (mod.package ? "pkg:" + mod.package : "dir:" + mod.path.split("/")[0]) : null;
	const containerAdj = new Map();
	for (const e of containerEdges) {
		if (!containerAdj.has(e.from)) containerAdj.set(e.from, []);
		containerAdj.get(e.from).push({ to: e.to, count: e.count });
	}

	// Build a per-module callEdge index so we can walk concrete symbol-level edges.
	const callOutByModule = new Map();
	for (const ce of callEdges) {
		if (!callOutByModule.has(ce.from)) callOutByModule.set(ce.from, []);
		callOutByModule.get(ce.from).push(ce);
	}

	// Re-export adjacency: when a module is a re-export hub (only `export * from`/`export { } from`),
	// its public surface lives in the targets. The flow BFS treats these as transparent hops so
	// library entries trace through index.ts into actual implementations.
	const reExportTargetsByModule = new Map();
	for (const m of modules) {
		const file = perFile.get(m.path);
		if (!file) continue;
		const targets = [];
		const fromDir = path.posix.dirname(m.path);
		for (const imp of file.parsedImports) {
			if (!imp.reExport) continue;
			const resolved = resolveSpec(fromDir, imp.specifier);
			if (resolved && resolved !== m.id) targets.push(resolved);
		}
		if (targets.length > 0) reExportTargetsByModule.set(m.id, targets);
	}

	// SINK_LABEL_PHRASE provides natural-language phrasing for each sink kind
	const SINK_PHRASE = {
		"fs:write":   "writes to the filesystem",
		"fs:read":    "reads from the filesystem",
		"net:fetch":  "calls an external HTTP API",
		"net:http":   "issues an HTTP request",
		"db:sql":     "runs a SQL query",
		"db:orm":     "issues an ORM database call",
		"cli:io":     "writes to stdout/stderr",
		"process:exec": "spawns a subprocess",
		"process:exit": "terminates the process",
		"ai:call":    "calls an AI provider",
		"env:read":   "reads environment variables",
	};

	function relShort(p) { return (p || "").split("/").slice(-2).join("/"); }
	function docFor(mod, symbol) {
		if (!mod || !mod.exports) return null;
		const e = mod.exports.find((x) => x.name === symbol);
		return e ? e.doc : null;
	}
	function describeEntry(ep, mod) {
		const exportSummary = mod && mod.exports && mod.exports.length
			? mod.exports.slice(0, 3).map((e) => e.kind + " `" + e.name + "`").join(", ")
			: null;
		if (ep.kind === "cli") {
			const commands = (mod?.exports || []).filter((e) => e.kind === "command");
			const cmdList = commands.length ? " Dispatches commands: " + commands.slice(0, 6).map((c) => "`" + c.name + "`").join(", ") + (commands.length > 6 ? ", …" : "") + "." : "";
			return "User runs `" + (ep.name || "cli") + "` from the shell. Entry is " + ep.path + "." + cmdList;
		}
		if (ep.kind === "http") {
			const r = (ep.routes && ep.routes[0]) ? (ep.routes[0].method + " " + ep.routes[0].path) : "";
			return "Incoming HTTP request " + r + " hits the handler in " + ep.path + ".";
		}
		return "Library consumer imports from " + ep.path + (exportSummary ? ". Exposes " + exportSummary + "." : ".");
	}

	const flows = [];
	const maxModulesPerFlow = 32;
	const maxStepsPerFlow = 18;
	const maxReExportFanout = 6; // how many re-export targets we expand at a dead-end
	for (const ep of entryPoints) {
		const startMod = moduleByRel.get(ep.id);
		const startContainer = containerOf2(startMod);
		if (!startContainer) continue;

		const steps = [];
		let stepN = 1;
		// Step 1: actor → entry container, with natural-language entry description
		steps.push({
			n: stepN++,
			from: "actor:user",
			to: startContainer,
			title: ep.kind === "cli" ? "invoke `" + (ep.name || "cli") + "`"
				: ep.kind === "http" ? (ep.routes && ep.routes[0] ? (ep.routes[0].method + " " + ep.routes[0].path) : "HTTP request")
				: "call " + (ep.name || "library"),
			description: describeEntry(ep, startMod),
			fromFile: null,
			toFile: ep.path,
			boxFrom: "actor:user",
			boxTo: startContainer,
		});

		// Module-level BFS. Re-exports are TRANSPARENT: when a module has no callEdges out,
		// we lazily expand its re-export targets at the same depth so library traces descend
		// from index.ts into the actual implementation modules without flooding the queue.
		const visitedModules = new Set([ep.id]);
		const visitedContainers = new Set([startContainer]);
		const emittedHopKeys = new Set();
		// enqueued = BFS queue dedup (traverse each module once); visitedModules = every module the
		// flow touches (drives sink-step emission + the per-flow cap). Kept separate so re-export
		// siblings can still emit their own intra-package call steps instead of being pre-consumed.
		const enqueued = new Set([ep.id]);
		const queue = [{ moduleId: ep.id, depth: 0 }];

		while (queue.length && stepN <= maxStepsPerFlow && visitedModules.size < maxModulesPerFlow) {
			const cur = queue.shift();
			if (cur.depth > 6) continue;
			const fromMod = moduleByRel.get(cur.moduleId);
			const fromContainer = containerOf2(fromMod);
			let calls = (callOutByModule.get(cur.moduleId) || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));

			// No resolved call edges out of this module. Symbol resolution is best-effort, but
			// import edges are exact — so we still descend the dependency graph instead of
			// dead-ending at the entry (the root cause of 2-step flows):
			//   1. transparent re-export hub → expand its targets at the same depth;
			//   2. otherwise → synthesize hops from this module's import edges, ranked so the
			//      most informative neighbours (cross-package, sink-bearing, exported) come first.
			if (calls.length === 0) {
				const reTargets = reExportTargetsByModule.get(cur.moduleId) || [];
				if (reTargets.length > 0) {
					for (const t of reTargets.slice(0, maxReExportFanout)) {
						if (enqueued.has(t)) continue;
						enqueued.add(t);
						visitedModules.add(t);
						queue.push({ moduleId: t, depth: cur.depth });
					}
					continue;
				}
				const importRank = (to) => {
					const tm = moduleByRel.get(to);
					if (!tm) return 0;
					return (containerOf2(tm) !== fromContainer ? 3 : 0)
						+ (tm.sinks && tm.sinks.length ? 2 : 0)
						+ (tm.exports && tm.exports.length ? 1 : 0);
				};
				calls = (adj.get(cur.moduleId) || [])
					.filter((to) => !enqueued.has(to))
					.sort((a, b) => importRank(b) - importRank(a) || (a < b ? -1 : a > b ? 1 : 0))
					.slice(0, 8)
					.map((to) => ({ from: cur.moduleId, to, symbol: "(imports)", count: 0 }));
				if (calls.length === 0) continue;
			}

			for (const ce of calls.slice(0, 8)) {
				const toMod = moduleByRel.get(ce.to);
				const toContainer = containerOf2(toMod);

				const isCrossContainer = fromContainer !== toContainer;
				const callDoc = docFor(toMod, ce.symbol);
				const calleeExported = toMod?.exports?.some((e) => e.name === ce.symbol);
				const calleeHasSinks = !!(toMod?.sinks?.length);

				// Emit a step when: cross-container OR symbol-has-doc OR exported public API
				// OR target has sinks OR we're shallow (depth ≤ 1) so the trace stays useful near entry.
				const shouldEmit = isCrossContainer || callDoc || calleeExported || calleeHasSinks || cur.depth <= 1;

				if (shouldEmit) {
					if (isCrossContainer) visitedContainers.add(toContainer);

					const hopKey = (isCrossContainer ? fromContainer + "→" + toContainer : ce.from + "→" + ce.to) + "#" + ce.symbol;
					if (!emittedHopKeys.has(hopKey)) {
						emittedHopKeys.add(hopKey);

						const symbolPhrase = ce.symbol === "default" ? "the default export"
							: ce.symbol === "*" ? "the namespace import"
							: ce.symbol === "(imports)" ? "into its imports"
							: "`" + ce.symbol + "()`";
						const docPhrase = callDoc ? " — " + callDoc : (calleeHasSinks ? " (which performs " + toMod.sinks.slice(0,2).join(", ") + ")" : "");
						const baseDesc = relShort(ce.from) + " calls " + symbolPhrase + " in " + relShort(ce.to) + docPhrase;

						steps.push({
							n: stepN++,
							from: isCrossContainer ? fromContainer : ce.from,
							to: isCrossContainer ? toContainer : ce.to,
							boxFrom: fromContainer,
							boxTo: toContainer,
							title: symbolPhrase.replace(/`/g, "") + " in " + (toMod?.path?.split("/").pop() || ce.to),
							description: baseDesc + ".",
							symbol: ce.symbol,
							fromFile: ce.from,
							toFile: ce.to,
						});
					}
				}

				visitedModules.add(ce.to);
				if (!enqueued.has(ce.to)) {
					enqueued.add(ce.to);
					queue.push({ moduleId: ce.to, depth: cur.depth + 1 });
				}
				if (stepN > maxStepsPerFlow) break;
			}
		}

		// Sink steps: for each visited module that has sinkSites, emit a step per sink kind with the concrete callsite
		const emittedSinkKinds = new Set();
		for (const modId of visitedModules) {
			const mod = moduleByRel.get(modId);
			if (!mod || !mod.sinkSites || !mod.sinkSites.length) continue;
			const fromContainer = containerOf2(mod);
			// Group sinkSites by kind so we pick the most informative one per kind for this module
			const byKind = new Map();
			for (const s of mod.sinkSites) {
				if (!byKind.has(s.kind)) byKind.set(s.kind, s);
			}
			for (const [kind, site] of byKind) {
				if (emittedSinkKinds.has(kind)) continue;
				emittedSinkKinds.add(kind);
				const fnPart = site.inFunction ? "`" + site.inFunction + "()`" : "top-level code";
				const phrase = SINK_PHRASE[kind] || ("performs " + kind);
				const description = mod.path + ":" + site.line + " — " + fnPart + " " + phrase + ". `" + site.snippet + "`";
				steps.push({
					n: stepN++,
					from: fromContainer,
					to: sinkBoxId(kind),
					boxFrom: fromContainer,
					boxTo: sinkBoxId(kind),
					title: SINK_LABEL[kind] || kind,
					description,
					sinkKind: kind,
					sinkSite: { file: mod.path, line: site.line, fn: site.inFunction, snippet: site.snippet },
				});
				if (stepN > maxStepsPerFlow + 8) break;
			}
			if (stepN > maxStepsPerFlow + 8) break;
		}

		// Fallback: if no sinkSites found via callEdges traversal, emit aggregated sink steps per visited container.
		if (emittedSinkKinds.size === 0) {
			for (const c of visitedContainers) {
				const cMods = modules.filter((m) => containerOf2(m) === c);
				const cSinks = new Set();
				for (const m of cMods) for (const s of (m.sinks || [])) cSinks.add(s);
				for (const s of cSinks) {
					if (emittedSinkKinds.has(s)) continue;
					emittedSinkKinds.add(s);
					steps.push({
						n: stepN++,
						from: c,
						to: sinkBoxId(s),
						boxFrom: c,
						boxTo: sinkBoxId(s),
						title: SINK_LABEL[s] || s,
						description: c.replace(/^pkg:/, "") + " " + (SINK_PHRASE[s] || ("performs `" + s + "`")) + ".",
						sinkKind: s,
					});
					if (stepN > maxStepsPerFlow + 8) break;
				}
				if (stepN > maxStepsPerFlow + 8) break;
			}
		}

		const flowDescription = ep.kind === "cli"
			? "User invokes the `" + (ep.name || "cli") + "` CLI command. The trace below shows which files run, what symbols they call, and what side effects they produce."
			: ep.kind === "http"
				? "An incoming HTTP request flows through the handler, calls dependent services, and reaches downstream side effects."
				: "Library consumer imports from this entry. The trace shows what the entry exposes and which downstream side effects it can produce.";

		flows.push({
			id: "flow:" + ep.id,
			name: ep.kind === "cli" ? (ep.name || ep.path.split("/").pop()) + " (CLI)"
				: ep.kind === "http" ? (ep.routes && ep.routes[0] ? (ep.routes[0].method + " " + ep.routes[0].path) : ep.path)
				: (ep.name || ep.path.split("/").pop()) + " (library)",
			description: flowDescription,
			entry: ep.id,
			entryKind: ep.kind,
			entryContainer: startContainer,
			steps,
		});
	}

	// User-curated FLOWS overrides — read .planning/codebase/FLOWS.json if present.
	// Schema: { flows: [{ id, name, description, steps: [{ n, from, to, title, description }] }] }
	// Entries with matching `id` replace auto-generated flows; new ids are appended.
	try {
		const flowsFile = path.join(root, PLANNING_DIR, "codebase", "FLOWS.json");
		if (fs.existsSync(flowsFile)) {
			const user = JSON.parse(fs.readFileSync(flowsFile, "utf-8"));
			if (Array.isArray(user.flows)) {
				const byId = new Map(flows.map((f) => [f.id, f]));
				for (const uf of user.flows) {
					if (!uf.id) continue;
					byId.set(uf.id, Object.assign({}, byId.get(uf.id) || {}, uf, { curated: true }));
				}
				flows.length = 0;
				for (const f of byId.values()) flows.push(f);
			}
		}
	} catch { /* empty */ }

	// Build the swim-lane "flow graph" — lanes (architectural categories),
	// boxes (packages + sink kinds + actor), so the HTML can lay it out directly.
	const lanes = [
		{ id: "actor", name: "Actors", color: "#ff9bd4" },
		{ id: "presentation", name: "Presentation", color: "#79c0ff" },
		{ id: "application", name: "Application", color: "#7ee787" },
		{ id: "domain", name: "Domain", color: "#d2a8ff" },
		{ id: "infrastructure", name: "Infrastructure", color: "#f0883e" },
		{ id: "sinks", name: "Sinks", color: "#ff7b72" },
	];
	const boxes = [];
	boxes.push({ id: "actor:user", lane: "actor", title: "User", sublabel: "CLI / HTTP / library caller", color: "#ff9bd4" });
	// Determine each container's dominant layer
	for (const c of containers) {
		const mods = modules.filter((m) => containerOf2(m) === c.id);
		const counts = {};
		for (const m of mods) counts[m.layer] = (counts[m.layer] || 0) + 1;
		const lane = LAYER_ORDER_INTERNAL.slice().sort((a,b) => (counts[b]||0) - (counts[a]||0))[0] || "support";
		const sinkSet = new Set();
		for (const m of mods) for (const s of (m.sinks || [])) sinkSet.add(s);
		const entryMods = mods.filter((m) => !!m.entryPoint);
		boxes.push({
			id: c.id,
			lane: lane === "support" ? "application" : lane,
			title: c.name,
			sublabel: mods.length + " modules" + (entryMods.length ? " · " + entryMods.length + " entry" : "") + (sinkSet.size ? " · " + Array.from(sinkSet).slice(0,3).join(", ") : ""),
			color: LAYER_COLORS_INTERNAL[lane] || "#8b949e",
			kind: "package",
			moduleCount: mods.length,
			hasEntry: entryMods.length > 0,
			sinks: Array.from(sinkSet),
		});
	}
	// Sink boxes — one per distinct sink kind that any flow reaches
	const allSinkKinds = new Set();
	for (const f of flows) for (const s of f.steps) if (s.sinkKind) allSinkKinds.add(s.sinkKind);
	for (const kind of allSinkKinds) {
		boxes.push({
			id: sinkBoxId(kind),
			lane: "sinks",
			title: SINK_LABEL[kind] || kind,
			sublabel: kind,
			color: "#ff7b72",
			kind: "sink",
		});
	}

	const layerCounts = {};
	for (const m of modules) layerCounts[m.layer] = (layerCounts[m.layer] || 0) + 1;

	// Symbol index for agents (the searchable identifier glossary)
	const symbolIndex = [];
	for (const m of modules) {
		for (const e of m.exports) {
			symbolIndex.push({ name: e.name, kind: e.kind, line: e.line, file: m.path, package: m.package, exported: true });
			if (symbolIndex.length > 1500) break;
		}
		if (symbolIndex.length > 1500) break;
	}

	const tests = { total: modules.filter((m) => m.isTest).length, byContainer: {} };
	for (const c of containers) {
		tests.byContainer[c.name] = modules.filter((m) => m.isTest && m.path.startsWith(c.path + "/")).length;
	}

	// ── Knowledge-graph rollups: hotspots (god-nodes), clusters, surprising connections, rationale ──
	const rankHotspots = (metric, reason) => {
		const arr = modules.filter((m) => !m.isTest).map((m) => {
			const inD = inDegNT.get(m.id) || 0, outD = outDegNT.get(m.id) || 0, l = m.loc || 0;
			return { id: m.id, path: m.path, package: m.package, inDegree: inD, outDegree: outD, loc: l, score: +metric(inD, outD, l).toFixed(2), reason: reason(inD, outD, l) };
		});
		arr.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		return arr.slice(0, 15);
	};
	const hotspots = {
		godNodes: rankHotspots((i, o, l) => i * 2 + o + Math.log2(1 + l), (i, o) => `${i} dependents · ${o} deps`),
		mostDependedOn: rankHotspots((i) => i, (i) => `${i} dependents`),
		orchestrators: rankHotspots((i, o) => o, (i, o) => `imports ${o} modules`),
		largest: rankHotspots((i, o, l) => l, (i, o, l) => `${l} LOC`),
	};

	const { clusters, clusterOf } = visComputeClusters(modules, edges, moduleByRel, containerOf);
	for (const m of modules) m.cluster = clusterOf.get(m.id) || null;

	const groupOfContainer = new Map();
	for (const g of groups) for (const mid of (g.members || [])) groupOfContainer.set(mid, g.id);
	const surprisingConnections = visComputeSurprising(edges, callEdges, moduleByRel, clusterOf, groupOfContainer, containerOf);

	const rationaleIndex = rationaleAll
		.sort((a, b) => (RATIONALE_SEVERITY[a.tag] - RATIONALE_SEVERITY[b.tag]) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line - b.line))
		.slice(0, 600);

	return {
		schemaVersion: 4,
		generatedAt: new Date().toISOString(),
		buildMs: Date.now() - startedAt,
		root: path.basename(root),
		stats: {
			files: modules.length,
			totalLoc: totalLoc.value,
			languages: langCounts,
			packages: pkgs.length,
			containers: containers.length,
			groups: groups.length,
			edges: edges.length,
			callEdges: callEdges.length,
			containerEdges: containerEdges.length,
			entryPoints: entryPoints.length,
			sinkModules: sinkNodes.length,
			layers: layerCounts,
		},
		packages: pkgs,
		groups,
		containers,
		boundedContexts: containers, // alias for back-compat
		modules,
		edges,
		callEdges,
		containerEdges,
		entryPoints,
		sinks: sinkNodes,
		flows,
		lanes,
		boxes,
		symbolIndex,
		hotspots,
		clusters,
		surprisingConnections,
		rationaleIndex,
		tests,
		planning: {
			hasProject: !!planning.project,
			hasRoadmap: !!planning.roadmap,
			hasDomain: !!planning.domain,
			currentState: planning.state ? planning.state.slice(0, 2000) : null,
		},
		agentHints: {
			description: "Architecture map of this codebase. Read this BEFORE walking the file tree.",
			howToUse: [
				"`groups` partitions packages into functional containers (Frontend, CLI & Runtime, Core, Domain Services, Workflows & Infra). Each group's `members` array lists `pkg:NAME` ids. Overridable via `.planning/codebase/GROUPS.json`.",
				"`containers[*].groupId` links a package to its functional group; `containers[*].topFiles` is the 3-5 most relevant source files in the package (with a `reason` tag like `CLI entry` / `most depended-on` / `HTTP handler`).",
				"`containerEdges[*].label` is the relationship verb between two packages (Calls / Uses / Sends Events / Renders / Updates / Reads State / Configures / Analyzes / Executes Actions / Persists). `containerEdges[*].symbolSamples` shows the top imported symbol names.",
				"`entryPoints` lists every CLI command, HTTP route, and library main — these are where data flows in.",
				"`sinks` lists modules that hit FS, network, DB, stdout, or run subprocesses — where data flows out.",
				"`containers` describes packages/bounded contexts. `containerEdges` shows cross-package dataflow.",
				"`callEdges` is symbol-level: each entry means caller-file uses callee-file's <symbol>.",
				"`flows` is a list of named scenarios (CLI invocation, HTTP request, library call). Each flow has numbered `steps` going from `from` box → `to` box with a `description`. Boxes are packages (`pkg:NAME`), sinks (`sink:KIND`), or `actor:user`.",
				"`lanes` + `boxes` give you swim-lane layout coordinates: each box belongs to a lane (presentation / application / domain / infrastructure / sinks / actors).",
				"To curate flows or groups: write `.planning/codebase/FLOWS.json` or `.planning/codebase/GROUPS.json` — entries with matching `id` override auto-generated ones; new ids are appended.",
				"`modules[*].layer` classifies each file as presentation / application / domain / infrastructure / support.",
				"`modules[*].symbols` are symbol-level nodes ({name,kind,line,exported}); `modules[*].cluster` is the structural neighborhood id.",
				"`hotspots` ranks god-nodes / most-depended-on / orchestrators / largest (non-test import degree).",
				"`clusters` are STRUCTURAL (import-topology) neighborhoods — not semantic bounded contexts; confirm with a human before equating a cluster with a context. Non-JS/TS packages degenerate to one cluster per package.",
				"`surprisingConnections` flags import edges that bridge distant clusters, cross functional groups, or violate layer direction — review these.",
				"`rationaleIndex` collects inline NOTE/WHY/HACK/TODO/FIXME/SECURITY notes ({file,line,tag,text}).",
				"`edges[*].confidence` / `callEdges[*].confidence` ∈ EXTRACTED (literal in source) / INFERRED (regex call heuristic) / AMBIGUOUS (member-call, imported symbol uncertain).",
				"Query the map with `draht-tools graph-context|graph-impact|graph-query|graph-callers|graph-callees|graph-path|graph-hotspots|graph-clusters` instead of reading this whole file or grepping.",
			],
		},
	};
}

function visRenderHtml(jsonPath) {
	const jsonName = path.basename(jsonPath);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Draht ▸ Architecture & Flows</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
:root {
  --bg:#0b0d10; --bg-soft:#11151a; --panel:#151b22; --text:#e6edf3;
  --muted:#8b949e; --border:#262d36;
  --pres:#79c0ff; --app:#7ee787; --dom:#d2a8ff; --infra:#f0883e; --supp:#8b949e;
  --sink:#ff7b72; --entry:#ffdf5d; --actor:#ff9bd4;
}
* { box-sizing:border-box; }
html,body { margin:0; height:100%; background:var(--bg); color:var(--text);
  font:13px/1.45 -apple-system,"SF Pro Text",Segoe UI,system-ui,sans-serif; }

header { display:flex; align-items:center; gap:14px; padding:10px 16px;
  border-bottom:1px solid var(--border); background:var(--bg-soft); }
header .title { font-weight:700; letter-spacing:.4px; }
header .meta { color:var(--muted); font-size:12px; }
header .tabs { display:flex; gap:2px; margin-left:8px; }
header .tabs button { background:transparent; color:var(--muted); border:1px solid var(--border);
  padding:4px 10px; cursor:pointer; font-size:12px; border-radius:6px; }
header .tabs button.active { color:var(--text); background:#1c2530; border-color:#3a4858; }
header .live { margin-left:auto; padding:2px 8px; border-radius:99px;
  background:#143; color:var(--app); font-size:11px; }
header .live.dead { background:#3a1a1a; color:#ff7b72; }

main { display:grid; grid-template-columns:280px 1fr 380px; height:calc(100vh - 49px); }
aside { overflow:auto; background:var(--panel); border-right:1px solid var(--border); }
aside.right { border-right:none; border-left:1px solid var(--border); }
.section { padding:10px 14px; border-bottom:1px solid var(--border); }
.section h2 { margin:0 0 6px; font-size:10.5px; text-transform:uppercase;
  letter-spacing:1.2px; color:var(--muted); font-weight:700; }
.section input { width:100%; background:var(--bg); color:var(--text);
  border:1px solid var(--border); border-radius:6px; padding:6px 8px; outline:none; font-size:12px; }
.list { display:flex; flex-direction:column; }
.list .row { display:flex; align-items:center; gap:8px; padding:5px 14px; cursor:pointer; font-size:12px; }
.list .row:hover { background:#1c2530; }
.list .row.active { background:#1f2a36; border-left:2px solid var(--entry); }
.list .row .name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.list .row .count { color:var(--muted); font-size:11px; }
.dot { width:9px; height:9px; border-radius:50%; flex:0 0 9px; }

#viz { position:relative; overflow:hidden; background:radial-gradient(circle at 30% 20%, #0f141a 0%, #0b0d10 70%); }
svg { display:block; user-select:none; }
.controls { position:absolute; top:10px; right:10px; display:flex; gap:6px; z-index: 2; }
.controls button { background:var(--panel); color:var(--text); border:1px solid var(--border);
  border-radius:6px; padding:4px 10px; cursor:pointer; font-size:11px; }
.controls button:hover { border-color:var(--pres); }
.hud { position:absolute; bottom:10px; left:12px; color:var(--muted); font-size:11px;
  background:rgba(15,18,22,.6); padding:4px 8px; border-radius:6px; }
.legend { position:absolute; top:10px; left:12px; background:rgba(15,18,22,.85);
  border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-size:11px; z-index: 1; }
.legend .row { display:flex; align-items:center; gap:6px; padding:1px 0; }

.detail h3 { font-size:13px; margin:0 0 6px; word-break:break-all; font-weight:600; }
.detail .pill { display:inline-block; padding:2px 8px; border:1px solid var(--border);
  border-radius:99px; font-size:11px; color:var(--muted); margin:2px 4px 2px 0; }
.detail pre { background:var(--bg); border:1px solid var(--border); border-radius:6px;
  padding:8px; overflow:auto; font-size:11px; line-height:1.4; max-height:220px;
  margin:6px 0 0; white-space:pre-wrap; }
.detail .kv { font-size:11.5px; color:var(--muted); margin:2px 0; }
.detail .kv b { color:var(--text); }

.flow-list { max-height:280px; overflow-y:auto; }
.flow-list .flow-item { padding:8px 14px; border-bottom:1px solid var(--border); cursor:pointer; }
.flow-list .flow-item:hover { background:#1c2530; }
.flow-list .flow-item.active { background:#1f2a36; border-left:3px solid var(--entry); padding-left:11px; }
.flow-list .flow-item .name { font-size:12.5px; font-weight:600; }
.flow-list .flow-item .desc { font-size:11px; color:var(--muted); margin-top:2px; }
.step-list { max-height:calc(100vh - 460px); overflow-y:auto; }

.step-list .step-item { padding:10px 14px; border-bottom:1px solid var(--border); display:flex; gap:10px;
  cursor:pointer; align-items:flex-start; }
.step-list .step-item:hover { background:#1c2530; }
.step-list .step-item.active { background:#1f2a36; }
.step-list .step-item .num {
  flex:0 0 22px; height:22px; border-radius:50%;
  background:var(--entry); color:#0b0d10; font-weight:700; font-size:12px;
  display:flex; align-items:center; justify-content:center;
}
.step-list .step-item .body { flex:1; min-width:0; font-size:11.5px; }
.step-list .step-item .title { font-weight:600; color:var(--text); }
.step-list .step-item .from-to { color:var(--muted); font-size:10.5px; margin-top:3px; }
.step-list .step-item .desc { color:#c9d1d9; font-size:11.5px; margin-top:5px; line-height:1.55; }
.step-list .step-item .desc code { background:rgba(28,37,48,0.8); border:1px solid var(--border);
  border-radius:4px; padding:1px 5px; font-family:ui-monospace,SF Mono,Menlo,monospace; font-size:10.5px; color:#7ee787; }
.step-list .step-item .snippet { background:rgba(11,13,16,0.85); border-left:2px solid var(--entry);
  padding:4px 8px; margin-top:5px; font-family:ui-monospace,SF Mono,Menlo,monospace;
  font-size:10.5px; color:#c9d1d9; border-radius:0 4px 4px 0; white-space:pre-wrap; word-break:break-word; }
.step-list .step-item .file-ref { font-family:ui-monospace,SF Mono,Menlo,monospace; font-size:10px;
  color:var(--pres); margin-top:2px; word-break:break-all; }
.kbd { background:var(--bg); border:1px solid var(--border); padding:1px 5px;
  border-radius:4px; font-family:ui-monospace,monospace; font-size:10px; }

.container-rect { fill:rgba(28,37,48,0.55); stroke:#2a3540; stroke-width:1; }
.container-rect.hi { stroke:#79c0ff; stroke-width:2; }
.container-label { fill:var(--text); font-size:11px; font-weight:600; pointer-events:none; }
.module-node { cursor:pointer; }
.module-node circle { stroke:#0b0d10; stroke-width:1.2; transition:r .15s, stroke .15s; }
.module-node:hover circle { stroke:#fff; }
.module-node.selected circle { stroke:#fff; stroke-width:2.4; }
.edge { fill:none; stroke:#3a4858; stroke-width:0.8; opacity:.5; }
.edge.cross { stroke:#7ee787; stroke-width:1.4; opacity:.65; }
.edge.flow { stroke:#ffdf5d; stroke-width:1.5; opacity:.95; }
.edge.flow.active { stroke-width:2.5; }
.edge.hi { stroke:#ffdf5d; stroke-width:1.6; opacity:1; }
.edge.dim { opacity:.05; }
.layer-band { stroke:#1a2028; stroke-dasharray:2 4; fill:none; }
.layer-label { fill:var(--muted); font-size:11px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; }
.lane-divider { stroke:#1a2028; stroke-dasharray:2 4; }
.flow-box { cursor:pointer; }
.flow-box:hover rect { stroke-width:1.6; }
.step-num { cursor:pointer; }
.step-num.active circle { fill:#fff; }

/* Architecture (CodeViz-style nested) view */
.group-rect { fill:rgba(28,37,48,0.32); stroke-width:1.4; rx:12; cursor:default; }
.group-rect:hover { filter:brightness(1.15); }
.group-rect.focused { stroke-width:2.5; }
.group-rect.collapsed { fill:rgba(28,37,48,0.6); }
.group-header { fill:rgba(11,13,16,0.65); pointer-events:none; }
.group-name { font-size:13px; font-weight:700; letter-spacing:.3px; pointer-events:none; }
.group-sub { fill:var(--muted); font-size:10px; pointer-events:none; }
.pkg-rect { fill:rgba(15,18,22,0.78); stroke-width:1.2; cursor:pointer;
  transition:filter .12s, stroke-width .12s; }
.pkg-rect:hover { filter:brightness(1.25); stroke-width:1.8; }
.pkg-rect.selected { stroke:#fff !important; stroke-width:2.4; }
.pkg-rect.dim { opacity:.18; }
.pkg-title { fill:var(--text); font-size:12px; font-weight:600; pointer-events:none; }
.pkg-sub { fill:var(--muted); font-size:10px; pointer-events:none; }
.pkg-topfiles { fill:#8fb8ff; font-size:9.5px; pointer-events:none; font-family:ui-monospace,monospace; }
.edge.intra { stroke:#3a4858; stroke-width:0.6; opacity:0.32; }
.edge-label-bg { fill:#11151a; stroke:#262d36; stroke-width:1; rx:4; ry:4; }
.edge-label-text { fill:#c9d1d9; font-size:10px; font-weight:500; pointer-events:none; }
.edge-label-text.persists { fill:#ff7b72; }
.edge-label-text.sends-events { fill:#ffdf5d; }
.edge-label-text.renders { fill:#79c0ff; }
.edge-label-text.configures { fill:#d2a8ff; }
.edge-hit { stroke:transparent; stroke-width:14; fill:none; cursor:pointer; }
#tooltip { position:absolute; display:none; background:#11151a; color:var(--text);
  border:1px solid var(--border); border-radius:6px; padding:8px 10px; font-size:11px;
  max-width:340px; pointer-events:none; z-index:100; box-shadow:0 4px 24px rgba(0,0,0,0.5); }
#tooltip .tt-title { font-weight:700; font-size:12px; margin-bottom:2px; }
#tooltip .tt-desc { color:var(--muted); font-size:10.5px; margin-bottom:6px; line-height:1.4; }
#tooltip .tt-section { color:var(--muted); font-size:9.5px; text-transform:uppercase; letter-spacing:1px;
  margin:5px 0 2px; }
#tooltip ul { margin:0; padding-left:0; list-style:none; }
#tooltip ul li { display:flex; gap:6px; font-family:ui-monospace,monospace; font-size:10px; padding:1px 0; }
#tooltip .tt-reason { color:var(--entry); flex:0 0 84px; }
#tooltip .tt-loc { color:var(--muted); margin-left:auto; }
#tooltip code { color:#7ee787; font-family:ui-monospace,monospace; font-size:10px; }
.ctrl-checkbox { display:inline-flex; align-items:center; gap:5px; color:var(--muted);
  font-size:11px; cursor:pointer; padding:4px 8px; border:1px solid var(--border); border-radius:6px; background:var(--panel); }
.ctrl-checkbox input { margin:0; cursor:pointer; }
</style>
</head>
<body>
<header>
  <div class="title">DRAHT ▸ <span id="root-name">codebase</span></div>
  <div class="meta" id="meta">loading…</div>
  <div class="tabs">
    <button id="tab-architecture" class="active">Architecture</button>
    <button id="tab-modules">Modules</button>
    <button id="tab-flows">Flow Trace</button>
    <button id="tab-insights">Insights</button>
  </div>
  <div class="live" id="live-indicator">● live</div>
</header>
<main>
  <aside id="left-aside">
    <div class="section">
      <h2>Search</h2>
      <input id="q" placeholder="filter…" />
    </div>
    <div class="section">
      <h2>Entry Points</h2>
      <div class="list" id="entry-list"></div>
    </div>
    <div class="section">
      <h2>Sinks</h2>
      <div class="list" id="sink-list"></div>
    </div>
    <div class="section">
      <h2>Layers</h2>
      <div class="list" id="layer-list"></div>
    </div>
    <div class="section">
      <h2>Packages</h2>
      <div class="list" id="pkg-list"></div>
    </div>
  </aside>
  <div id="viz">
    <svg id="svg" width="100%" height="100%"></svg>
    <div class="legend" id="legend"></div>
    <div class="controls">
      <label class="ctrl-checkbox"><input type="checkbox" id="overlay-flow-cb"/> overlay flow</label>
      <button id="fit">fit</button>
      <button id="clear">clear</button>
      <button id="reload">reload</button>
    </div>
    <div class="hud" id="hud">click a package · hover for details · double-click a group to focus</div>
    <div id="tooltip"></div>
  </div>
  <aside class="right">
    <div class="section">
      <h2>Flows</h2>
      <div class="flow-list" id="flow-list"></div>
    </div>
    <div class="section">
      <h2>Steps</h2>
      <div class="step-list" id="step-list">
        <div style="color:var(--muted); padding:8px 0">Select a flow above to see numbered steps.</div>
      </div>
    </div>
    <div class="section detail" id="detail" style="display:none">
      <h3>Detail</h3>
    </div>
  </aside>
</main>
<script>
"use strict";
var JSON_PATH = ${JSON.stringify('./' + jsonName)};
var LAYER_COLOR = { presentation:"#79c0ff", application:"#7ee787",
  domain:"#d2a8ff", infrastructure:"#f0883e", support:"#8b949e" };
var LAYER_ORDER = ["presentation","application","domain","infrastructure","support"];
var SVG_NS = "http://www.w3.org/2000/svg";
function $(id) { return document.getElementById(id); }
var svg = $("svg");

var state = {
  map: null,
  view: "architecture",
  zoom: 1,
  pan: { x:0, y:0 },
  drag: null,
  selected: null,
  selectedFlow: null,
  selectedStep: null,
  collapsedGroups: {},
  overlayFlow: false,
  focus: null,
  filter: "",
};

function layerOf(m) { return m.layer || "support"; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c];
  });
}
function truncate(s, n) { if (!s) return ""; s = String(s); if (s.length <= n) return s; return s.slice(0, n - 1) + "…"; }
function containerIdOf(m) {
  if (m.package) return "pkg:" + m.package;
  return "dir:" + m.path.split("/")[0];
}
function tx(g) {
  g.setAttribute("transform", "translate(" + state.pan.x + "," + state.pan.y + ") scale(" + state.zoom + ")");
}

async function load(initial) {
  var res = await fetch(JSON_PATH + "?t=" + Date.now());
  var map = await res.json();
  state.map = map;
  $("root-name").textContent = map.root;
  $("meta").textContent =
    map.stats.files + " files · " + map.stats.totalLoc.toLocaleString() + " LOC · " +
    map.stats.entryPoints + " entries · " + map.stats.sinkModules + " sinks · " +
    map.stats.containerEdges + " cross-pkg edges · " +
    new Date(map.generatedAt).toLocaleTimeString();
  renderSidebar();
  renderFlowList();
  render();
  if (initial) fit();
}

function setView(v) {
  state.view = v;
  ["tab-architecture","tab-modules","tab-flows","tab-insights"].forEach(function (id) {
    $(id).classList.toggle("active", id === "tab-" + v);
  });
  // Sidebar layout: flows shows step detail, others show entry inspection
  render(); fit();
}

function buildAdj(map) {
  var adj = new Map();
  for (var i=0; i<map.edges.length; i++) {
    var e = map.edges[i];
    if (e.kind !== "import") continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  return adj;
}
function buildReverseAdj(map) {
  var adj = new Map();
  for (var i=0; i<map.edges.length; i++) {
    var e = map.edges[i];
    if (e.kind !== "import") continue;
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.to).push(e.from);
  }
  return adj;
}

function selectFlow(flowId) {
  state.selectedFlow = flowId;
  state.selectedStep = null;
  state.view = "flows";
  ["tab-architecture","tab-modules","tab-flows","tab-insights"].forEach(function (id) {
    $(id).classList.toggle("active", id === "tab-flows");
  });
  renderFlowList();
  renderStepList();
  render();
}
function selectStep(n) {
  state.selectedStep = n;
  renderStepList();
  render();
}
function clearFlow() {
  state.selectedFlow = null;
  state.selectedStep = null;
  state.focus = null;
  state.selected = null;
  renderFlowList();
  renderStepList();
  renderDetail();
  render();
}

function focusEntry(id) {
  var adj = buildAdj(state.map);
  var set = new Set([id]); var stack = [id];
  while (stack.length) {
    var x = stack.pop();
    var ns = adj.get(x) || [];
    for (var i=0; i<ns.length; i++) if (!set.has(ns[i])) { set.add(ns[i]); stack.push(ns[i]); }
  }
  state.focus = { kind: "entry", id: id, set: set };
  render();
}
function focusSink(kind) {
  var map = state.map;
  var radj = buildReverseAdj(map);
  var seeds = map.sinks.filter(function (s) { return s.sinks.indexOf(kind) !== -1; }).map(function (s) { return s.id; });
  var set = new Set(seeds); var stack = seeds.slice();
  while (stack.length) {
    var x = stack.pop();
    var ns = radj.get(x) || [];
    for (var i=0; i<ns.length; i++) if (!set.has(ns[i])) { set.add(ns[i]); stack.push(ns[i]); }
  }
  state.focus = { kind: "sink", id: kind, set: set };
  render();
}
function focusPackage(pkgId) {
  var set = new Set();
  for (var i=0; i<state.map.modules.length; i++) {
    var m = state.map.modules[i];
    if (("pkg:" + (m.package || "")) === pkgId) set.add(m.id);
  }
  state.focus = { kind: "package", id: pkgId, set: set };
  render();
}

// ====================== Swim-lane Flows view ======================

function layoutSwimlanes(map, W, H) {
  var lanes = map.lanes || [];
  if (!lanes.length) return { lanePos: new Map(), boxPos: new Map() };
  var laneW = W / lanes.length;
  var lanePos = new Map();
  lanes.forEach(function (lane, i) {
    lanePos.set(lane.id, { x: laneW * i, w: laneW, lane: lane });
  });
  var boxesByLane = new Map();
  lanes.forEach(function (l) { boxesByLane.set(l.id, []); });
  (map.boxes || []).forEach(function (b) {
    if (boxesByLane.has(b.lane)) boxesByLane.get(b.lane).push(b);
  });
  // Sort: entry first, then alphabetical
  boxesByLane.forEach(function (arr) {
    arr.sort(function (a,b) {
      if ((a.hasEntry?1:0) !== (b.hasEntry?1:0)) return (b.hasEntry?1:0) - (a.hasEntry?1:0);
      return a.title.localeCompare(b.title);
    });
  });
  var headerH = 36;
  var boxPos = new Map();
  boxesByLane.forEach(function (arr, laneId) {
    var lp = lanePos.get(laneId);
    if (!arr.length) return;
    var availH = H - headerH - 24;
    var maxBoxH = Math.min(64, Math.max(46, availH / Math.max(1, arr.length) - 10));
    var boxPad = 10;
    var totalH = arr.length * (maxBoxH + boxPad);
    var startY = headerH + Math.max(8, (availH - totalH) / 2);
    arr.forEach(function (box, i) {
      var w = Math.max(140, lp.w - 28);
      var x = lp.x + (lp.w - w) / 2;
      boxPos.set(box.id, { x: x, y: startY + i * (maxBoxH + boxPad), w: w, h: maxBoxH, box: box, laneId: laneId });
    });
  });
  return { lanePos: lanePos, boxPos: boxPos };
}

function renderFlowsSwimlane(g, W, H) {
  var map = state.map;
  var layout = layoutSwimlanes(map, W, H);
  // Lane headers + dividers
  layout.lanePos.forEach(function (lp) {
    g.appendChild(el("text", { class: "layer-label", x: lp.x + 14, y: 22 }, lp.lane.name));
    g.appendChild(el("line", { class: "lane-divider", x1: lp.x + lp.w, y1: 0, x2: lp.x + lp.w, y2: H }));
  });

  var flow = state.selectedFlow ? map.flows.find(function (f) { return f.id === state.selectedFlow; }) : null;
  var inFlow = new Set();
  var selectedStepIds = new Set();
  if (flow) {
    for (var i=0; i<flow.steps.length; i++) {
      inFlow.add(flow.steps[i].from); inFlow.add(flow.steps[i].to);
      if (state.selectedStep && flow.steps[i].n === state.selectedStep) {
        selectedStepIds.add(flow.steps[i].from); selectedStepIds.add(flow.steps[i].to);
      }
    }
  }

  // Boxes
  layout.boxPos.forEach(function (p, id) {
    var box = p.box;
    var hi = flow && inFlow.has(id);
    var dim = flow && !inFlow.has(id);
    var isSelStep = selectedStepIds.has(id);
    var node = el("g", { class: "flow-box", transform: "translate(" + p.x + "," + p.y + ")" });
    var rect = el("rect", {
      width: p.w, height: p.h, rx: 6, ry: 6,
      fill: hi ? (isSelStep ? "#3a2c00" : "#1f1900") : "rgba(28,37,48,0.55)",
      stroke: hi ? "#ffdf5d" : (box.color || "#3a4858"),
      "stroke-width": hi ? (isSelStep ? 2 : 1.4) : 1,
      opacity: dim ? 0.12 : 1,
    });
    node.appendChild(rect);
    node.appendChild(el("text", { x: 12, y: 19, fill: hi ? "#ffdf5d" : "#e6edf3",
      "font-size": 12, "font-weight": 600, opacity: dim ? 0.2 : 1 }, truncate(box.title, 28)));
    if (box.sublabel) {
      node.appendChild(el("text", { x: 12, y: 35, fill: "#8b949e", "font-size": 10,
        opacity: dim ? 0.2 : 1 }, truncate(box.sublabel, 36)));
    }
    node.addEventListener("click", function (ev) {
      ev.stopPropagation();
      state.selected = { kind: "box", id: id };
      renderDetail();
      render();
    });
    g.appendChild(node);
  });

  // Flow arrows + numbered step circles
  if (flow) {
    var arrowDefs = el("defs");
    arrowDefs.innerHTML = '<marker id="arrowhead-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ffdf5d"/></marker>';
    g.appendChild(arrowDefs);

    // Count intra-package step indices per box so we can stack inline chips
    var intraStackByBox = new Map();

    function chipAt(boxPos, idx, step, active) {
      // Position chip inside box, stacked along the right edge near the bottom
      var px = boxPos.x + boxPos.w - 18;
      var py = boxPos.y + boxPos.h - 12 - idx * 20;
      // Wrap if too tall: shift left and reset
      if (py < boxPos.y + 36) { px = boxPos.x + boxPos.w - 18 - 22; py = boxPos.y + boxPos.h - 12; }
      var chip = el("g", { class: "step-num" + (active ? " active" : ""), transform: "translate(" + px + "," + py + ")" });
      chip.appendChild(el("circle", { r: 8, fill: active ? "#fff" : "#ffdf5d", stroke: "#0b0d10", "stroke-width": 1.5 }));
      chip.appendChild(el("text", { y: 3, "text-anchor": "middle", "font-size": 9, "font-weight": 700, fill: "#0b0d10" }, String(step.n)));
      chip.addEventListener("click", function (n) { return function (ev) { ev.stopPropagation(); selectStep(n); }; }(step.n));
      g.appendChild(chip);
    }

    for (var si=0; si<flow.steps.length; si++) {
      var step = flow.steps[si];
      // Resolve box positions, falling back to boxFrom/boxTo for intra-package module-level steps
      var fromKey = layout.boxPos.has(step.from) ? step.from : step.boxFrom;
      var toKey = layout.boxPos.has(step.to) ? step.to : step.boxTo;
      var from = layout.boxPos.get(fromKey);
      var to = layout.boxPos.get(toKey);
      if (!from || !to) continue;
      var active = state.selectedStep === step.n;
      var intra = fromKey === toKey;

      if (intra) {
        // Render an inline numbered chip inside the box (no arrow)
        var idx = intraStackByBox.get(fromKey) || 0;
        intraStackByBox.set(fromKey, idx + 1);
        chipAt(from, idx, step, active);
        continue;
      }

      var sameLane = from.laneId === to.laneId;
      var x1, y1, x2, y2;
      if (sameLane) {
        if (to.y > from.y) {
          x1 = from.x + from.w / 2; y1 = from.y + from.h;
          x2 = to.x + to.w / 2; y2 = to.y;
        } else {
          x1 = from.x + from.w / 2; y1 = from.y;
          x2 = to.x + to.w / 2; y2 = to.y + to.h;
        }
      } else if (to.x > from.x) {
        x1 = from.x + from.w; y1 = from.y + from.h / 2;
        x2 = to.x; y2 = to.y + to.h / 2;
      } else {
        x1 = from.x; y1 = from.y + from.h / 2;
        x2 = to.x + to.w; y2 = to.y + to.h / 2;
      }
      var p = el("path", {
        class: "edge flow" + (active ? " active" : ""),
        d: flowPath(x1, y1, x2, y2),
        "marker-end": "url(#arrowhead-flow)",
        opacity: active || state.selectedStep == null ? 0.95 : 0.35,
      });
      g.appendChild(p);
      var mx = (x1 + x2) / 2;
      var my = (y1 + y2) / 2;
      var circle = el("g", {
        class: "step-num" + (active ? " active" : ""),
        transform: "translate(" + mx + "," + my + ")"
      });
      circle.appendChild(el("circle", { r: 11, fill: active ? "#fff" : "#ffdf5d", stroke: "#0b0d10", "stroke-width": 2 }));
      circle.appendChild(el("text", { y: 4, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: "#0b0d10" }, String(step.n)));
      circle.addEventListener("click", function (n) {
        return function (ev) { ev.stopPropagation(); selectStep(n); };
      }(step.n));
      g.appendChild(circle);
    }
  }
}

function flowPath(x1, y1, x2, y2) {
  // S-curve for cleaner routing
  var dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) > Math.abs(dy)) {
    var c1x = x1 + dx * 0.5, c1y = y1;
    var c2x = x2 - dx * 0.5, c2y = y2;
    return "M " + x1 + " " + y1 + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + x2 + " " + y2;
  } else {
    var c1xv = x1, c1yv = y1 + dy * 0.5;
    var c2xv = x2, c2yv = y2 - dy * 0.5;
    return "M " + x1 + " " + y1 + " C " + c1xv + " " + c1yv + ", " + c2xv + " " + c2yv + ", " + x2 + " " + y2;
  }
}

function layoutSystem(map, W, H) {
  var containers = map.containers.map(function (c) {
    var mods = map.modules.filter(function (m) { return containerIdOf(m) === c.id; });
    var counts = {};
    for (var i=0; i<mods.length; i++) {
      var l = layerOf(mods[i]); counts[l] = (counts[l] || 0) + 1;
    }
    var dominant = LAYER_ORDER.slice().sort(function (a,b) { return (counts[b]||0) - (counts[a]||0); })[0] || "support";
    var sinks = new Set();
    for (var j=0; j<mods.length; j++) (mods[j].sinks || []).forEach(function (s) { sinks.add(s); });
    return Object.assign({}, c, { dominant: dominant, moduleCount: mods.length,
      hasEntry: mods.some(function (m) { return !!m.entryPoint; }), sinks: Array.from(sinks) });
  });
  containers.sort(function (a,b) {
    var d = LAYER_ORDER.indexOf(a.dominant) - LAYER_ORDER.indexOf(b.dominant);
    return d !== 0 ? d : b.moduleCount - a.moduleCount;
  });
  var bandH = H / LAYER_ORDER.length;
  var positions = new Map();
  var perLayer = new Map();
  containers.forEach(function (c) {
    if (!perLayer.has(c.dominant)) perLayer.set(c.dominant, []);
    perLayer.get(c.dominant).push(c);
  });
  perLayer.forEach(function (cs, layer) {
    var idx = LAYER_ORDER.indexOf(layer);
    var y = bandH * idx + bandH / 2;
    var cols = Math.max(1, cs.length);
    cs.forEach(function (c, i) {
      var colW = W / cols;
      var x = colW * i + colW / 2;
      var w = Math.max(120, Math.min(colW * 0.85, 80 + Math.sqrt(c.moduleCount) * 26));
      var h = Math.max(60, Math.min(bandH * 0.8, 50 + Math.sqrt(c.moduleCount) * 14));
      positions.set(c.id, { x: x - w / 2, y: y - h / 2, w: w, h: h, container: c });
    });
  });
  return { positions: positions, containers: containers };
}

function layoutModules(map, W, H) {
  var containers = map.containers.slice().sort(function (a,b) { return b.moduleCount - a.moduleCount; });
  var n = containers.length;
  var cols = Math.ceil(Math.sqrt(n * (W / H)));
  var rows = Math.ceil(n / cols);
  var pad = 16;
  var cellW = (W - pad) / cols;
  var cellH = (H - pad) / rows;
  var containerPos = new Map();
  containers.forEach(function (c, i) {
    var cx = i % cols, cy = Math.floor(i / cols);
    containerPos.set(c.id, { x: pad + cx * cellW, y: pad + cy * cellH, w: cellW - pad, h: cellH - pad, container: c });
  });
  var modulePos = new Map();
  containers.forEach(function (c) {
    var slot = containerPos.get(c.id); if (!slot) return;
    var mods = map.modules.filter(function (m) { return containerIdOf(m) === c.id; });
    mods.sort(function (a,b) {
      if ((a.entryPoint?1:0) !== (b.entryPoint?1:0)) return (b.entryPoint?1:0) - (a.entryPoint?1:0);
      var la = LAYER_ORDER.indexOf(layerOf(a)), lb = LAYER_ORDER.indexOf(layerOf(b));
      if (la !== lb) return la - lb;
      return b.loc - a.loc;
    });
    if (mods.length === 0) return;
    var innerW = slot.w - 16, innerH = slot.h - 28;
    var mcols = Math.max(1, Math.ceil(Math.sqrt(mods.length * Math.max(0.001, innerW / Math.max(1, innerH)))));
    var mw = innerW / mcols, mh = innerH / Math.max(1, Math.ceil(mods.length / mcols));
    mods.forEach(function (m, i) {
      var x = slot.x + 8 + (i % mcols) * mw + mw / 2;
      var y = slot.y + 22 + Math.floor(i / mcols) * mh + mh / 2;
      modulePos.set(m.id, { x: x, y: y, m: m });
    });
  });
  return { containerPos: containerPos, modulePos: modulePos, containers: containers };
}

function el(tag, attrs, text) {
  var e = document.createElementNS(SVG_NS, tag);
  if (attrs) for (var k in attrs) {
    if (attrs[k] == null) continue;
    e.setAttribute(k, attrs[k]);
  }
  if (text != null) e.textContent = text;
  return e;
}
function arrow(x1, y1, x2, y2, attrs) {
  var dx = x2 - x1, dy = y2 - y1;
  var c1x = x1 + dx * 0.25, c1y = y1 + dy * 0.5;
  var c2x = x1 + dx * 0.75, c2y = y2 - dy * 0.1;
  attrs = attrs || {};
  var p = el("path", Object.assign({}, attrs, { d: "M" + x1 + " " + y1 + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + x2 + " " + y2 }));
  return p;
}

function render() {
  var map = state.map; if (!map) return;
  var W = svg.clientWidth, H = svg.clientHeight;
  svg.innerHTML = "";
  var g = el("g", { id: "world" });
  tx(g);
  svg.appendChild(g);
  if (state.view === "architecture") renderArchitecture(g, W, H);
  else if (state.view === "modules") renderModules(g, W, H);
  else if (state.view === "insights") renderInsights(g, W, H);
  else renderFlowsSwimlane(g, W, H);
  $("legend").innerHTML = legendHtml();
  $("hud").textContent = hudText();
}

function legendHtml() {
  var s = "";
  if (state.view === "architecture" && state.map.groups) {
    state.map.groups.forEach(function (gr) {
      s += '<div class="row"><div class="dot" style="background:' + gr.color + '"></div>' + escapeHtml(gr.name) + '</div>';
    });
  } else if (state.view === "flows" && state.map.lanes) {
    state.map.lanes.forEach(function (l) {
      s += '<div class="row"><div class="dot" style="background:' + l.color + '"></div>' + l.name + '</div>';
    });
  } else if (state.view === "insights") {
    (state.map.clusters || []).slice(0, 8).forEach(function (c) {
      s += '<div class="row"><div class="dot" style="background:' + clusterColor(c.id) + '"></div>' + escapeHtml(c.label) + ' (' + c.size + ')</div>';
    });
    s += '<div class="row"><div class="dot" style="background:#fff;border:1px solid #888"></div>god node (larger)</div>';
    s += '<div class="row"><div class="dot" style="background:#ff5c5c"></div>surprising edge</div>';
  } else {
    LAYER_ORDER.forEach(function (l) {
      s += '<div class="row"><div class="dot" style="background:' + LAYER_COLOR[l] + '"></div>' + l + '</div>';
    });
    s += '<div class="row"><div class="dot" style="background:#ffdf5d"></div>entry point</div>';
    s += '<div class="row"><div class="dot" style="background:#ff7b72"></div>sink</div>';
  }
  return s;
}
function hudText() {
  if (state.view === "architecture") {
    var c = (state.map.containers || []).length;
    var gN = (state.map.groups || []).length;
    return "Architecture · " + gN + " groups, " + c + " packages · click a package · double-click a group to focus · ESC to clear";
  }
  if (state.view === "flows") {
    if (state.selectedFlow) {
      var f = state.map.flows.find(function (x) { return x.id === state.selectedFlow; });
      return f ? "FLOW: " + f.name + " — " + f.steps.length + " steps" : "";
    }
    return "Pick a flow on the right to highlight the path through the system";
  }
  if (state.view === "insights") {
    var god = (state.map.hotspots && state.map.hotspots.godNodes) || [];
    return "Insights · " + ((state.map.clusters || []).length) + " clusters · " + god.length + " god-nodes · " + ((state.map.surprisingConnections || []).length) + " surprising edges · hover a node for detail";
  }
  if (state.focus) return "focused on " + state.focus.kind + ":" + state.focus.id + " — " + state.focus.set.size + " module(s) (esc to clear)";
  return state.view + " view · scroll = zoom · drag = pan · click = focus";
}

// ====================== Architecture (nested-containers) view ======================

// Slice-and-dice treemap: divides a rect into N sub-rects weighted by item.weight.
function slice(rect, items, getWeight) {
  if (items.length === 0) return [];
  var total = 0;
  for (var i=0; i<items.length; i++) total += Math.max(1, getWeight(items[i]));
  var out = [];
  var horizontal = rect.w >= rect.h;
  var cx = rect.x, cy = rect.y;
  for (var j=0; j<items.length; j++) {
    var w = Math.max(1, getWeight(items[j]));
    var frac = w / total;
    if (horizontal) {
      var subW = Math.max(1, rect.w * frac);
      out.push({ x: cx, y: rect.y, w: subW, h: rect.h, item: items[j] });
      cx += subW;
    } else {
      var subH = Math.max(1, rect.h * frac);
      out.push({ x: rect.x, y: cy, w: rect.w, h: subH, item: items[j] });
      cy += subH;
    }
  }
  return out;
}

// Grid layout that always fits N items into a rect, deterministic columns by aspect ratio.
function gridLayout(rect, items) {
  if (items.length === 0) return [];
  var aspect = rect.w / Math.max(1, rect.h);
  var cols = Math.max(1, Math.round(Math.sqrt(items.length * aspect)));
  cols = Math.min(cols, items.length);
  var rows = Math.ceil(items.length / cols);
  var cw = rect.w / cols, rh = rect.h / rows;
  var out = [];
  for (var i=0; i<items.length; i++) {
    var col = i % cols, row = Math.floor(i / cols);
    out.push({ x: rect.x + col * cw, y: rect.y + row * rh, w: cw, h: rh, item: items[i] });
  }
  return out;
}

function layoutArchitecture(map, W, H) {
  var groups = (map.groups || []).slice();
  if (groups.length === 0) return { groupPos: new Map(), packagePos: new Map() };
  groups.sort(function (a, b) { return (b.moduleCount || 0) - (a.moduleCount || 0); });
  var pad = 18, gap = 12;
  var outerRect = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  // Use slice-and-dice weighted by sqrt(moduleCount) so small groups stay readable.
  var groupSlots = slice(outerRect, groups, function (g) { return Math.sqrt(Math.max(1, g.moduleCount || 1)); });
  var groupPos = new Map();
  var packagePos = new Map();
  for (var i=0; i<groupSlots.length; i++) {
    var slot = groupSlots[i];
    var grp = slot.item;
    var inset = { x: slot.x + gap/2, y: slot.y + gap/2, w: slot.w - gap, h: slot.h - gap };
    var collapsed = !!state.collapsedGroups[grp.id];
    groupPos.set(grp.id, { x: inset.x, y: inset.y, w: inset.w, h: inset.h, group: grp, collapsed: collapsed });
    if (collapsed) continue;
    var memberContainers = grp.members.map(function (id) { return map.containers.find(function (c) { return c.id === id; }); }).filter(Boolean);
    if (memberContainers.length === 0) continue;
    var headerH = 34;
    var pkgRect = { x: inset.x + 8, y: inset.y + headerH, w: Math.max(40, inset.w - 16), h: Math.max(40, inset.h - headerH - 8) };
    // Grid layout — always fits everything inside the group
    var pkgSlots = gridLayout(pkgRect, memberContainers);
    for (var k=0; k<pkgSlots.length; k++) {
      var ps = pkgSlots[k];
      var ix = ps.x + 3, iy = ps.y + 3, iw = Math.max(40, ps.w - 6), ih = Math.max(34, ps.h - 6);
      packagePos.set(ps.item.id, { x: ix, y: iy, w: iw, h: ih, container: ps.item, groupId: grp.id });
    }
  }
  return { groupPos: groupPos, packagePos: packagePos };
}

function hideTooltip() { $("tooltip").style.display = "none"; }
function showTooltip(html, ev) {
  var tt = $("tooltip");
  tt.innerHTML = html;
  tt.style.display = "block";
  // Position relative to viewport, clamped to viz
  var viz = $("viz").getBoundingClientRect();
  var x = (ev.clientX - viz.left) + 14;
  var y = (ev.clientY - viz.top) + 14;
  var ttW = tt.offsetWidth, ttH = tt.offsetHeight;
  if (x + ttW > viz.width) x = viz.width - ttW - 6;
  if (y + ttH > viz.height) y = viz.height - ttH - 6;
  tt.style.left = x + "px"; tt.style.top = y + "px";
}

function tooltipPackageHtml(container, groupName) {
  var top = (container.topFiles || []).slice(0, 5);
  var html = '<div class="tt-title">' + escapeHtml(container.name) + '</div>';
  if (container.description) html += '<div class="tt-desc">' + escapeHtml(container.description) + '</div>';
  html += '<div class="tt-section">Group</div><div>' + escapeHtml(groupName || "—") + '</div>';
  if (top.length) {
    html += '<div class="tt-section">Top Files (' + top.length + ')</div><ul>';
    for (var i=0; i<top.length; i++) {
      html += '<li><span class="tt-reason">' + escapeHtml(top[i].reason) + '</span>' +
        '<span>' + escapeHtml(top[i].path.split("/").slice(-2).join("/")) + '</span>' +
        '<span class="tt-loc">' + top[i].loc + '</span></li>';
    }
    html += '</ul>';
  }
  return html;
}

function tooltipEdgeHtml(edge) {
  var labels = (edge.labels || [edge.label]).join(", ");
  var samples = (edge.symbolSamples || []).slice(0, 5).map(function (s) { return '<code>' + escapeHtml(s) + '</code>'; }).join(", ");
  var html = '<div class="tt-title">' + escapeHtml(edge.from.replace(/^pkg:/, "")) +
    ' <span style="color:var(--muted)">→</span> ' + escapeHtml(edge.to.replace(/^pkg:/, "")) + '</div>';
  html += '<div class="tt-desc"><b>' + escapeHtml(labels) + '</b> · ' +
    edge.count + ' imports · ' + (edge.callCount || 0) + ' calls</div>';
  if (samples) html += '<div class="tt-section">Top symbols</div><div>' + samples + '</div>';
  return html;
}

function renderArchitecture(g, W, H) {
  var map = state.map;
  var layout = layoutArchitecture(map, W, H);
  state.lastArchLayout = layout;
  var groups = map.groups || [];
  var groupById = {}; for (var ig=0; ig<groups.length; ig++) groupById[groups[ig].id] = groups[ig];

  // 1) Group rectangles (containers)
  layout.groupPos.forEach(function (gp, id) {
    var grp = gp.group;
    var color = grp.color || "#8b949e";
    var focusedGroup = state.focus && state.focus.kind === "group" && state.focus.id === id;
    var rect = el("rect", {
      class: "group-rect" + (gp.collapsed ? " collapsed" : "") + (focusedGroup ? " focused" : ""),
      x: gp.x, y: gp.y, width: gp.w, height: gp.h, rx: 12, ry: 12,
      stroke: color, fill: "rgba(28,37,48,0.32)",
    });
    g.appendChild(rect);
    // Header strip
    g.appendChild(el("rect", { class: "group-header",
      x: gp.x, y: gp.y, width: gp.w, height: 30, rx: 12, ry: 12 }));
    g.appendChild(el("text", { class: "group-name", x: gp.x + 14, y: gp.y + 20, fill: color }, grp.name));
    var sub = grp.members.length + " pkgs · " + (grp.moduleCount || 0) + " modules" + (grp.source === "curated" ? " · curated" : "");
    g.appendChild(el("text", { class: "group-sub", x: gp.x + gp.w - 14, y: gp.y + 20, "text-anchor": "end" }, sub));
    // Click on header area toggles collapse; double-click sets focus
    rect.addEventListener("dblclick", function (ev) {
      ev.stopPropagation();
      var set = new Set();
      for (var i=0; i<map.containers.length; i++) {
        var c = map.containers[i];
        if (c.groupId === id) {
          set.add(c.id);
          var mods = map.modules.filter(function (m) { return containerIdOf(m) === c.id; });
          for (var k=0; k<mods.length; k++) set.add(mods[k].id);
        }
      }
      state.focus = { kind: "group", id: id, set: set };
      render();
    });
    // Click on header (top 30px) toggles collapse
    rect.addEventListener("click", function (ev) {
      var rectBox = rect.getBoundingClientRect();
      if (ev.clientY - rectBox.top <= 30) {
        ev.stopPropagation();
        state.collapsedGroups[id] = !state.collapsedGroups[id];
        render();
      }
    });
  });

  // 2) Package rectangles inside expanded groups
  layout.packagePos.forEach(function (pp, id) {
    var c = pp.container;
    var grp = groupById[pp.groupId] || { color: "#3a4858" };
    var sel = state.selected && state.selected.kind === "box" && state.selected.id === id;
    var dim = state.focus && !state.focus.set.has(id);
    var rect = el("rect", {
      class: "pkg-rect" + (sel ? " selected" : "") + (dim ? " dim" : ""),
      x: pp.x, y: pp.y, width: pp.w, height: pp.h, rx: 8, ry: 8,
      stroke: grp.color || "#3a4858",
    });
    g.appendChild(rect);
    g.appendChild(el("text", { class: "pkg-title", x: pp.x + 10, y: pp.y + 18 },
      truncate(c.name, Math.max(8, Math.floor(pp.w / 7.5)))));
    var entryCount = (c.topFiles || []).filter(function (t) { return /entry|HTTP/.test(t.reason); }).length;
    var sub = (c.moduleCount || 0) + " modules" + (entryCount ? " · " + entryCount + " entry" : "");
    g.appendChild(el("text", { class: "pkg-sub", x: pp.x + 10, y: pp.y + 32 }, sub));
    // Show 1-3 top file paths inline if there's vertical space
    if (pp.h >= 76) {
      var top = (c.topFiles || []).slice(0, Math.min(3, Math.floor((pp.h - 40) / 14)));
      for (var t=0; t<top.length; t++) {
        var label = top[t].reason + ": " + top[t].path.split("/").slice(-2).join("/");
        g.appendChild(el("text", { class: "pkg-topfiles", x: pp.x + 10, y: pp.y + 48 + t * 13 },
          truncate(label, Math.max(10, Math.floor(pp.w / 6.5)))));
      }
    }
    rect.addEventListener("click", function (ev) {
      ev.stopPropagation();
      state.selected = { kind: "box", id: id };
      renderDetail();
      render();
    });
    rect.addEventListener("mouseenter", function (ev) {
      showTooltip(tooltipPackageHtml(c, grp.name), ev);
    });
    rect.addEventListener("mousemove", function (ev) {
      showTooltip(tooltipPackageHtml(c, grp.name), ev);
    });
    rect.addEventListener("mouseleave", hideTooltip);
  });

  // 3) Build collapsed cross-group edges if any group is collapsed
  var collapsedSet = new Set(Object.keys(state.collapsedGroups).filter(function (k) { return state.collapsedGroups[k]; }));
  // Build container → group lookup
  var groupOfContainer = {}; for (var ic=0; ic<map.containers.length; ic++) groupOfContainer[map.containers[ic].id] = map.containers[ic].groupId;

  // 4) Cross-package + cross-group edges with labeled chips
  var crossGroupAgg = new Map(); // "fromG→toG" -> agg
  var edges = map.containerEdges || [];
  var defs = el("defs");
  defs.innerHTML = '<marker id="arrow-cross" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7ee787"/></marker>' +
    '<marker id="arrow-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#ffdf5d"/></marker>';
  g.appendChild(defs);

  for (var ei=0; ei<edges.length; ei++) {
    var edge = edges[ei];
    var fromG = groupOfContainer[edge.from];
    var toG = groupOfContainer[edge.to];
    var fromCollapsed = collapsedSet.has(fromG);
    var toCollapsed = collapsedSet.has(toG);
    if (fromCollapsed || toCollapsed) {
      var k = fromG + "→" + toG;
      if (!crossGroupAgg.has(k)) crossGroupAgg.set(k, { from: fromG, to: toG, count: 0, callCount: 0, labels: new Set() });
      var ag = crossGroupAgg.get(k);
      ag.count += edge.count;
      ag.callCount += (edge.callCount || 0);
      ag.labels.add(edge.label);
      continue;
    }
    var fromPos = layout.packagePos.get(edge.from);
    var toPos = layout.packagePos.get(edge.to);
    if (!fromPos || !toPos) continue;
    var x1, y1, x2, y2;
    // Pick anchor points on box edges nearest to the other box
    var fcx = fromPos.x + fromPos.w/2, fcy = fromPos.y + fromPos.h/2;
    var tcx = toPos.x + toPos.w/2, tcy = toPos.y + toPos.h/2;
    if (Math.abs(tcx - fcx) >= Math.abs(tcy - fcy)) {
      // Horizontal-dominant: use right/left edges
      x1 = tcx > fcx ? fromPos.x + fromPos.w : fromPos.x;
      y1 = fcy;
      x2 = tcx > fcx ? toPos.x : toPos.x + toPos.w;
      y2 = tcy;
    } else {
      x1 = fcx;
      y1 = tcy > fcy ? fromPos.y + fromPos.h : fromPos.y;
      x2 = tcx;
      y2 = tcy > fcy ? toPos.y : toPos.y + toPos.h;
    }
    var sw = Math.min(4, 0.8 + Math.log2(edge.count + 1));
    var path = el("path", {
      class: "edge cross",
      d: flowPath(x1, y1, x2, y2),
      "stroke-width": sw,
      "marker-end": "url(#arrow-cross)",
    });
    g.appendChild(path);
    // Wide invisible hit area for hover
    var hit = el("path", {
      class: "edge-hit", d: flowPath(x1, y1, x2, y2),
    });
    g.appendChild(hit);
    hit.addEventListener("mouseenter", function (e) { return function (ev) { showTooltip(tooltipEdgeHtml(e), ev); }; }(edge));
    hit.addEventListener("mousemove", function (e) { return function (ev) { showTooltip(tooltipEdgeHtml(e), ev); }; }(edge));
    hit.addEventListener("mouseleave", hideTooltip);
    // Label chip at midpoint (skip when edge is too short)
    var dist = Math.hypot(x2 - x1, y2 - y1);
    if (dist >= 80 && edge.label) {
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      var labelText = edge.label;
      var chipW = labelText.length * 6.2 + 12;
      var labelClass = "edge-label-text " + labelText.toLowerCase().replace(/\s+/g, "-");
      var chip = el("g", { transform: "translate(" + mx + "," + my + ")" });
      chip.appendChild(el("rect", { class: "edge-label-bg", x: -chipW/2, y: -9, width: chipW, height: 18, rx: 4, ry: 4 }));
      chip.appendChild(el("text", { class: labelClass, x: 0, y: 3, "text-anchor": "middle" }, labelText));
      g.appendChild(chip);
    }
  }

  // 5) Collapsed group → group aggregate edges
  crossGroupAgg.forEach(function (agg) {
    var fromGP = layout.groupPos.get(agg.from), toGP = layout.groupPos.get(agg.to);
    if (!fromGP || !toGP) return;
    var fcx = fromGP.x + fromGP.w/2, fcy = fromGP.y + fromGP.h/2;
    var tcx = toGP.x + toGP.w/2, tcy = toGP.y + toGP.h/2;
    var x1, y1, x2, y2;
    if (Math.abs(tcx - fcx) >= Math.abs(tcy - fcy)) {
      x1 = tcx > fcx ? fromGP.x + fromGP.w : fromGP.x; y1 = fcy;
      x2 = tcx > fcx ? toGP.x : toGP.x + toGP.w; y2 = tcy;
    } else {
      x1 = fcx; y1 = tcy > fcy ? fromGP.y + fromGP.h : fromGP.y;
      x2 = tcx; y2 = tcy > fcy ? toGP.y : toGP.y + toGP.h;
    }
    g.appendChild(el("path", { class: "edge cross", d: flowPath(x1, y1, x2, y2),
      "stroke-width": Math.min(6, 1.5 + Math.log2(agg.count + 1)),
      "marker-end": "url(#arrow-cross)" }));
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var labelText = (agg.from.replace(/^group:/, "") + " → " + agg.to.replace(/^group:/, "") + " · " + agg.count);
    var chipW = labelText.length * 6.2 + 12;
    var chip = el("g", { transform: "translate(" + mx + "," + my + ")" });
    chip.appendChild(el("rect", { class: "edge-label-bg", x: -chipW/2, y: -9, width: chipW, height: 18, rx: 4, ry: 4 }));
    chip.appendChild(el("text", { class: "edge-label-text", x: 0, y: 3, "text-anchor": "middle" }, labelText));
    g.appendChild(chip);
  });

  // 6) Optional yellow flow overlay
  if (state.overlayFlow && state.selectedFlow) {
    overlayFlowOnArchitecture(g, layout);
  }
}

function overlayFlowOnArchitecture(g, layout) {
  var map = state.map;
  var flow = map.flows.find(function (f) { return f.id === state.selectedFlow; });
  if (!flow) return;
  var intraStack = new Map();
  for (var si=0; si<flow.steps.length; si++) {
    var step = flow.steps[si];
    var fromKey = layout.packagePos.has(step.from) ? step.from : step.boxFrom;
    var toKey = layout.packagePos.has(step.to) ? step.to : step.boxTo;
    var from = layout.packagePos.get(fromKey);
    var to = layout.packagePos.get(toKey);
    if (!from || !to) continue;
    if (fromKey === toKey) {
      // Intra-package chip
      var idx = intraStack.get(fromKey) || 0;
      intraStack.set(fromKey, idx + 1);
      var px = from.x + from.w - 16, py = from.y + from.h - 12 - idx * 18;
      if (py < from.y + 36) { px = from.x + from.w - 16 - 20; py = from.y + from.h - 12; }
      var chip = el("g", { transform: "translate(" + px + "," + py + ")" });
      chip.appendChild(el("circle", { r: 7, fill: "#ffdf5d", stroke: "#0b0d10", "stroke-width": 1.5 }));
      chip.appendChild(el("text", { y: 3, "text-anchor": "middle", "font-size": 9, "font-weight": 700, fill: "#0b0d10" }, String(step.n)));
      g.appendChild(chip);
      continue;
    }
    var x1 = from.x + from.w / 2, y1 = from.y + from.h / 2;
    var x2 = to.x + to.w / 2, y2 = to.y + to.h / 2;
    g.appendChild(el("path", { class: "edge flow", d: flowPath(x1, y1, x2, y2),
      "stroke-width": 2, "marker-end": "url(#arrow-flow)" }));
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var chip2 = el("g", { transform: "translate(" + mx + "," + my + ")" });
    chip2.appendChild(el("circle", { r: 10, fill: "#ffdf5d", stroke: "#0b0d10", "stroke-width": 2 }));
    chip2.appendChild(el("text", { y: 4, "text-anchor": "middle", "font-size": 10, "font-weight": 700, fill: "#0b0d10" }, String(step.n)));
    g.appendChild(chip2);
  }
}

function renderSystem(g, W, H) {
  var map = state.map;
  var layout = layoutSystem(map, W, H);
  var bandH = H / LAYER_ORDER.length;
  for (var i=0; i<LAYER_ORDER.length; i++) {
    var l = LAYER_ORDER[i];
    g.appendChild(el("text", { class:"layer-label", x: 10, y: bandH * i + 14 }, l));
    g.appendChild(el("line", { class:"layer-band", x1: 0, x2: W, y1: bandH * (i+1), y2: bandH * (i+1) }));
  }
  for (var ei=0; ei<map.containerEdges.length; ei++) {
    var ed = map.containerEdges[ei];
    var a = layout.positions.get(ed.from), b = layout.positions.get(ed.to);
    if (!a || !b) continue;
    var ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    var bx = b.x + b.w / 2, by = b.y + b.h / 2;
    var hi = state.focus && state.focus.kind === "package" && (state.focus.id === ed.from || state.focus.id === ed.to);
    var sw = Math.min(6, 1 + Math.log2(ed.count + 1));
    g.appendChild(arrow(ax, ay, bx, by, { class: "edge cross" + (hi ? " hi" : ""), "stroke-width": sw }));
  }
  layout.positions.forEach(function (p, id) {
    var c = p.container;
    var hi = (state.focus && state.focus.kind === "package" && state.focus.id === id);
    var rect = el("rect", { class: "container-rect" + (hi ? " hi" : ""),
      x: p.x, y: p.y, width: p.w, height: p.h, rx: 10, ry: 10 });
    rect.style.cursor = "pointer";
    rect.addEventListener("click", function (ev) { ev.stopPropagation(); focusPackage(id); });
    g.appendChild(rect);
    g.appendChild(el("text", { class: "container-label", x: p.x + 10, y: p.y + 16 }, c.name));
    g.appendChild(el("text", { class: "container-label", x: p.x + 10, y: p.y + 32, fill: LAYER_COLOR[c.dominant] },
      c.dominant + " · " + c.moduleCount + "m" + (c.hasEntry ? " · entry" : "") + (c.sinks.length ? " · " + c.sinks.length + " sinks" : "")));
  });
}

function renderModules(g, W, H) {
  var map = state.map;
  var layout = layoutModules(map, W, H);
  layout.containerPos.forEach(function (p, cid) {
    var hi = (state.focus && state.focus.kind === "package" && state.focus.id === cid);
    var r = el("rect", { class: "container-rect" + (hi ? " hi" : ""),
      x: p.x, y: p.y, width: p.w, height: p.h, rx: 8, ry: 8 });
    g.appendChild(r);
    g.appendChild(el("text", { class: "container-label", x: p.x + 8, y: p.y + 14 }, p.container.name));
  });
  for (var i=0; i<map.edges.length; i++) {
    var e = map.edges[i]; if (e.kind !== "import") continue;
    var a = layout.modulePos.get(e.from), b = layout.modulePos.get(e.to);
    if (!a || !b) continue;
    var focused = state.focus && state.focus.set.has(e.from) && state.focus.set.has(e.to);
    var dim = state.focus && !focused;
    var cross = containerIdOf(a.m) !== containerIdOf(b.m);
    g.appendChild(arrow(a.x, a.y, b.x, b.y, { class: "edge" + (cross ? " cross" : "") + (dim ? " dim" : "") + (focused ? " hi" : ""), "stroke-width": cross ? 1.4 : 0.8 }));
  }
  layout.modulePos.forEach(function (p, id) {
    var m = p.m;
    var dim = state.focus && !state.focus.set.has(id);
    var color = m.entryPoint ? "#ffdf5d" : (m.sinks && m.sinks.length > 0 ? "#ff7b72" : LAYER_COLOR[layerOf(m)]);
    var r = Math.max(2.5, Math.min(10, 2 + Math.sqrt(Math.max(1, m.loc / 25))));
    var node = el("g", { class: "module-node", transform: "translate(" + p.x + "," + p.y + ")" });
    if (dim) node.style.opacity = 0.15;
    node.appendChild(el("circle", { r: r, fill: color }));
    if (m.entryPoint) node.appendChild(el("circle", { r: r + 3, fill: "none", stroke: "#ffdf5d", "stroke-width": 1 }));
    g.appendChild(node);
  });
}

// ====================== Insights view (clusters · god-nodes · surprising connections) ======================
function clusterColor(cid) {
  if (!cid) return "#8b949e";
  var h = 0; for (var i=0; i<cid.length; i++) h = (h * 31 + cid.charCodeAt(i)) % 360;
  return "hsl(" + h + ",58%,62%)";
}
function renderInsights(g, W, H) {
  var map = state.map;
  var layout = layoutModules(map, W, H);
  var god = (map.hotspots && map.hotspots.godNodes) || [];
  var godIds = new Set(god.map(function (x) { return x.id; }));
  var godBy = {}; god.forEach(function (x) { godBy[x.id] = x; });
  layout.containerPos.forEach(function (p) {
    g.appendChild(el("rect", { class: "container-rect", x: p.x, y: p.y, width: p.w, height: p.h, rx: 8, ry: 8 }));
    g.appendChild(el("text", { class: "container-label", x: p.x + 8, y: p.y + 14 }, p.container.name));
  });
  // Surprising connections as hot dashed edges (only these — keeps the view legible).
  ((map.surprisingConnections) || []).forEach(function (x) {
    var a = layout.modulePos.get(x.from), b = layout.modulePos.get(x.to);
    if (!a || !b) return;
    var p = arrow(a.x, a.y, b.x, b.y, { class: "edge", stroke: "#ff5c5c", "stroke-width": 1.6, "stroke-dasharray": "4 3", opacity: 0.85 });
    p.appendChild(el("title", null, "surprising: " + x.reason + " (score " + x.score + ")"));
    g.appendChild(p);
  });
  // Module nodes colored by cluster; god-nodes enlarged + outlined.
  layout.modulePos.forEach(function (p, id) {
    var m = p.m;
    var isGod = godIds.has(id);
    var r = isGod ? Math.max(6, Math.min(16, 5 + Math.sqrt((m.loc || 1) / 20))) : Math.max(2, Math.min(8, 1.5 + Math.sqrt(Math.max(1, (m.loc || 1) / 30))));
    var node = el("g", { class: "module-node", transform: "translate(" + p.x + "," + p.y + ")" });
    var c = el("circle", { r: r, fill: clusterColor(m.cluster), stroke: isGod ? "#ffffff" : "none", "stroke-width": isGod ? 1.5 : 0 });
    node.appendChild(c);
    node.appendChild(el("title", null, m.path + (isGod ? " — god node (in " + godBy[id].inDegree + " · out " + godBy[id].outDegree + ")" : (m.cluster ? " — cluster " + m.cluster : ""))));
    g.appendChild(node);
  });
}

// ====================== Sidebars ======================

function renderSidebar() {
  var map = state.map;
  var ents = $("entry-list"); ents.innerHTML = "";
  var groups = { cli:[], http:[], library:[] };
  for (var i=0; i<map.entryPoints.length; i++) {
    var e = map.entryPoints[i];
    (groups[e.kind] = groups[e.kind] || []).push(e);
  }
  ["cli","http","library"].forEach(function (kind) {
    if (!groups[kind] || groups[kind].length === 0) return;
    var head = document.createElement("div");
    head.style.padding = "4px 14px"; head.style.color = "var(--muted)";
    head.style.fontSize = "10px"; head.style.textTransform = "uppercase"; head.style.letterSpacing = "1.2px";
    head.textContent = kind + " (" + groups[kind].length + ")";
    ents.appendChild(head);
    groups[kind].forEach(function (e) {
      var row = document.createElement("div"); row.className = "row";
      var label = e.name || e.path.split("/").pop();
      var sub = e.routes ? e.routes.slice(0,2).map(function (r) { return r.method + " " + r.path; }).join(", ") : (e.package || "");
      row.innerHTML = '<div class="dot" style="background:var(--entry)"></div>' +
        '<div class="name" title="' + escapeHtml(e.path) + '"><div>' + escapeHtml(label) + '</div>' +
        '<div style="color:var(--muted); font-size:10px">' + escapeHtml(sub) + '</div></div>';
      row.onclick = function () { selectFlow("flow:" + e.id); };
      ents.appendChild(row);
    });
  });

  var sinkCounts = {};
  for (var si=0; si<map.sinks.length; si++) {
    var s = map.sinks[si];
    for (var sk=0; sk<s.sinks.length; sk++) sinkCounts[s.sinks[sk]] = (sinkCounts[s.sinks[sk]] || 0) + 1;
  }
  var sl = $("sink-list"); sl.innerHTML = "";
  Object.keys(sinkCounts).sort(function (a,b) { return sinkCounts[b] - sinkCounts[a]; }).forEach(function (k) {
    var row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<div class="dot" style="background:var(--sink)"></div><div class="name">' + escapeHtml(k) + '</div><div class="count">' + sinkCounts[k] + '</div>';
    row.onclick = function () { focusSink(k); };
    sl.appendChild(row);
  });

  var ll = $("layer-list"); ll.innerHTML = "";
  LAYER_ORDER.forEach(function (l) {
    var n = map.stats.layers[l] || 0; if (!n) return;
    var row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<div class="dot" style="background:' + LAYER_COLOR[l] + '"></div><div class="name">' + escapeHtml(l) + '</div><div class="count">' + n + '</div>';
    ll.appendChild(row);
  });

  var pl = $("pkg-list"); pl.innerHTML = "";
  map.containers.slice().sort(function (a,b) { return b.moduleCount - a.moduleCount; }).forEach(function (c) {
    var row = document.createElement("div"); row.className = "row";
    row.innerHTML = '<div class="dot" style="background:#3a4858"></div><div class="name">' + escapeHtml(c.name) + '</div><div class="count">' + c.moduleCount + '</div>';
    row.onclick = function () { focusPackage(c.id); };
    pl.appendChild(row);
  });
}

function renderFlowList() {
  var map = state.map;
  var list = $("flow-list"); list.innerHTML = "";
  if (!map.flows || !map.flows.length) {
    list.innerHTML = '<div style="color:var(--muted); padding:8px 0">No flows detected. Add entry points (bin / HTTP routes) or curate .planning/codebase/FLOWS.json.</div>';
    return;
  }
  // Order: CLI first, then HTTP, then library
  var kindRank = { cli: 0, http: 1, library: 2 };
  var sorted = map.flows.slice().sort(function (a,b) {
    return (kindRank[a.entryKind]||3) - (kindRank[b.entryKind]||3);
  });
  sorted.forEach(function (f) {
    var item = document.createElement("div");
    item.className = "flow-item" + (state.selectedFlow === f.id ? " active" : "");
    item.innerHTML = '<div class="name">' + escapeHtml(f.name) + '</div>' +
      '<div class="desc">' + escapeHtml(f.description || "") + (f.curated ? ' <span style="color:var(--entry)">· curated</span>' : '') + '</div>';
    item.onclick = function () { selectFlow(f.id); };
    list.appendChild(item);
  });
}

function renderStepList() {
  var map = state.map;
  var list = $("step-list"); list.innerHTML = "";
  var f = state.selectedFlow ? map.flows.find(function (x) { return x.id === state.selectedFlow; }) : null;
  if (!f) {
    list.innerHTML = '<div style="color:var(--muted); padding:8px 0">Select a flow above to see numbered steps.</div>';
    return;
  }
  f.steps.forEach(function (step) {
    var item = document.createElement("div");
    item.className = "step-item" + (state.selectedStep === step.n ? " active" : "");
    var fromLabel = step.from.replace(/^pkg:/, "").replace(/^sink:/, "").replace(/^actor:/, "");
    var toLabel = step.to.replace(/^pkg:/, "").replace(/^sink:/, "").replace(/^actor:/, "");
    // Split off trailing code snippet if present
    var descHtml = "";
    if (step.description) {
      var snippet = null; var desc = step.description;
      var sm = desc.match(/^(.*?)\\s*\\\`([^\\\`]+)\\\`\\s*$/);
      if (sm && sm[2].length > 12 && /[(){};=]/.test(sm[2])) { desc = sm[1]; snippet = sm[2]; }
      descHtml = '<div class="desc">' + escapeHtml(desc).replace(/\\\`([^\\\`]+)\\\`/g, function (_, t) { return '<code>' + t + '</code>'; }) + '</div>';
      if (snippet) descHtml += '<div class="snippet">' + escapeHtml(snippet) + '</div>';
    }
    var fileRef = "";
    if (step.fromFile && step.toFile) {
      fileRef = '<div class="file-ref">' + escapeHtml(step.fromFile.split("/").slice(-2).join("/")) + ' → ' + escapeHtml(step.toFile.split("/").slice(-2).join("/")) + '</div>';
    } else if (step.sinkSite) {
      fileRef = '<div class="file-ref">' + escapeHtml(step.sinkSite.file) + ':' + step.sinkSite.line + '</div>';
    } else if (step.toFile) {
      fileRef = '<div class="file-ref">' + escapeHtml(step.toFile) + '</div>';
    }
    item.innerHTML = '<div class="num">' + step.n + '</div>' +
      '<div class="body">' +
      '<div class="title">' + escapeHtml(step.title || (fromLabel + " → " + toLabel)) + '</div>' +
      '<div class="from-to">' + escapeHtml(fromLabel) + ' <span style="color:var(--entry)">→</span> ' + escapeHtml(toLabel) + '</div>' +
      fileRef + descHtml +
      '</div>';
    item.onclick = function () { selectStep(step.n); };
    list.appendChild(item);
  });
}

function renderDetail() {
  var elD = $("detail");
  if (!state.selected) { elD.style.display = "none"; return; }
  var map = state.map;
  elD.style.display = "block";
  if (state.selected.kind === "box") {
    var id = state.selected.id;
    var box = (map.boxes || []).find(function (x) { return x.id === id; });
    if (!box) { elD.style.display = "none"; return; }
    var html = '<h3>' + escapeHtml(box.title) + '</h3>' +
      '<div class="pill">' + escapeHtml(box.lane) + '</div>' +
      (box.kind ? '<div class="pill">' + escapeHtml(box.kind) + '</div>' : '') +
      (box.sublabel ? '<div class="kv">' + escapeHtml(box.sublabel) + '</div>' : '');
    if (box.kind === "package") {
      var c = map.containers.find(function (x) { return x.id === id; });
      var mods = map.modules.filter(function (m) { return containerIdOf(m) === id; });
      var inE = map.containerEdges.filter(function (e) { return e.to === id; });
      var outE = map.containerEdges.filter(function (e) { return e.from === id; });
      html += '<h4 style="margin:10px 0 4px;font-size:11px;color:var(--muted)">DEPENDS ON</h4>' +
        (outE.length ? outE.map(function (e) { return '<div class="kv">→ ' + escapeHtml(e.to.replace(/^pkg:/,"")) + ' <span style="color:var(--muted)">(' + e.count + ')</span></div>'; }).join("") : '<div class="kv" style="color:var(--muted)">nothing</div>') +
        '<h4 style="margin:10px 0 4px;font-size:11px;color:var(--muted)">DEPENDED ON BY</h4>' +
        (inE.length ? inE.map(function (e) { return '<div class="kv">← ' + escapeHtml(e.from.replace(/^pkg:/,"")) + ' <span style="color:var(--muted)">(' + e.count + ')</span></div>'; }).join("") : '<div class="kv" style="color:var(--muted)">nothing</div>');
      var entryMods = mods.filter(function (m) { return !!m.entryPoint; });
      if (entryMods.length) {
        html += '<h4 style="margin:10px 0 4px;font-size:11px;color:var(--muted)">ENTRY POINTS</h4>';
        entryMods.forEach(function (m) {
          html += '<div class="kv">' + escapeHtml(m.entryPoint.name || m.path) + ' <span style="color:var(--muted)">(' + m.entryPoint.kind + ')</span></div>';
        });
      }
    }
    elD.innerHTML = html;
    return;
  }
}

// ====================== Camera ======================
function fit() { state.zoom = 1; state.pan = { x: 0, y: 0 }; render(); }

svg.addEventListener("mousedown", function (e) {
  state.drag = { x: e.clientX, y: e.clientY, pan: { x: state.pan.x, y: state.pan.y } };
});
window.addEventListener("mousemove", function (e) {
  if (!state.drag) return;
  state.pan.x = state.drag.pan.x + (e.clientX - state.drag.x);
  state.pan.y = state.drag.pan.y + (e.clientY - state.drag.y);
  var g = svg.querySelector("#world"); if (g) tx(g);
});
window.addEventListener("mouseup", function () { state.drag = null; });
svg.addEventListener("wheel", function (e) {
  e.preventDefault();
  var factor = Math.exp(-e.deltaY * 0.001);
  var rect = svg.getBoundingClientRect();
  var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  var newZoom = Math.max(0.15, Math.min(5, state.zoom * factor));
  state.pan.x = cx - ((cx - state.pan.x) * (newZoom / state.zoom));
  state.pan.y = cy - ((cy - state.pan.y) * (newZoom / state.zoom));
  state.zoom = newZoom;
  var g = svg.querySelector("#world"); if (g) tx(g);
}, { passive: false });

window.addEventListener("keydown", function (e) {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "f") fit();
  if (e.key === "Escape") clearFlow();
  if (e.key === "a") setView("architecture");
  if (e.key === "m") setView("modules");
  if (e.key === "F") setView("flows");
  if (e.key === "i") setView("insights");
});

$("tab-architecture").onclick = function () { setView("architecture"); };
$("tab-modules").onclick = function () { setView("modules"); };
$("tab-flows").onclick = function () { setView("flows"); };
$("tab-insights").onclick = function () { setView("insights"); };
$("fit").onclick = fit;
$("clear").onclick = function () { clearFlow(); state.collapsedGroups = {}; state.selected = null; render(); };
$("reload").onclick = function () { load(false); };
var overlayCb = $("overlay-flow-cb");
if (overlayCb) overlayCb.addEventListener("change", function (ev) { state.overlayFlow = ev.target.checked; render(); });

function connectLive() {
  try {
    var es = new EventSource("/events");
    es.onmessage = function (ev) { if (ev.data === "changed") load(false); };
    es.onerror = function () {
      $("live-indicator").classList.add("dead");
      $("live-indicator").textContent = "● offline";
    };
    es.onopen = function () {
      $("live-indicator").classList.remove("dead");
      $("live-indicator").textContent = "● live";
    };
  } catch (err) {}
}

window.addEventListener("resize", function () { render(); });
load(true).then(connectLive);
</script>
</body>
</html>`;
}

// GRAPH_REPORT.md — graphify's signature skimmable narrative. Fully deterministic (no LLM, no Date).
function visRenderReport(map) {
	const L = [];
	const s = map.stats || {};
	const langs = Object.entries(s.languages || {}).filter(([k]) => k !== "other").sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(", ");
	L.push(`# ${map.root} — Codebase Graph Report`, "");
	L.push("_Generated by `draht-tools map-graph`. Do not edit; regenerated each build._", "");
	L.push("## Overview");
	L.push(`${s.files} modules · ${(s.totalLoc || 0).toLocaleString()} LOC · ${s.packages} packages · ${s.edges} import edges · ${s.entryPoints} entry points · ${(map.clusters || []).length} clusters.`);
	L.push(`Languages: ${langs || "n/a"}.`, "");
	L.push("## Key concepts (structural neighborhoods)", "");
	L.push("> Clusters are import-topology neighborhoods, not semantic bounded contexts — confirm before treating them as such.", "");
	for (const c of (map.clusters || []).slice(0, 8)) {
		const code = (c.members || []).filter((m) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|swift|kt|cs|c|cpp)$/.test(m));
		const members = (code.length ? code : (c.members || [])).slice(0, 4).map((m) => "`" + m.split("/").slice(-2).join("/") + "`").join(", ");
		L.push(`- **${c.label}** — ${c.size} modules · ${c.dominantLayer}${members ? " · e.g. " + members : ""}`);
	}
	L.push("", "## God nodes (most connected)", "");
	L.push("| File | In | Out | Note |", "| --- | --- | --- | --- |");
	for (const g of (map.hotspots && map.hotspots.godNodes || []).slice(0, 8)) L.push(`| \`${g.path}\` | ${g.inDegree} | ${g.outDegree} | ${g.reason} |`);
	const sc = map.surprisingConnections || [];
	if (sc.length) {
		L.push("", "## Surprising connections", "");
		for (const x of sc.slice(0, 10)) {
			const syms = (x.sampleSymbols || []).slice(0, 3).join(", ");
			L.push(`- \`${x.from}\` → \`${x.to}\` — ${x.reason} (score ${x.score})${syms ? " · " + syms : ""}`);
		}
	}
	const rh = (map.rationaleIndex || []).filter((r) => ["SECURITY", "BUG", "FIXME", "HACK"].includes(r.tag)).slice(0, 12);
	if (rh.length) {
		L.push("", "## Rationale highlights (SECURITY / BUG / FIXME / HACK)", "");
		for (const r of rh) L.push(`- **${r.tag}** \`${r.file}:${r.line}\` — ${r.text}`);
	}
	L.push("", "## Suggested questions", "");
	const gq = [];
	const top = (map.hotspots && map.hotspots.godNodes || [])[0];
	if (top) gq.push(`Why does \`${top.path}\` have ${top.inDegree} dependents — is that coupling intended?`);
	const br = sc.find((x) => /bridge/.test(x.reason));
	if (br) gq.push(`Is the bridge \`${br.from}\` → \`${br.to}\` intended, or accidental coupling?`);
	const hk = (map.rationaleIndex || []).find((r) => r.tag === "HACK" || r.tag === "FIXME");
	if (hk) gq.push(`Should the ${hk.tag} at \`${hk.file}:${hk.line}\` be addressed? ("${hk.text}")`);
	const big = (map.clusters || [])[0];
	if (big) gq.push(`Cluster "${big.label}" holds ${big.size} modules — should it be split?`);
	if (!gq.length) gq.push("Run `draht-tools graph-hotspots` and `graph-clusters --surprising` to explore.");
	for (const q of gq) L.push(`- ${q}`);
	L.push("", "---", "Query the graph: `draht-tools graph-context <file>` · `graph-impact <file>` · `graph-query \"<concept>\"` · `graph-hotspots` · `graph-clusters --surprising`.", "");
	return L.join("\n");
}

function visWriteOutputs(root, opts = {}) {
	const outDir = path.join(root, PLANNING_DIR, "codebase");
	ensureDir(outDir);
	const map = visBuildMap(root);
	const jsonPath = path.join(outDir, "MAP.json");
	const htmlPath = path.join(outDir, "MAP.html");
	const reportPath = path.join(outDir, "GRAPH_REPORT.md");
	// Idempotent write: if the new map differs from the committed file ONLY in the volatile
	// generatedAt/buildMs fields, leave every artifact untouched — so the post-commit hook /
	// stale rebuild never produces spurious git churn. Graph data is deterministic (see verify gate).
	let unchanged = false;
	try {
		const prev = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
		unchanged = JSON.stringify(Object.assign({}, prev, { generatedAt: 0, buildMs: 0 }))
			=== JSON.stringify(Object.assign({}, map, { generatedAt: 0, buildMs: 0 }));
	} catch { /* no/invalid prior file → write fresh */ }
	if (!unchanged) {
		fs.writeFileSync(jsonPath, JSON.stringify(map, null, 2) + "\n", "utf-8");
		fs.writeFileSync(reportPath, visRenderReport(map), "utf-8"); // a fresh human report is a parity feature
		if (!opts.quiet) fs.writeFileSync(htmlPath, visRenderHtml(jsonPath), "utf-8");
	} else if (!opts.quiet && !fs.existsSync(htmlPath)) {
		fs.writeFileSync(htmlPath, visRenderHtml(jsonPath), "utf-8"); // backfill HTML if missing
	}
	return { jsonPath, htmlPath, reportPath, map, unchanged };
}

// --- map-graph ---
commands["map-graph"] = function (...args) {
	let dir = null, quiet = false;
	for (const a of args) {
		if (a === "--quiet" || a === "-q") quiet = true;
		else if (!String(a).startsWith("-") && !dir) dir = a;
	}
	const cwd = dir ? path.resolve(dir) : process.cwd();
	const { jsonPath, htmlPath, reportPath, map } = visWriteOutputs(cwd, { quiet });
	if (quiet) { // fast refresh for hooks: MAP.json + GRAPH_REPORT.md, no HTML render
		console.log(`map-graph: ${map.stats.files} modules · schemaVersion ${map.schemaVersion} · ${map.buildMs}ms → ${path.relative(cwd, jsonPath)}`);
		return;
	}
	console.log(banner("MAP-GRAPH"));
	console.log(`\nWrote:\n  ${jsonPath}\n  ${htmlPath}\n  ${reportPath}`);
	console.log(`\nIndexed ${map.stats.files} modules · ${map.stats.totalLoc.toLocaleString()} LOC · ${map.stats.edges} edges · ${map.clusters.length} clusters in ${map.buildMs}ms`);
	console.log(`\nRead the report: ${path.relative(cwd, reportPath)}   ·   Serve live: draht-tools map-serve`);
};

// --- map-serve ---
commands["map-serve"] = function (...args) {
	const http = require("node:http");
	const cwd = process.cwd();
	let port = 4878;
	let openBrowser = true;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--port" || a === "-p") port = parseInt(args[++i], 10) || port;
		else if (a === "--no-open") openBrowser = false;
		else if (/^\d+$/.test(a)) port = parseInt(a, 10);
	}

	const outDir = path.join(cwd, PLANNING_DIR, "codebase");
	const jsonPath = path.join(outDir, "MAP.json");
	const htmlPath = path.join(outDir, "MAP.html");

	// Initial generation
	let lastBuild = visWriteOutputs(cwd);
	console.log(banner("MAP-SERVE"));
	console.log(`\nServing ${path.relative(cwd, outDir)}/ on http://localhost:${port}`);
	console.log(`Indexed ${lastBuild.map.stats.files} modules in ${lastBuild.map.buildMs}ms`);

	const clients = new Set();
	let regenTimer = null;
	const regen = () => {
		clearTimeout(regenTimer);
		regenTimer = setTimeout(() => {
			try {
				lastBuild = visWriteOutputs(cwd);
				const ts = new Date().toLocaleTimeString();
				console.log(`[${ts}] regenerated MAP.json (${lastBuild.map.stats.files} modules, ${lastBuild.map.buildMs}ms)`);
				for (const c of clients) {
					try { c.write("data: changed\n\n"); } catch { /* empty */ }
				}
			} catch (err) {
				console.error("regen failed:", err.message);
			}
		}, 250);
	};

	// File watcher (recursive — supported on darwin/win32; fallback walks top-level dirs on linux)
	const watchTargets = [cwd];
	const watchers = [];
	const tryWatch = (target) => {
		try {
			const w = fs.watch(target, { recursive: true }, (_evt, fname) => {
				if (!fname) return;
				const f = fname.toString();
				if (VIS_DEFAULT_IGNORES.has(f.split(path.sep)[0])) return;
				if (f.includes("/node_modules/") || f.includes("/.git/")) return;
				if (f.includes("/.planning/")) return;
				regen();
			});
			watchers.push(w);
			return true;
		} catch { return false; }
	};
	if (!tryWatch(cwd)) {
		// Fallback: watch top-level dirs non-recursively
		for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
			if (!e.isDirectory()) continue;
			if (VIS_DEFAULT_IGNORES.has(e.name)) continue;
			tryWatch(path.join(cwd, e.name));
		}
	}

	const server = http.createServer((req, res) => {
		const url = req.url.split("?")[0];
		if (url === "/" || url === "/index.html" || url === "/MAP.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(fs.readFileSync(htmlPath));
		} else if (url === "/MAP.json") {
			res.writeHead(200, { "content-type": "application/json; charset=utf-8",
				"cache-control": "no-store" });
			res.end(fs.readFileSync(jsonPath));
		} else if (url === "/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("retry: 2000\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
		} else if (url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, stats: lastBuild.map.stats }));
		} else {
			res.writeHead(404); res.end("not found");
		}
	});

	server.listen(port, () => {
		const url = `http://localhost:${port}`;
		console.log(`\n→ Open ${url}`);
		console.log(`  Live updates via SSE; edits to source files regenerate the map.`);
		console.log(`  Ctrl-C to stop.`);
		if (openBrowser) {
			const opener = process.platform === "darwin" ? "open"
				: process.platform === "win32" ? "start" : "xdg-open";
			try { execSync(`${opener} ${url}`, { stdio: "ignore" }); } catch { /* empty */ }
		}
	});

	const shutdown = () => {
		for (const w of watchers) try { w.close(); } catch { /* empty */ }
		try { server.close(); } catch { /* empty */ }
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
};

// ============================================================================
// Knowledge-graph queries — answer from MAP.json instead of grepping (read-only)
// ============================================================================

function graphLoadMap() {
	const jsonPath = path.join(process.cwd(), PLANNING_DIR, "codebase", "MAP.json");
	try { return { map: JSON.parse(fs.readFileSync(jsonPath, "utf-8")), jsonPath }; }
	catch { return { map: null, jsonPath }; }
}
function graphNoMap() { console.log("no map — run `draht-tools map-graph` first."); }

// Split args into { files, flags }; value-flags (e.g. depth/limit) consume the next token.
function graphParseArgs(args, valueFlags = []) {
	const files = [], flags = {};
	for (let i = 0; i < args.length; i++) {
		const a = String(args[i]);
		const key = a.replace(/^--?/, "");
		if (!a.startsWith("-")) files.push(a);
		else if (valueFlags.includes(key)) flags[key] = args[++i];
		else flags[key] = true;
	}
	return { files, flags };
}

// Resolve a user path to a module id: exact, then unique suffix, then unique basename, then substring.
function graphResolveFile(map, q) {
	if (!q) return null;
	const norm = String(q).replace(/^\.\//, "");
	const mods = map.modules;
	let m = mods.find((x) => x.id === norm);
	if (m) return { id: m.id, exact: true };
	const suffix = mods.filter((x) => x.id.endsWith("/" + norm));
	if (suffix.length === 1) return { id: suffix[0].id, exact: false };
	const base = norm.split("/").pop();
	const byBase = mods.filter((x) => x.path.split("/").pop() === base);
	if (byBase.length === 1) return { id: byBase[0].id, exact: false };
	const contains = mods.filter((x) => x.id.includes(norm)).sort((a, b) => a.id.length - b.id.length);
	if (contains.length) return { id: contains[0].id, exact: false };
	return null;
}

function graphImportAdj(map) {
	// import + re-export are both real structural dependency edges (barrels re-export their internals).
	const fwd = new Map(), rev = new Map();
	for (const e of map.edges) {
		if (e.kind !== "import" && e.kind !== "re-export") continue;
		if (!fwd.has(e.from)) fwd.set(e.from, []); if (!fwd.get(e.from).includes(e.to)) fwd.get(e.from).push(e.to);
		if (!rev.has(e.to)) rev.set(e.to, []); if (!rev.get(e.to).includes(e.from)) rev.get(e.to).push(e.from);
	}
	return { fwd, rev };
}
const graphShort = (p) => String(p).split("/").slice(-2).join("/");

// graph-context — "where am I": package, layer, cluster, importers/imports, exports, sinks, rationale.
commands["graph-context"] = function (...args) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { files, flags } = graphParseArgs(args);
	if (!files.length) { console.log("usage: graph-context <file...> [--json]"); return; }
	const { fwd: imports, rev: importers } = graphImportAdj(map);
	const clusterById = new Map((map.clusters || []).map((c) => [c.id, c]));
	const modById = new Map(map.modules.map((m) => [m.id, m]));
	const L = [], J = [];
	for (const f of files) {
		const r = graphResolveFile(map, f);
		if (!r) { L.push(`${f}: not found in map`); continue; }
		const m = modById.get(r.id);
		if (!r.exact) L.push(`resolved '${f}' → ${m.id}`);
		const cl = clusterById.get(m.cluster);
		const exps = (m.symbols && m.symbols.length ? m.symbols.filter((s) => s.exported) : (m.exports || [])).map((s) => s.name);
		const ins = importers.get(m.id) || [], outs = imports.get(m.id) || [];
		const rat = (map.rationaleIndex || []).filter((x) => x.file === m.id).slice(0, 4).map((x) => `${x.tag}:${x.line} ${x.text.slice(0, 40)}`);
		L.push(`${m.path}  ·  pkg:${m.package || "-"}  ·  layer:${m.layer}  ·  cluster:${cl ? cl.label : "-"}(${cl ? cl.size : 0})  ·  entry:${m.entryPoint ? m.entryPoint.kind : "no"}`);
		L.push(`  exports(${exps.length}): ${exps.slice(0, 8).join(", ") || "-"}${exps.length > 8 ? " …" : ""}`);
		L.push(`  importers(${ins.length}): ${ins.slice(0, 5).map(graphShort).join(", ") || "-"}${ins.length > 5 ? ` (+${ins.length - 5} more)` : ""}`);
		L.push(`  imports(${outs.length}): ${outs.slice(0, 5).map(graphShort).join(", ") || "-"}${outs.length > 5 ? ` (+${outs.length - 5} more)` : ""}`);
		if (m.sinks && m.sinks.length) L.push(`  sinks: ${m.sinks.join(", ")}`);
		if (rat.length) L.push(`  rationale(${rat.length}): ${rat.join(" · ")}`);
		J.push({ id: m.id, package: m.package, layer: m.layer, cluster: m.cluster, clusterLabel: cl ? cl.label : null, entryPoint: m.entryPoint, exports: exps, importers: ins, imports: outs, sinks: m.sinks, rationale: (map.rationaleIndex || []).filter((x) => x.file === m.id) });
	}
	console.log(flags.json ? JSON.stringify(J, null, 2) : L.join("\n"));
};

// graph-impact — blast radius: reverse-transitive importers, entry points reached, sinks, boundary warns.
commands["graph-impact"] = function (...args) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { files, flags } = graphParseArgs(args);
	if (!files.length) { console.log("usage: graph-impact <file...> [--json]"); return; }
	const { rev } = graphImportAdj(map);
	const modById = new Map(map.modules.map((m) => [m.id, m]));
	const targets = [], notes = [];
	for (const f of files) { const r = graphResolveFile(map, f); if (r) { if (!r.exact) notes.push(`resolved '${f}' → ${r.id}`); targets.push(r.id); } else notes.push(`${f}: not found`); }
	if (!targets.length) { console.log(notes.join("\n") || "no targets resolved"); return; }
	const seen = new Set(targets), queue = [...targets];
	while (queue.length) { const id = queue.shift(); for (const dep of (rev.get(id) || [])) if (!seen.has(dep)) { seen.add(dep); queue.push(dep); } }
	for (const t of targets) seen.delete(t);
	const impacted = [...seen].map((id) => modById.get(id)).filter(Boolean);
	const eps = (map.entryPoints || []).filter((ep) => seen.has(ep.id));
	const byPkg = {}; for (const m of impacted) { const p = m.package || "(root)"; (byPkg[p] = byPkg[p] || []).push(m.path); }
	const clusterLabel = new Map((map.clusters || []).map((c) => [c.id, c.label]));
	const cls = [...new Set(impacted.map((m) => m.cluster).filter(Boolean))];
	const sinkKinds = new Set(); for (const t of targets) for (const s of (modById.get(t).sinks || [])) sinkKinds.add(s);
	const warns = (map.surprisingConnections || []).filter((x) => seen.has(x.from) || seen.has(x.to) || targets.includes(x.to)).slice(0, 5);
	const epLabel = (e) => e.kind === "cli" ? "cli:" + (e.name || "") : e.kind === "http" ? "http:" + ((e.routes && e.routes[0] && (e.routes[0].method + " " + e.routes[0].path)) || "") : "lib:" + (e.name || e.path.split("/").pop());
	const L = [];
	if (notes.length) L.push(...notes);
	L.push(`impact ${targets.map((t) => t.split("/").pop()).join(", ")} — ${impacted.length} modules · ${Object.keys(byPkg).length} packages · ${eps.length} entry points · sinks: ${[...sinkKinds].join(", ") || "none"}`);
	if (eps.length) L.push(`entry points reaching it (${eps.length}): ${eps.slice(0, 8).map(epLabel).join(", ")}${eps.length > 8 ? " …" : ""}`);
	const pkgs = Object.entries(byPkg).sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
	if (pkgs.length) L.push("by package:");
	for (const [p, arr] of pkgs.slice(0, 8)) L.push(`  ${p.replace(/^@[^/]+\//, "")}(${arr.length}): ${arr.slice(0, 5).map((x) => x.split("/").pop()).join(" ")}${arr.length > 5 ? ` (+${arr.length - 5})` : ""}`);
	if (pkgs.length > 8) L.push(`  … +${pkgs.length - 8} more packages`);
	if (cls.length) L.push(`clusters affected: ${cls.map((c) => clusterLabel.get(c) || c).slice(0, 8).join(", ")}`);
	for (const w of warns) L.push(`⚠ ${w.reason}: ${graphShort(w.from)} → ${graphShort(w.to)}`);
	console.log(flags.json ? JSON.stringify({ targets, impacted: impacted.map((m) => m.id), entryPoints: eps.map((e) => e.id), byPackage: byPkg, clusters: cls, sinks: [...sinkKinds], warnings: warns }, null, 2) : L.join("\n"));
};

// graph-callers / graph-callees — direct + N-hop neighbours via call + import edges, with symbols.
function graphCallDir(args, direction) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { files, flags } = graphParseArgs(args, ["depth"]);
	if (!files.length) { console.log(`usage: graph-${direction} <file> [--depth N] [--json]`); return; }
	const depth = Math.max(1, parseInt(flags.depth, 10) || 1);
	const r = graphResolveFile(map, files[0]);
	if (!r) { console.log(`${files[0]}: not found in map`); return; }
	const fwd = new Map(), rev = new Map();
	const push = (mp, k, v) => { if (!mp.has(k)) mp.set(k, []); if (!mp.get(k).some((x) => x.to === v.to && x.symbol === v.symbol)) mp.get(k).push(v); };
	for (const ce of map.callEdges) { push(fwd, ce.from, { to: ce.to, symbol: ce.symbol }); push(rev, ce.to, { to: ce.from, symbol: ce.symbol }); }
	for (const e of map.edges) { if (e.kind !== "import") continue; push(fwd, e.from, { to: e.to, symbol: null }); push(rev, e.to, { to: e.from, symbol: null }); }
	const adj = direction === "callers" ? rev : fwd;
	const level = new Map([[r.id, 0]]); const q = [r.id]; const hops = [];
	while (q.length) { const id = level.get(q[0]) < depth ? q.shift() : (q.shift(), null); if (id == null) continue; for (const nb of (adj.get(id) || [])) { if (!level.has(nb.to)) { level.set(nb.to, level.get(id) + 1); q.push(nb.to); } if (level.get(nb.to) === level.get(id) + 1) hops.push({ from: id, to: nb.to, symbol: nb.symbol, hop: level.get(id) + 1 }); } }
	const byHop = {}; for (const h of hops) (byHop[h.hop] = byHop[h.hop] || []).push(h);
	if (flags.json) { console.log(JSON.stringify({ target: r.id, direction, hops }, null, 2)); return; }
	const total = level.size - 1;
	console.log(`${direction} of ${r.id} — ${total} within ${depth} hop${depth > 1 ? "s" : ""}`);
	for (let d = 1; d <= depth; d++) {
		const arr = byHop[d] || []; if (!arr.length) continue;
		console.log(`  hop ${d}:`);
		const seen = new Set();
		for (const h of arr) { const node = direction === "callers" ? h.to : h.to; if (seen.has(node)) continue; seen.add(node); const syms = arr.filter((x) => x.to === node && x.symbol).map((x) => x.symbol); console.log(`    ${node}${syms.length ? "  [" + [...new Set(syms)].slice(0, 4).join(", ") + "]" : ""}`); }
	}
};
commands["graph-callers"] = function (...args) { return graphCallDir(args, "callers"); };
commands["graph-callees"] = function (...args) { return graphCallDir(args, "callees"); };

// graph-path — shortest import path between two files (forward, else reverse "reached-by").
commands["graph-path"] = function (...args) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { files } = graphParseArgs(args);
	const a = graphResolveFile(map, files[0]), b = graphResolveFile(map, files[1]);
	if (!a || !b) { console.log("usage: graph-path <from> <to>  (both files must resolve)"); return; }
	const { fwd } = graphImportAdj(map);
	const sym = new Map(); for (const ce of map.callEdges) if (!sym.has(ce.from + "|" + ce.to)) sym.set(ce.from + "|" + ce.to, ce.symbol);
	const bfs = (src, dst) => { const prev = new Map([[src, null]]); const q = [src]; while (q.length) { const id = q.shift(); if (id === dst) break; for (const n of (fwd.get(id) || [])) if (!prev.has(n)) { prev.set(n, id); q.push(n); } } if (!prev.has(dst)) return null; const c = []; let x = dst; while (x != null) { c.unshift(x); x = prev.get(x); } return c; };
	let chain = bfs(a.id, b.id), reversed = false;
	if (!chain) { chain = bfs(b.id, a.id); reversed = true; }
	if (!chain) { console.log(`no import path between ${a.id} and ${b.id}`); return; }
	console.log(reversed ? `(no forward path) reverse: ${b.id} is reached-by ${a.id} in ${chain.length - 1} hops` : `path ${a.id} → ${b.id}  (${chain.length - 1} hops)`);
	const render = reversed ? chain.slice().reverse() : chain;
	const line = render.map((c, i) => { const s = i < render.length - 1 ? sym.get(c + "|" + render[i + 1]) : null; return graphShort(c) + (i < render.length - 1 ? (s ? ` —${s}→ ` : " → ") : ""); }).join("");
	console.log("  " + line);
};

// graph-query — ranked keyword + doc search over symbol nodes (no embeddings; deterministic).
commands["graph-query"] = function (...args) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { files, flags } = graphParseArgs(args);
	const terms = files.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
	if (!terms.length) { console.log("usage: graph-query <term...> [--json]  (terms ≥3 chars)"); return; }
	const stem = (s) => s.replace(/(ing|tion|ed|s)$/, "");
	const clusterLabel = new Map((map.clusters || []).map((c) => [c.id, (c.label || "").toLowerCase()]));
	const deg = new Map(); for (const e of map.edges) { if (e.kind !== "import") continue; deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
	const cands = [];
	for (const m of map.modules) {
		const expDoc = new Map((m.exports || []).map((e) => [e.name, e.doc || ""]));
		const baseLow = m.path.split("/").pop().toLowerCase();
		const clab = clusterLabel.get(m.cluster) || "";
		for (const s of (m.symbols || [])) {
			const nameLow = s.name.toLowerCase(), doc = expDoc.get(s.name) || "", docLow = doc.toLowerCase();
			let total = 0, ok = true;
			for (const t of terms) {
				let sc = 0;
				if (nameLow === t) sc = 400; else if (nameLow.startsWith(t)) sc = 200; else if (nameLow.includes(t)) sc = 100;
				if (sc < 60 && baseLow.includes(t)) sc = 60;
				if (sc < 40 && (docLow.includes(t) || docLow.includes(stem(t)))) sc = 40;
				if (sc < 30 && clab.includes(t)) sc = 30;
				if (sc === 0) { ok = false; break; }
				total += sc;
			}
			if (!ok) continue;
			let mult = 1; if (s.exported) mult *= 1.5; if (m.entryPoint) mult *= 1.3;
			cands.push({ score: +(total * mult).toFixed(1), deg: deg.get(m.id) || 0, path: m.path, line: s.line, kind: s.kind, name: s.name, exported: !!s.exported, doc });
		}
	}
	cands.sort((a, b) => b.score - a.score || b.deg - a.deg || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
	const top = cands.slice(0, 15);
	if (flags.json) { console.log(JSON.stringify(top, null, 2)); return; }
	console.log(`query "${terms.join(" ")}" — ${top.length}/${cands.length} hits`);
	for (const c of top) console.log(`${c.path}:${c.line}  ${c.kind} ${c.name}${c.doc ? "  — " + c.doc.slice(0, 60) : ""}${c.exported ? "  [exported]" : ""}`);
	if (cands.length > 15) console.log(`(${cands.length - 15} more: --json for all)`);
};

// graph-hotspots — god-nodes / most-depended-on / orchestrators / largest.
commands["graph-hotspots"] = function (...args) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { flags } = graphParseArgs(args, ["limit"]);
	const lim = Math.max(1, parseInt(flags.limit, 10) || 10);
	const h = map.hotspots || {};
	if (flags.json) { console.log(JSON.stringify(h, null, 2)); return; }
	const section = (title, arr) => { console.log(`\n${title}`); for (const g of (arr || []).slice(0, lim)) console.log(`  ${g.path}  [in ${g.inDegree} · out ${g.outDegree} · ${g.loc} LOC]  ${g.reason}`); };
	section("God nodes (most connected):", h.godNodes);
	section("Most depended-on:", h.mostDependedOn);
	section("Orchestrators (most deps):", h.orchestrators);
	section("Largest:", h.largest);
};

// graph-clusters — structural neighborhoods; --surprising appends bridge/boundary edges.
commands["graph-clusters"] = function (...args) {
	const { map } = graphLoadMap();
	if (!map) return graphNoMap();
	const { flags } = graphParseArgs(args);
	if (flags.json) { console.log(JSON.stringify({ clusters: map.clusters, surprisingConnections: flags.surprising ? map.surprisingConnections : undefined }, null, 2)); return; }
	console.log(`${(map.clusters || []).length} clusters (structural import-topology — not semantic bounded contexts):`);
	for (const c of (map.clusters || [])) console.log(`  ${c.label}  ·  ${c.size} modules  ·  ${c.dominantLayer}  ·  ${(c.packages || []).slice(0, 3).join(", ")}`);
	if (flags.surprising) {
		console.log(`\nSurprising connections (${(map.surprisingConnections || []).length}):`);
		for (const x of (map.surprisingConnections || [])) console.log(`  ${graphShort(x.from)} → ${graphShort(x.to)}  —  ${x.reason} (${x.score})${x.sampleSymbols && x.sampleSymbols.length ? " · " + x.sampleSymbols.slice(0, 3).join(", ") : ""}`);
	}
};

// graph-hook — install/uninstall a git post-commit hook that refreshes MAP.json (graphify-style).
commands["graph-hook"] = function (...args) {
	const sub = args[0] || "status";
	const gitDir = path.join(process.cwd(), ".git");
	if (!fs.existsSync(gitDir)) { console.log("not a git repository (no .git)"); return; }
	const hookPath = path.join(gitDir, "hooks", "post-commit");
	const BEGIN = "# >>> draht map-graph >>>", END = "# <<< draht map-graph <<<";
	const selfPath = __filename;
	const block = `${BEGIN}\nnode "${selfPath}" map-graph --quiet 2>/dev/null || true\n${END}`;
	const read = () => { try { return fs.readFileSync(hookPath, "utf-8"); } catch { return ""; } };
	const stripBlock = (s) => s.replace(new RegExp("\\n*" + BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n*", "g"), "\n").replace(/^\n+/, "");
	if (sub === "install") {
		let cur = read();
		if (cur.includes(BEGIN)) cur = stripBlock(cur);
		if (!cur.trim()) cur = "#!/bin/sh\n";
		const next = cur.replace(/\n*$/, "\n") + "\n" + block + "\n";
		ensureDir(path.dirname(hookPath));
		fs.writeFileSync(hookPath, next, "utf-8");
		try { fs.chmodSync(hookPath, 0o755); } catch { /* empty */ }
		console.log(`installed post-commit hook → ${path.relative(process.cwd(), hookPath)}\n  refreshes .planning/codebase/MAP.json after each commit (lands in the next commit).`);
	} else if (sub === "uninstall") {
		const cur = read();
		if (!cur.includes(BEGIN)) { console.log("draht hook not installed."); return; }
		const next = stripBlock(cur);
		if (next.trim() && next.trim() !== "#!/bin/sh") fs.writeFileSync(hookPath, next, "utf-8"); else { try { fs.unlinkSync(hookPath); } catch { /* empty */ } }
		console.log("removed draht post-commit hook block.");
	} else {
		console.log(read().includes(BEGIN) ? "draht post-commit hook: INSTALLED" : "draht post-commit hook: not installed (run `draht-tools graph-hook install`)");
	}
};

// ============================================================================
// Help & Dispatch
// ============================================================================

commands.help = function () {
	console.log(`
Draht Tools — Get Shit Done CLI

Usage: draht-tools <command> [args]

Project Setup:
  init                          Check preconditions, create .planning/
  map-codebase [dir]            Analyze existing codebase (docs)
  map-graph [dir] [--quiet]     Generate living codebase map (MAP.json + MAP.html + GRAPH_REPORT.md)
                                --quiet: refresh MAP.json + report only (no HTML); for hooks
                                Override functional groups via .planning/codebase/GROUPS.json
                                Override flows via .planning/codebase/FLOWS.json
  map-serve [port]              Serve MAP.html with live reload on file changes

Knowledge Graph (query MAP.json instead of grepping — run map-graph first):
  graph-context <file...>       Where a file sits: pkg, layer, cluster, importers/imports, sinks, rationale
  graph-impact <file...>        Blast radius: reverse-dependents, entry points reached, sinks, boundary warns
  graph-callers <file> [--depth N]   Modules that call/import the file (N hops)
  graph-callees <file> [--depth N]   Modules the file calls/imports (N hops)
  graph-path <from> <to>        Shortest import path between two files
  graph-query <term...>         Ranked symbol + doc search (replaces grep for "find the X")
  graph-hotspots [--limit N]    God-nodes / most-depended-on / orchestrators / largest
  graph-clusters [--surprising] Structural neighborhoods (+ surprising/bridge connections)
  graph-hook install|uninstall|status   Git post-commit hook that refreshes MAP.json
  (all accept --json for machine output)
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

(async () => {
	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
		commands.help();
	} else if (commands[cmd]) {
		await commands[cmd](...args);
	} else {
		console.error(`Unknown command: ${cmd}\nRun: draht-tools help`);
		process.exit(1);
	}
})();
