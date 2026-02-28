/**
 * Coding agent extension for multi-agent orchestration.
 */

import type { ExtensionFactory } from "@draht/coding-agent";
import { TicketDecomposer } from "./decomposer.js";
import { OrchestratorEngine } from "./engine.js";

export const orchestratorExtension: ExtensionFactory = (pi) => {
	pi.registerCommand("orchestrate", {
		description: "Multi-agent task orchestration: decompose and execute tasks",
		handler: async (args, ctx) => {
			const apiKey = process.env.ANTHROPIC_API_KEY;
			if (!apiKey) {
				ctx.ui.notify("ANTHROPIC_API_KEY required for orchestration", "error");
				return;
			}

			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];

			if (subcommand === "plan") {
				const description = parts.slice(1).join(" ");
				if (!description) {
					ctx.ui.notify("Usage: /orchestrate plan <task description>", "warning");
					return;
				}

				ctx.ui.notify("🔍 Decomposing task...", "info");
				const decomposer = new TicketDecomposer(apiKey);
				const plan = await decomposer.decompose(description);

				const summary = plan.subTasks
					.map((t) => `  ${t.id}: [${t.agentType}] ${t.title}${t.dependsOn.length ? ` (after: ${t.dependsOn.join(", ")})` : ""}`)
					.join("\n");
				ctx.ui.notify(`📋 Plan (${plan.subTasks.length} sub-tasks):\n${summary}`, "info");
				return;
			}

			if (subcommand === "resume") {
				const engine = new OrchestratorEngine(apiKey);
				const state = engine.loadState();
				if (!state) {
					ctx.ui.notify("No saved orchestration state found", "warning");
					return;
				}
				ctx.ui.notify(`▶️ Resuming: ${state.plan.description}`, "info");
				const result = await engine.execute(state.plan, (event) => {
					if (event.type === "subtask_start") ctx.ui.notify(`🔄 ${event.subTask.title}...`, "info");
					if (event.type === "subtask_complete") ctx.ui.notify(`✅ ${event.subTask.title}`, "info");
					if (event.type === "subtask_failed") ctx.ui.notify(`❌ ${event.subTask.title}: ${event.error}`, "error");
				});
				ctx.ui.notify(`\n📊 Done: ${result.completedSubTasks.length} completed, ${result.failedSubTasks.length} failed\n\n${result.synthesizedResult}`, "info");
				return;
			}

			// Default: decompose and execute
			const description = args.trim();
			if (!description) {
				ctx.ui.notify("Usage: /orchestrate <task> | /orchestrate plan <task> | /orchestrate resume", "info");
				return;
			}

			ctx.ui.notify("🔍 Decomposing task...", "info");
			const decomposer = new TicketDecomposer(apiKey);
			const plan = await decomposer.decompose(description);
			ctx.ui.notify(`📋 ${plan.subTasks.length} sub-tasks planned. Executing...`, "info");

			const engine = new OrchestratorEngine(apiKey);
			const result = await engine.execute(plan, (event) => {
				if (event.type === "subtask_start") ctx.ui.notify(`🔄 ${event.subTask.title}...`, "info");
				if (event.type === "subtask_complete") ctx.ui.notify(`✅ ${event.subTask.title}`, "info");
				if (event.type === "subtask_failed") ctx.ui.notify(`❌ ${event.subTask.title}: ${event.error}`, "error");
			});

			ctx.ui.notify(`\n📊 Done: ${result.completedSubTasks.length} completed, ${result.failedSubTasks.length} failed\n\n${result.synthesizedResult}`, "info");
		},
	});
};
