/**
 * GSD Phase Commands for fr3n-mono
 *
 * Wires up subagent parallel/chain workflows for each GSD phase.
 *
 * Commands:
 *   /new-project <name> [path]  — create project dir, git init, scaffold .draht/
 *   /init-project               — scaffold .draht/ in existing project
 *   /plan   <feature>           — architect plans the feature
 *   /execute <tasks>            — parallel implementers + chain reviewer + git-committer
 *   /verify                     — parallel lint/typecheck/tests + security audit
 *   /review <scope>             — code review on a specific scope
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@draht/coding-agent";

export default function (pi: ExtensionAPI) {
	// ── /plan ────────────────────────────────────────────────────────────────
	pi.registerCommand("plan", {
		description: "Plan a feature using the architect agent. Usage: /plan <feature description>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /plan <feature description>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}
			pi.sendUserMessage(
				`Use the subagent tool to delegate to the architect agent with this task: "${args.trim()}"\n\nSet agentScope to "project".`,
			);
		},
	});

	// ── /execute ─────────────────────────────────────────────────────────────
	pi.registerCommand("execute", {
		description:
			"Execute tasks in parallel with implementers, then chain through reviewer and git-committer. Usage: /execute <comma-separated tasks>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify(
					"Usage: /execute task1, task2, task3  (tasks run in parallel, then review + commit)",
					"warning",
				);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}

			const tasks = args
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);

			if (tasks.length === 1) {
				// Single task: chain implementer → reviewer → git-committer
				pi.sendUserMessage(
					`Use the subagent tool in chain mode with agentScope "project":
chain:
1. agent: implementer — task: "${tasks[0]}"
2. agent: reviewer — task: "Review the changes just made: {previous}"
3. agent: git-committer — task: "Commit all changes. Context from review: {previous}"`,
				);
			} else {
				// Multiple tasks: parallel implementers → reviewer → git-committer
				const parallelList = tasks.map((t, i) => `${i + 1}. agent: implementer — task: "${t}"`).join("\n");
				pi.sendUserMessage(
					`Use the subagent tool with agentScope "project":

Step 1 — run in PARALLEL mode:
${parallelList}

Step 2 — after all parallel tasks complete, run in CHAIN mode:
1. agent: reviewer — task: "Review all the changes just implemented across the codebase"
2. agent: git-committer — task: "Commit all changes. Review findings: {previous}"`,
				);
			}
		},
	});

	// ── /verify ──────────────────────────────────────────────────────────────
	pi.registerCommand("verify", {
		description: "Run parallel verification: lint, typecheck, tests, and security audit",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}
			pi.sendUserMessage(
				`Use the subagent tool in PARALLEL mode with agentScope "project" to run these simultaneously:
1. agent: verifier — task: "Run all lint, typecheck, and test checks"
2. agent: security-auditor — task: "Audit all recent changes for security issues"

After both complete, summarize the combined findings and list what needs to be fixed before this is production-ready.`,
			);
		},
	});

	// ── /new-project ─────────────────────────────────────────────────────────
	pi.registerCommand("new-project", {
		description: "Create a new project: mkdir, git init, scaffold .draht/. Usage: /new-project <name> [/optional/path]",
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

			// Create project dir
			fs.mkdirSync(projectDir, { recursive: true });

			// git init
			const { execSync } = await import("node:child_process");
			execSync("git init", { cwd: projectDir });

			// Scaffold .draht/
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

			// Copy extension templates (subagent + gsd-commands, not draco-notify)
			const extSrc = path.dirname(new URL(import.meta.url).pathname);
			for (const file of ["subagent.ts", "gsd-commands.ts"]) {
				const src = path.join(extSrc, file);
				if (fs.existsSync(src)) {
					fs.copyFileSync(src, path.join(extDest, file));
				}
			}

			// Write a minimal .gitignore
			fs.writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\n.env\n.env.local\n");

			ctx.ui.notify(
				`✓ Project created at ${projectDir} — ${agentsCopied} agents scaffolded. Open it and customize .draht/agents/*.md for your stack.`,
				"info",
			);

			// Switch cwd into the new project for the next prompt
			pi.sendUserMessage(
				`New project "${name}" created at ${projectDir}. The .draht/ config is scaffolded with ${agentsCopied} agents. What should we build first?`,
			);
		},
	});

	// ── /init-project ────────────────────────────────────────────────────────
	pi.registerCommand("init-project", {
		description: "Scaffold .draht/ config (agents + extensions) for a new project. Copies from global template.",
		handler: async (_args, ctx) => {
			const templateDir = path.join(
				path.dirname(path.dirname(require.resolve("@draht/coding-agent"))),
				"templates",
				"project",
			);
			const targetDir = path.join(ctx.cwd, ".draht");

			if (fs.existsSync(targetDir)) {
				ctx.ui.notify(".draht/ already exists in this project", "warning");
				return;
			}

			// Fallback: copy from global agent dir structure
			const agentSrc = path.join(
				process.env.HOME ?? "~",
				".draht",
				"agent",
				"agents",
			);
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
				`.draht/ scaffolded with ${copied} agents. Customize .draht/agents/*.md for this project.`,
				"info",
			);
		},
	});

	// ── /review ──────────────────────────────────────────────────────────────
	pi.registerCommand("review", {
		description: "Code review a specific scope. Usage: /review <scope or files>",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy", "warning");
				return;
			}
			const scope = args.trim() || "all recent changes";
			pi.sendUserMessage(
				`Use the subagent tool in PARALLEL mode with agentScope "project":
1. agent: reviewer — task: "Review ${scope} for correctness, type safety, and fr3n conventions"
2. agent: security-auditor — task: "Audit ${scope} for security vulnerabilities"

After both complete, merge the findings into a single prioritized report.`,
			);
		},
	});
}
