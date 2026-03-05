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
 * Planning:
 *   /create-plan <N> <P> [title] — scaffold a new PLAN.md for phase N, plan P
 *   /commit-task <N> <P> <T> <desc> — commit current changes as task T of plan P
 *   /create-domain-model         — scaffold DOMAIN-MODEL.md from PROJECT.md
 *   /map-codebase                — scan codebase, write .planning/codebase/ files
 *
 * Utilities:
 *   /review  <scope>            — ad-hoc code review + security audit
 *   /fix     <issue>            — targeted fix plan for a failing task
 *   /quick   <task>             — one-shot implement + commit (skip full GSD)
 *   /resume                     — pick up interrupted work from CONTINUE-HERE.md
 *   /status                     — show .planning/STATE.md overview
 *   /new-project <name> [path]  — create project dir, git init, scaffold .draht/
 *   /init-project               — scaffold .draht/ in existing project
 */

import { execSync as _execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	commitTask,
	createDomainModel,
	createPlan,
	mapCodebase,
} from "@draht/coding-agent";
import type { ExtensionAPI } from "@draht/coding-agent";

function isBusy(ctx: { isIdle: () => boolean }, ui: { notify: (msg: string, level: string) => void }): boolean {
	if (!ctx.isIdle()) {
		ui.notify("Agent is busy", "warning");
		return true;
	}
	return false;
}

function runGsdHook(cwd: string, hookName: string): void {
	const hookPath = path.join(
		cwd,
		"node_modules",
		"@draht",
		"coding-agent",
		"hooks",
		"gsd",
		`${hookName}.js`,
	);
	if (fs.existsSync(hookPath)) {
		try {
			// draht-pre-execute and draht-post-phase are invoked here
			_execSync(`node "${hookPath}"`, { cwd, stdio: "inherit" });
		} catch {
			// Advisory — hook failures don't block the command
		}
	}
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

			// Run draht-pre-execute hook (validates .planning/ setup)
			runGsdHook(ctx.cwd, "draht-pre-execute");

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

			// Run draht-post-phase hook (records phase completion)
			runGsdHook(ctx.cwd, "draht-post-phase");

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

	// ── /create-plan ─────────────────────────────────────────────────────────
	pi.registerCommand("create-plan", {
		description: "Scaffold a new PLAN.md. Usage: /create-plan <phase> <plan> [title]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const phaseNum = parseInt(parts[0] ?? "", 10);
			const planNum = parseInt(parts[1] ?? "", 10);
			if (!phaseNum || !planNum) {
				ctx.ui.notify("Usage: /create-plan <phase> <plan> [title]", "warning");
				return;
			}
			const title = parts.slice(2).join(" ");
			try {
				const planFile = createPlan(ctx.cwd, phaseNum, planNum, title);
				ctx.ui.notify(`Created: ${planFile}`, "info");
			} catch (err) {
				ctx.ui.notify(`Failed: ${String(err)}`, "error");
			}
		},
	});

	// ── /commit-task ──────────────────────────────────────────────────────────
	pi.registerCommand("commit-task", {
		description: "Commit changes as a GSD task. Usage: /commit-task <phase> <plan> <task> <description>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const phaseNum = parseInt(parts[0] ?? "", 10);
			const planNum = parseInt(parts[1] ?? "", 10);
			if (!phaseNum || !planNum) {
				ctx.ui.notify("Usage: /commit-task <phase> <plan> <task> <description>", "warning");
				return;
			}
			const description = parts.slice(3).join(" ") || "implement task";
			try {
				const result = commitTask(ctx.cwd, phaseNum, planNum, description);
				if (!result.hash) {
					ctx.ui.notify("Nothing to commit", "warning");
					return;
				}
				if (result.tddWarning) {
					ctx.ui.notify(
						`⚠️  TDD: no test files in commit ${result.hash.slice(0, 8)} — write tests first`,
						"warning",
					);
				} else {
					ctx.ui.notify(`Committed: ${result.hash.slice(0, 8)} — ${description}`, "info");
				}
			} catch (err) {
				ctx.ui.notify(`Failed: ${String(err)}`, "error");
			}
		},
	});

	// ── /create-domain-model ──────────────────────────────────────────────────
	pi.registerCommand("create-domain-model", {
		description: "Generate .planning/DOMAIN-MODEL.md scaffold from PROJECT.md",
		handler: async (_args, ctx) => {
			if (isBusy(ctx, ctx.ui)) return;
			try {
				const outPath = createDomainModel(ctx.cwd);
				ctx.ui.notify(`Created: ${outPath}`, "info");
				pi.sendUserMessage(
					`DOMAIN-MODEL.md created at ${outPath}. Read it and fill in the sections: bounded contexts, entities, value objects, aggregates, ubiquitous language. Use the codebase and PROJECT.md as source material.`,
				);
			} catch (err) {
				ctx.ui.notify(`Failed: ${String(err)}`, "error");
			}
		},
	});

	// ── /map-codebase ─────────────────────────────────────────────────────────
	pi.registerCommand("map-codebase", {
		description: "Scan codebase and write .planning/codebase/ analysis files",
		handler: async (_args, ctx) => {
			if (isBusy(ctx, ctx.ui)) return;
			try {
				const files = mapCodebase(ctx.cwd);
				ctx.ui.notify(`Mapped ${files.length} codebase files`, "info");
				pi.sendUserMessage(
					`Codebase mapping complete. Files created:\n${files.join("\n")}\n\nReview each file and fill in the TODO sections with real analysis of the codebase.`,
				);
			} catch (err) {
				ctx.ui.notify(`Failed: ${String(err)}`, "error");
			}
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
