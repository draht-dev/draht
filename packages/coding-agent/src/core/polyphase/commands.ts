/**
 * `/workflow`, `/workflows` and the per-saved-workflow `/<name>` commands (§16.2), plus the
 * command-path approval flow (§15.3). Saved workflow runs started this way are host-side: they
 * are independent of agent turns and report back with a non-triggering custom message.
 */

import { randomUUID } from "node:crypto";
import { getAgentDir } from "../../config.ts";
import { keyDisplayText } from "../../modes/interactive/components/keybinding-hints.ts";
import { loadPermissionRules } from "../builtins/subagent.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../extensions/types.ts";
import { PermissionGate } from "../multi-agent/index.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import { type ApprovalContext, describeToolCallForApproval } from "./approval.ts";
import { collectArchivedRuns } from "./details.ts";
import type { PolyphaseSession } from "./session.ts";
import type { AgentRunner } from "./types.ts";
import type { PolyphaseUiController } from "./ui/controller.ts";
import { startWorkflowRun, type WorkflowRunCompletion } from "./workflow/launch.ts";
import { extractWorkflowMeta } from "./workflow/meta.ts";
import {
	discoverSavedWorkflows,
	readSavedWorkflowSource,
	type SavedDiscoveryOptions,
	type SavedWorkflow,
} from "./workflow/saved.ts";

export interface PolyphaseCommandDeps {
	pi: ExtensionAPI;
	getSession(ctx: ExtensionContext): PolyphaseSession;
	getUi(): PolyphaseUiController | undefined;
	runner?: AgentRunner;
	keyword(): string;
	/** The most recent discovery result, refreshed at every `session_start`. */
	getSavedWorkflows(): readonly SavedWorkflow[];
}

export interface SavedCommandPlan {
	register: SavedWorkflow[];
	skipped: Array<{ workflow: SavedWorkflow; reason: string }>;
}

function discoveryOptions(ctx: ExtensionContext): SavedDiscoveryOptions {
	return { cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() };
}

function describeSavedWorkflow(workflow: SavedWorkflow): string {
	return `${workflow.name} — ${workflow.description}`;
}

/**
 * Collision check for every valid saved workflow name against `BUILTIN_SLASH_COMMANDS`,
 * `pi.getCommands()` (including the bare name after `skill:`), and the reserved polyphase names.
 * Invalid workflows are silently excluded: they are already diagnosed by `discoverSavedWorkflows`.
 */
export function planSavedWorkflowCommands(
	workflows: readonly SavedWorkflow[],
	existing: { builtin: readonly string[]; commands: readonly SlashCommandInfo[]; reserved: readonly string[] },
): SavedCommandPlan {
	const builtinNames = new Set(existing.builtin);
	const reservedNames = new Set(existing.reserved);
	const commandNames = new Set<string>();
	for (const command of existing.commands) {
		commandNames.add(command.name);
		if (command.name.startsWith("skill:")) commandNames.add(command.name.slice("skill:".length));
	}

	const register: SavedWorkflow[] = [];
	const skipped: SavedCommandPlan["skipped"] = [];
	const claimed = new Set<string>();

	for (const workflow of workflows) {
		if (!workflow.valid) continue;
		const name = workflow.name;
		if (builtinNames.has(name)) {
			skipped.push({ workflow, reason: "conflicts with a built-in command" });
			continue;
		}
		if (reservedNames.has(name)) {
			skipped.push({ workflow, reason: "is a reserved polyphase command name" });
			continue;
		}
		if (commandNames.has(name) || claimed.has(name)) {
			skipped.push({ workflow, reason: "conflicts with an existing command" });
			continue;
		}
		claimed.add(name);
		register.push(workflow);
	}

	return { register, skipped };
}

/** Called at `session_start`: registers `/<name>` for every planned saved workflow. */
export function registerSavedWorkflowCommands(deps: PolyphaseCommandDeps, plan: SavedCommandPlan): void {
	for (const workflow of plan.register) {
		deps.pi.registerCommand(workflow.name, {
			description: workflow.description,
			handler: async (args, ctx) => {
				await runSavedWorkflowFromCommand(deps, workflow.name, args.trim(), ctx);
			},
		});
	}
}

/** `/<name> [args]` and `/workflow <name> [args]` (§15.3): gate, approve, start, report back. */
export async function runSavedWorkflowFromCommand(
	deps: PolyphaseCommandDeps,
	name: string,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const discovery = discoverSavedWorkflows(discoveryOptions(ctx));
	const workflow = discovery.workflows.find((candidate) => candidate.name === name);
	if (!workflow) {
		const available = discovery.workflows.map((candidate) => candidate.name).join(", ");
		ctx.ui.notify(`Unknown saved workflow "${name}". Available: ${available || "(none)"}`, "error");
		return;
	}
	if (!workflow.valid) {
		ctx.ui.notify(
			`Saved workflow "${name}" has an invalid meta block: ${workflow.error ?? "unknown error"}`,
			"error",
		);
		return;
	}

	let source: string;
	try {
		source = readSavedWorkflowSource(workflow);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	const extraction = extractWorkflowMeta(source);
	if (!extraction.ok) {
		ctx.ui.notify(
			`Saved workflow "${name}" has an invalid meta block at line ${extraction.error.line}: ${extraction.error.message}`,
			"error",
		);
		return;
	}

	const session = deps.getSession(ctx);
	const settings = session.settings();

	const gate = new PermissionGate(loadPermissionRules(ctx.cwd, ctx.isProjectTrusted()), {
		cwd: ctx.cwd,
		mode: session.permissionMode(),
	});
	const decision = gate.evaluate("workflow", { name, args });

	if (decision.action === "deny") {
		ctx.ui.notify(decision.reason, "error");
		return;
	}

	if (decision.action === "approve") {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Workflow ${name} needs approval but no UI is available; use /yolo or an allow rule`, "error");
			return;
		}
		session.notifyParentPrompt();
		const approvalContext: ApprovalContext = {
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			agentDir: getAgentDir(),
			limits: {
				concurrency: settings.maxConcurrency,
				maxAgents: settings.maxAgentsPerRun,
				budgetTokens: settings.defaultBudgetTokens,
			},
		};
		const description = describeToolCallForApproval("workflow", { name, args }, approvalContext);
		const title = description?.title ?? `Run workflow "${name}"?`;
		const message = description?.message ?? extraction.meta.description;
		const approved = await ctx.ui.confirm(title, message);
		if (!approved) {
			ctx.ui.notify(`Workflow ${name} not started`, "info");
			return;
		}
		// A session_shutdown can run while the confirm dialog is open (e.g. an RPC new_session or
		// switch_session); the disposed session's store/limiter have already cancelled and rejected
		// everything, and nothing is left to cancel a run started on it afterwards.
		if (session.disposed) return;
	}

	const handle = startWorkflowRun({
		ctx,
		session,
		id: `cmd-${randomUUID()}`,
		origin: "command",
		parentSignal: undefined,
		meta: extraction.meta,
		body: extraction.body,
		args,
		source: { kind: workflow.source, path: workflow.path },
		budgetTokens: settings.defaultBudgetTokens,
		runner: deps.runner,
	});

	const reportCompletion = (completion: WorkflowRunCompletion): void => {
		if (session.disposed) return;
		try {
			deps.pi.sendMessage(
				{
					customType: "polyphase-workflow",
					content: [{ type: "text", text: completion.text }],
					display: true,
					details: completion.details,
				},
				{ triggerTurn: false },
			);
		} catch {
			// The extension runtime can go stale concurrently (e.g. a session shutdown that raced
			// this report); the run already finished and was recorded, so dropping the message here
			// is safe and must never surface as an unhandled rejection.
		}
	};

	const inspectorHint = keyDisplayText("app.polyphase.inspector");
	ctx.ui.notify(`Started workflow ${name}${inspectorHint ? ` · ${inspectorHint} to inspect` : ""}`, "info");

	// print/json have no inspector and no later agent turn to pick up a background report, and
	// disposing the runtime right after this handler returns (print mode) would cancel the run
	// before it ever reports (§19): await it instead of firing and forgetting.
	if (ctx.mode === "print" || ctx.mode === "json") {
		const completion = await handle.done;
		reportCompletion(completion);
		return;
	}

	void handle.done.then(reportCompletion);
}

/** `/workflow` and `/workflows` (factory body, registered once per extension instance). */
export function registerWorkflowCommands(deps: PolyphaseCommandDeps): void {
	deps.pi.registerCommand("workflow", {
		description: "Run a saved workflow, or describe a new one. Usage: /workflow [name] [args]",
		getArgumentCompletions: (partial) => {
			return deps
				.getSavedWorkflows()
				.filter((workflow) => workflow.name.startsWith(partial))
				.map((workflow) => ({ value: workflow.name, label: describeSavedWorkflow(workflow) }));
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed) {
				const match = /\s/.exec(trimmed);
				const name = match ? trimmed.slice(0, match.index) : trimmed;
				const workflowArgs = match ? trimmed.slice(match.index + 1).trim() : "";
				await runSavedWorkflowFromCommand(deps, name, workflowArgs, ctx);
				return;
			}

			const discovery = discoverSavedWorkflows(discoveryOptions(ctx));
			if (ctx.mode === "tui" && ctx.hasUI) {
				const describeNew = "Describe a new workflow…";
				const options = [...discovery.workflows.map(describeSavedWorkflow), describeNew];
				const choice = await ctx.ui.select("Run a workflow", options);
				if (choice === undefined) return;
				if (choice === describeNew) {
					ctx.ui.setEditorText(`${deps.keyword()} `);
					return;
				}
				const index = options.indexOf(choice);
				const workflow = discovery.workflows[index];
				if (workflow) await runSavedWorkflowFromCommand(deps, workflow.name, "", ctx);
				return;
			}

			const lines = [
				...discovery.workflows.map(
					(workflow) =>
						`${workflow.name} (${workflow.source}${workflow.valid ? "" : ", invalid"}) — ${workflow.description}`,
				),
				...discovery.diagnostics.map((diagnostic) => diagnostic.message),
			];
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No saved workflows found.", "info");
		},
	});

	deps.pi.registerCommand("workflows", {
		description: "List workflow runs and saved workflows, or open the inspector. Usage: /workflows [list]",
		handler: async (args, ctx) => {
			if (args.trim() !== "list" && ctx.mode === "tui" && ctx.hasUI) {
				deps.getUi()?.openInspector({ view: "runs" });
				return;
			}

			const session = deps.getSession(ctx);
			const runs = session.store.runs();
			const liveRunIds = new Set(runs.map((run) => run.id));
			const archived = collectArchivedRuns(ctx.sessionManager.getBranch(), liveRunIds);
			const discovery = discoverSavedWorkflows(discoveryOptions(ctx));

			const lines = [
				...runs.map((run) => `${run.status}: ${run.title}`),
				...archived.map((entry) => `${entry.details.status}: ${entry.details.title}`),
				...discovery.workflows.map(describeSavedWorkflow),
			];
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No workflow runs.", "info");
		},
	});
}
