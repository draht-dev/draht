// GSD Planning module — phase/plan/task file system operations.
// Part of the draht GSD (Get Shit Done) methodology.

import * as fs from "node:fs";
import * as path from "node:path";

const PLANNING = ".planning";

function planningPath(cwd: string, ...segments: string[]): string {
	return path.join(cwd, PLANNING, ...segments);
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function padNum(n: number, digits = 2): string {
	return String(n).padStart(digits, "0");
}

function timestamp(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function getPhaseSlug(cwd: string, phaseNum: number): string {
	const roadmapPath = planningPath(cwd, "ROADMAP.md");
	if (!fs.existsSync(roadmapPath)) return `phase-${phaseNum}`;
	const content = fs.readFileSync(roadmapPath, "utf-8");
	const re = new RegExp(`## Phase ${phaseNum}: (.+?) —`);
	const m = re.exec(content);
	if (!m) return `phase-${phaseNum}`;
	return m[1]
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

function getPhaseDir(cwd: string, phaseNum: number): string | null {
	const phasesDir = planningPath(cwd, "phases");
	if (!fs.existsSync(phasesDir)) return null;
	const prefix = `${padNum(phaseNum)}-`;
	const entry = fs.readdirSync(phasesDir).find((e) => e.startsWith(prefix));
	return entry ? path.join(phasesDir, entry) : null;
}

export interface PlanDiscovery {
	plans: Array<{ file: string; deps: string[] }>;
	incomplete: string[];
	fixPlans: string[];
}

export interface PhaseVerification {
	plans: number;
	summaries: number;
	complete: boolean;
}

export function createPlan(cwd: string, phaseNum: number, planNum: number, title?: string): string {
	const slug = getPhaseSlug(cwd, phaseNum);
	const dir = planningPath(cwd, "phases", `${padNum(phaseNum)}-${slug}`);
	ensureDir(dir);
	const planTitle = title || `Plan ${planNum}`;
	const planFile = path.join(dir, `${padNum(phaseNum)}-${padNum(planNum)}-PLAN.md`);
	const tmpl = `---
phase: ${phaseNum}
plan: ${planNum}
depends_on: []
must_haves:
  - "[Observable truth this plan delivers]"
---

# Phase ${phaseNum}, Plan ${planNum}: ${planTitle}

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
	fs.writeFileSync(planFile, tmpl, "utf-8");
	return planFile;
}

export function discoverPlans(cwd: string, phaseNum: number): PlanDiscovery {
	const phaseDir = getPhaseDir(cwd, phaseNum);
	if (!phaseDir) throw new Error(`Phase ${phaseNum} directory not found`);

	const files = fs.readdirSync(phaseDir).sort();
	const plans = files.filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
	const summaries = files.filter((f) => f.endsWith("-SUMMARY.md"));
	const fixPlans = files.filter((f) => f.includes("FIX-PLAN.md"));

	const completedPlanNums = new Set(
		summaries.map((s) => s.match(/\d+-(\d+)-SUMMARY/)?.[1]).filter((x): x is string => Boolean(x)),
	);

	const incomplete = plans.filter((p) => {
		const m = p.match(/\d+-(\d+)-PLAN/);
		return m ? !completedPlanNums.has(m[1]) : true;
	});

	const planData = plans.map((p) => {
		const content = fs.readFileSync(path.join(phaseDir, p), "utf-8");
		const depsMatch = content.match(/depends_on:\s*\[(.*?)\]/);
		const deps = depsMatch
			? depsMatch[1]
					.split(",")
					.map((d) => d.trim())
					.filter(Boolean)
			: [];
		return { file: p, deps };
	});

	return { plans: planData, incomplete, fixPlans };
}

export function readPlan(cwd: string, phaseNum: number, planNum: number): string {
	const phaseDir = getPhaseDir(cwd, phaseNum);
	if (!phaseDir) throw new Error(`Phase ${phaseNum} not found`);
	const planFile = path.join(phaseDir, `${padNum(phaseNum)}-${padNum(planNum)}-PLAN.md`);
	if (!fs.existsSync(planFile)) throw new Error(`Plan file not found: ${planFile}`);
	return fs.readFileSync(planFile, "utf-8");
}

export function writeSummary(cwd: string, phaseNum: number, planNum: number): string {
	const phaseDir = getPhaseDir(cwd, phaseNum);
	if (!phaseDir) throw new Error(`Phase ${phaseNum} not found`);
	const summaryPath = path.join(phaseDir, `${padNum(phaseNum)}-${padNum(planNum)}-SUMMARY.md`);
	const tmpl = `# Phase ${phaseNum}, Plan ${planNum} Summary

## Completed Tasks
| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | [task] | ✅ Done | [hash] |

## Files Changed
- [files]

## Verification Results
- [results]

## Notes
[deviations, decisions]

---
Completed: ${timestamp()}
`;
	fs.writeFileSync(summaryPath, tmpl, "utf-8");
	return summaryPath;
}

export function verifyPhase(cwd: string, phaseNum: number): PhaseVerification {
	const phaseDir = getPhaseDir(cwd, phaseNum);
	if (!phaseDir) throw new Error(`Phase ${phaseNum} not found`);
	const plans = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md") && !f.includes("FIX"));
	const summaries = fs.readdirSync(phaseDir).filter((f) => f.endsWith("-SUMMARY.md"));
	const complete = summaries.length >= plans.length && plans.length > 0;
	if (complete) {
		const verPath = path.join(phaseDir, `${padNum(phaseNum)}-VERIFICATION.md`);
		fs.writeFileSync(
			verPath,
			`# Phase ${phaseNum} Verification\n\nAll ${plans.length} plans executed.\nVerified: ${timestamp()}\n`,
			"utf-8",
		);
	}
	return { plans: plans.length, summaries: summaries.length, complete };
}

export function updateState(cwd: string): void {
	const statePath = planningPath(cwd, "STATE.md");
	if (!fs.existsSync(statePath)) throw new Error("No STATE.md found");
	let state = fs.readFileSync(statePath, "utf-8");
	state = state.replace(/## Last Activity:.*/, `## Last Activity: ${timestamp()}`);
	fs.writeFileSync(statePath, state, "utf-8");
}
