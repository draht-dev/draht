/**
 * GSD — Get Shit Done
 *
 * Batteries-included phase commands for structured AI-assisted development.
 *
 * Full workflow:
 *   /discuss <feature>          — clarify requirements before planning
 *   /plan    <feature>          — architect produces implementation plan
 *   /execute <task1, task2...>  — parallel implement → review → commit
 *   /verify                     — parallel lint/typecheck/tests + security audit
 *
 * Utilities:
 *   /review  <scope>            — ad-hoc code review + security audit
 *   /fix     <issue>            — targeted fix plan for a failing task
 *   /quick   <task>             — one-shot implement + commit (skip full GSD)
 *   /resume                     — pick up interrupted work from CONTINUE-HERE.md
 *   /status                     — show .planning/STATE.md overview
 *   /next-milestone             — plan next milestone after current one is complete
 *   /new-project <name> [path]  — create project dir, git init, scaffold .draht/
 *   /init-project               — scaffold .draht/ in existing project
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@draht/coding-agent";

function isBusy(ctx: { isIdle: () => boolean }, ui: { notify: (msg: string, level: string) => void }): boolean {
	if (!ctx.isIdle()) {
		ui.notify("Agent is busy", "warning");
		return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	// ── /discuss ─────────────────────────────────────────────────────────────
	pi.registerCommand("discuss", {
		description: "Clarify requirements before planning. Architect asks questions and defines scope. Usage: /discuss <feature>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /discuss <feature description>", "warning");
				return;
			}
			if (isBusy(ctx, ctx.ui)) return;

			pi.sendUserMessage(
				`Use the subagent tool to delegate to the architect agent with this task:

"We are in the DISCUSS phase for: ${args.trim()}

Your job is NOT to plan yet. First:
1. Read relevant existing code to understand the current state
2. Identify ambiguities, unknowns, and risks
3. List clarifying questions that need answers before planning can begin
4. Define a clear, bounded scope for what will and won't be built
5. Output a DISCUSS summary with: scope, assumptions, open questions, risks

Do not produce file lists or implementation details yet."

Set agentScope to "project".`,
			);
		},
	});

	// ── /plan ────────────────────────────────────────────────────────────────
	pi.registerCommand("plan", {
		description: "Plan a feature — architect reads codebase and produces structured implementation plan. Usage: /plan <feature>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /plan <feature description>", "warning");
				return;
			}
			if (isBusy(ctx, ctx.ui)) return;

			pi.sendUserMessage(
				`Use the subagent tool to delegate to the architect agent with this task: "${args.trim()}"\n\nSet agentScope to "project".`,
			);
		},
	});

	// ── /execute ─────────────────────────────────────────────────────────────
	pi.registerCommand("execute", {
		description: "Execute tasks in parallel, then chain reviewer + git-committer. Usage: /execute task1, task2, task3",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /execute task1, task2, task3", "warning");
				return;
			}
			if (isBusy(ctx, ctx.ui)) return;

			const tasks = args.split(",").map((t) => t.trim()).filter(Boolean);

			if (tasks.length === 1) {
				pi.sendUserMessage(
					`Use the subagent tool in chain mode with agentScope "project":
1. agent: implementer — task: "${tasks[0]}"
2. agent: reviewer    — task: "Review the changes just made: {previous}"
3. agent: git-committer — task: "Commit all changes. Review context: {previous}"`,
				);
			} else {
				const parallelList = tasks.map((t, i) => `${i + 1}. agent: implementer — task: "${t}"`).join("\n");
				pi.sendUserMessage(
					`Use the subagent tool with agentScope "project":

Step 1 — PARALLEL mode (run all simultaneously):
${parallelList}

Step 2 — CHAIN mode (after all parallel tasks complete):
1. agent: reviewer      — task: "Review all changes just implemented"
2. agent: git-committer — task: "Commit all changes. Review findings: {previous}"`,
				);
			}
		},
	});

	// ── /verify ──────────────────────────────────────────────────────────────
	pi.registerCommand("verify", {
		description: "Parallel verification: lint, typecheck, tests, and security audit",
		handler: async (_args, ctx) => {
			if (isBusy(ctx, ctx.ui)) return;

			pi.sendUserMessage(
				`Use the subagent tool in PARALLEL mode with agentScope "project":
1. agent: verifier        — task: "Run all lint, typecheck, and test checks"
2. agent: security-auditor — task: "Audit all recent changes for security vulnerabilities"

After both complete, merge findings into a single prioritized report. List what must be fixed before this is production-ready.`,
			);
		},
	});

	// ── /review ──────────────────────────────────────────────────────────────
	pi.registerCommand("review", {
		description: "Ad-hoc code review + security audit. Usage: /review <scope or files>",
		handler: async (args, ctx) => {
			if (isBusy(ctx, ctx.ui)) return;

			const scope = args.trim() || "all recent changes";
			pi.sendUserMessage(
				`Use the subagent tool in PARALLEL mode with agentScope "project":
1. agent: reviewer        — task: "Review ${scope} for correctness, type safety, and conventions"
2. agent: security-auditor — task: "Audit ${scope} for security vulnerabilities"

After both complete, merge into a single prioritized findings report.`,
			);
		},
	});

	// ── /fix ─────────────────────────────────────────────────────────────────
	pi.registerCommand("fix", {
		description: "Create a targeted fix plan for a failing task or bug. Usage: /fix <description of what's broken>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /fix <description of what's broken>", "warning");
				return;
			}
			if (isBusy(ctx, ctx.ui)) return;

			pi.sendUserMessage(
				`Use the subagent tool in chain mode with agentScope "project":
1. agent: architect  — task: "Diagnose this issue and produce a minimal fix plan: ${args.trim()}. Read the relevant code first. Output: root cause, exact files to change, fix steps."
2. agent: implementer — task: "Apply this fix plan exactly: {previous}"
3. agent: reviewer    — task: "Verify the fix is correct and doesn't introduce regressions: {previous}"
4. agent: git-committer — task: "Commit the fix. Fix summary: {previous}"`,
			);
		},
	});

	// ── /quick ───────────────────────────────────────────────────────────────
	pi.registerCommand("quick", {
		description: "One-shot task: implement + commit. Skips full GSD workflow. Usage: /quick <task>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /quick <task description>", "warning");
				return;
			}
			if (isBusy(ctx, ctx.ui)) return;

			pi.sendUserMessage(
				`Use the subagent tool in chain mode with agentScope "project":
1. agent: implementer   — task: "${args.trim()}"
2. agent: git-committer — task: "Commit the changes just made: {previous}"`,
			);
		},
	});

	// ── /resume ──────────────────────────────────────────────────────────────
	pi.registerCommand("resume", {
		description: "Resume interrupted work — reads CONTINUE-HERE.md and picks up where we left off",
		handler: async (_args, ctx) => {
			if (isBusy(ctx, ctx.ui)) return;

			const continueFile = path.join(ctx.cwd, ".planning", "CONTINUE-HERE.md");
			const stateFile = path.join(ctx.cwd, ".planning", "STATE.md");

			if (!fs.existsSync(continueFile) && !fs.existsSync(stateFile)) {
				ctx.ui.notify("No .planning/CONTINUE-HERE.md or STATE.md found. Nothing to resume.", "warning");
				return;
			}

			let context = "";
			if (fs.existsSync(continueFile)) {
				context += `\nCONTINUE-HERE.md:\n${fs.readFileSync(continueFile, "utf-8")}`;
			}
			if (fs.existsSync(stateFile)) {
				context += `\nSTATE.md:\n${fs.readFileSync(stateFile, "utf-8")}`;
			}

			pi.sendUserMessage(
				`Read the following project state and resume work from where it was interrupted. Identify the next incomplete task and proceed with it using the appropriate subagent.${context}`,
			);
		},
	});

	// ── /status ──────────────────────────────────────────────────────────────
	pi.registerCommand("status", {
		description: "Show current GSD project state from .planning/STATE.md",
		handler: async (_args, ctx) => {
			const stateFile = path.join(ctx.cwd, ".planning", "STATE.md");
			const logFile = path.join(ctx.cwd, ".planning", "execution-log.jsonl");

			if (!fs.existsSync(stateFile)) {
				ctx.ui.notify("No .planning/STATE.md found. Run /init-project or /new-project first.", "warning");
				return;
			}

			let output = fs.readFileSync(stateFile, "utf-8");

			if (fs.existsSync(logFile)) {
				const entries = fs.readFileSync(logFile, "utf-8")
					.split("\n").filter(Boolean)
					.map((l) => { try { return JSON.parse(l); } catch { return null; } })
					.filter(Boolean);

				const passed = entries.filter((e) => e.status === "pass").length;
				const failed = entries.filter((e) => e.status === "fail").length;
				const skipped = entries.filter((e) => e.status === "skip").length;
				output += `\n\n---\n**Execution log:** ${passed} passed, ${failed} failed, ${skipped} skipped`;
			}

			pi.sendUserMessage(`Here is the current project state:\n\n${output}`);
		},
	});

	// ── /next-milestone ──────────────────────────────────────────────────────
	pi.registerCommand("next-milestone", {
		description: "Plan the next milestone after the current one is complete — review progress, update requirements, create new phases",
		handler: async (_args, ctx) => {
			if (isBusy(ctx, ctx.ui)) return;

			const planningDir = path.join(ctx.cwd, ".planning");
			const roadmapFile = path.join(planningDir, "ROADMAP.md");
			const stateFile = path.join(planningDir, "STATE.md");
			const requirementsFile = path.join(planningDir, "REQUIREMENTS.md");

			if (!fs.existsSync(roadmapFile)) {
				ctx.ui.notify("No .planning/ROADMAP.md found. Run /new-project first.", "warning");
				return;
			}

			let context = `\nROADMAP.md:\n${fs.readFileSync(roadmapFile, "utf-8")}`;
			if (fs.existsSync(stateFile)) {
				context += `\nSTATE.md:\n${fs.readFileSync(stateFile, "utf-8")}`;
			}
			if (fs.existsSync(requirementsFile)) {
				context += `\nREQUIREMENTS.md:\n${fs.readFileSync(requirementsFile, "utf-8")}`;
			}

			// Collect UAT and summary files for completed phases
			const phasesDir = path.join(planningDir, "phases");
			if (fs.existsSync(phasesDir)) {
				for (const dir of fs.readdirSync(phasesDir)) {
					const phaseDir = path.join(phasesDir, dir);
					if (!fs.statSync(phaseDir).isDirectory()) continue;
					for (const file of fs.readdirSync(phaseDir)) {
						if (file.endsWith("-UAT.md") || file.endsWith("-SUMMARY.md")) {
							context += `\n${dir}/${file}:\n${fs.readFileSync(path.join(phaseDir, file), "utf-8")}`;
						}
					}
				}
			}

			pi.sendUserMessage(
				`Use the subagent tool to delegate to the architect agent with this task:

"We have completed a milestone. Your job is to plan the NEXT milestone.

1. Read the current ROADMAP.md and identify the completed milestone and its phases
2. Review all UAT reports and summaries to understand what was built
3. Review REQUIREMENTS.md — identify which v1 requirements are now satisfied and which remain
4. Assess if any v2 requirements should be promoted to the next milestone based on what we learned
5. Propose the next milestone with new phases:
   - Each phase has a clear goal (outcome, not activity)
   - Phases are ordered by dependency
   - Map phases to remaining/new requirements
6. Update ROADMAP.md with the new milestone and phases
7. Update STATE.md to reflect milestone transition
8. Update REQUIREMENTS.md if requirements changed based on learnings

Present the proposed milestone for user approval before writing files.

Project context:${context}"

Set agentScope to "project".`,
			);
		},
	});

	// ── /new-project ─────────────────────────────────────────────────────────
	pi.registerCommand("new-project", {
		description: "Create a new project: mkdir, git init, scaffold .draht/. Usage: /new-project <name> [/base/path]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const name = parts[0];
			if (!name) {
				ctx.ui.notify("Usage: /new-project <name> [/optional/base/path]", "warning");
				return;
			}

			const basePath = parts[1] ?? ctx.cwd;
			const projectDir = path.join(basePath, name);

			if (fs.existsSync(projectDir)) {
				ctx.ui.notify(`Directory already exists: ${projectDir}`, "warning");
				return;
			}

			fs.mkdirSync(projectDir, { recursive: true });

			const { execSync } = await import("node:child_process");
			execSync("git init", { cwd: projectDir });

			// Scaffold .draht/ from global agents
			const agentSrc = path.join(process.env.HOME ?? "~", ".draht", "agent", "agents");
			const agentDest = path.join(projectDir, ".draht", "agents");
			const extDest = path.join(projectDir, ".draht", "extensions");
			fs.mkdirSync(agentDest, { recursive: true });
			fs.mkdirSync(extDest, { recursive: true });

			let agentsCopied = 0;
			if (fs.existsSync(agentSrc)) {
				for (const file of fs.readdirSync(agentSrc)) {
					if (!file.endsWith(".md")) continue;
					fs.copyFileSync(path.join(agentSrc, file), path.join(agentDest, file));
					agentsCopied++;
				}
			}

			// Copy shipped extensions into the new project
			const extSrc = path.dirname(new URL(import.meta.url).pathname);
			for (const file of ["subagent.ts", "gsd-commands.ts"]) {
				const src = path.join(extSrc, file);
				if (fs.existsSync(src)) {
					fs.copyFileSync(src, path.join(extDest, file));
				}
			}

			fs.writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\n.env\n.env.local\n");

			ctx.ui.notify(
				`✓ ${projectDir} created — ${agentsCopied} agents, git initialized. Customize .draht/agents/*.md for your stack.`,
				"info",
			);

			pi.sendUserMessage(
				`New project "${name}" created at ${projectDir} with ${agentsCopied} GSD agents scaffolded. What should we build first?`,
			);
		},
	});

	// ── /init-project ────────────────────────────────────────────────────────
	pi.registerCommand("init-project", {
		description: "Scaffold .draht/ config into an existing project from global agent defaults",
		handler: async (_args, ctx) => {
			const targetDir = path.join(ctx.cwd, ".draht");

			if (fs.existsSync(targetDir)) {
				ctx.ui.notify(".draht/ already exists in this project", "warning");
				return;
			}

			const agentSrc = path.join(process.env.HOME ?? "~", ".draht", "agent", "agents");
			const agentDest = path.join(targetDir, "agents");
			const extDest = path.join(targetDir, "extensions");
			fs.mkdirSync(agentDest, { recursive: true });
			fs.mkdirSync(extDest, { recursive: true });

			let copied = 0;
			if (fs.existsSync(agentSrc)) {
				for (const file of fs.readdirSync(agentSrc)) {
					if (!file.endsWith(".md")) continue;
					fs.copyFileSync(path.join(agentSrc, file), path.join(agentDest, file));
					copied++;
				}
			}

			ctx.ui.notify(
				`.draht/ scaffolded with ${copied} agents. Customize .draht/agents/*.md for this project's stack.`,
				"info",
			);
		},
	});
}
