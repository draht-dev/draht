/**
 * Core builtin for polyphase (§16.3-16.4): lazily registers the `workflow` tool (on the keyword,
 * `polyphase.workflowTool: "always"`, or a resumed session that already used it), the saved
 * `/<name>` commands, the running-agents dock and agent inspector, and — in a child process — the
 * `polyphase_result` structured-output tool.
 */

import { Text } from "@draht/tui";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, MessageRenderer } from "../extensions/types.ts";
import {
	type PolyphaseCommandDeps,
	planSavedWorkflowCommands,
	registerSavedWorkflowCommands,
	registerWorkflowCommands,
	type SavedCommandPlan,
} from "../polyphase/commands.ts";
import { collectArchivedRuns } from "../polyphase/details.ts";
import { createKeywordHooks } from "../polyphase/keyword.ts";
import { createPolyphaseMessageRenderer, type PolyphaseRenderDeps } from "../polyphase/render/renderers.ts";
import { disposePolyphaseSession, getPolyphaseSession, type PolyphaseSession } from "../polyphase/session.ts";
import { resolvePolyphaseSettings } from "../polyphase/settings.ts";
import { type AgentRunner, currentPolyphaseDepth, WORKFLOW_TOOL_NAME } from "../polyphase/types.ts";
import { installPolyphaseUi, type PolyphaseUiController } from "../polyphase/ui/controller.ts";
import { buildAuthoringGuide } from "../polyphase/workflow/guidance.ts";
import { discoverSavedWorkflows, type SavedWorkflow, type SavedWorkflowSummary } from "../polyphase/workflow/saved.ts";
import { registerChildResultTool } from "../polyphase/workflow/structured-output.ts";
import { createWorkflowToolDefinition } from "../polyphase/workflow/tool.ts";
import type { SessionEntry } from "../session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../slash-commands.ts";
import { discoverAgents } from "./subagent.ts";

export interface PolyphaseExtensionOptions {
	runner?: AgentRunner;
}

const RESERVED_COMMAND_NAMES: readonly string[] = ["workflow", "workflows", "polyphase"];

function isWorkflowToolResultEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === WORKFLOW_TOOL_NAME
	);
}

function summarizeSavedWorkflows(workflows: readonly SavedWorkflow[], plan: SavedCommandPlan): SavedWorkflowSummary[] {
	const registered = new Set(plan.register.map((workflow) => workflow.name));
	return workflows.map((workflow) => ({
		name: workflow.name,
		description: workflow.description,
		source: workflow.source,
		valid: workflow.valid,
		...(registered.has(workflow.name) ? { command: workflow.name } : {}),
	}));
}

function formatSkippedWarning(skipped: SavedCommandPlan["skipped"][number]): string {
	return `Saved workflow "${skipped.workflow.name}" is not registered as /${skipped.workflow.name} (${skipped.reason}); run it with /workflow ${skipped.workflow.name}`;
}

function createGuidanceMessageRenderer(): MessageRenderer<{ keyword?: string }> {
	return (message, options, theme) => {
		const header = `${theme.fg("accent", "◆")} ${theme.fg(
			"toolTitle",
			"polyphase · workflow tool enabled · authoring guide sent to the model",
		)}`;
		if (!options.expanded) return new Text(header, 0, 0);
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		return new Text(`${header}\n${text}`, 0, 0);
	};
}

export function createPolyphaseExtension(options: PolyphaseExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		if (currentPolyphaseDepth() >= 1) {
			registerChildResultTool(pi);
			return;
		}

		let currentSession: PolyphaseSession | undefined;
		let ui: PolyphaseUiController | undefined;
		let workflowRegistrationAttempted = false;
		let workflowAutoActivated = false;
		let latestSavedWorkflows: readonly SavedWorkflow[] = [];

		const renderDeps: PolyphaseRenderDeps = {
			getStore: () => currentSession?.store,
			viewportRows: () => process.stdout.rows || 24,
			limiterStats: () => currentSession?.limiter.stats(),
		};

		function ensureWorkflowTool(): boolean {
			if (!workflowRegistrationAttempted) {
				workflowRegistrationAttempted = true;
				if (!pi.getAllTools().some((tool) => tool.name === WORKFLOW_TOOL_NAME)) {
					pi.registerTool(
						createWorkflowToolDefinition({
							getSession: (ctx) => getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase),
							runner: options.runner,
							renderDeps,
						}),
					);
				}
			}
			return pi.getAllTools().some((tool) => tool.name === WORKFLOW_TOOL_NAME);
		}

		function activate(activateOptions?: { auto?: boolean }): void {
			const active = pi.getActiveTools();
			if (active.includes(WORKFLOW_TOOL_NAME)) return;
			pi.setActiveTools([...active, WORKFLOW_TOOL_NAME]);
			if (activateOptions?.auto !== false) workflowAutoActivated = true;
		}

		function deactivateIfAuto(): void {
			if (!workflowAutoActivated) return;
			workflowAutoActivated = false;
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== WORKFLOW_TOOL_NAME));
		}

		function buildGuide(ctx: ExtensionContext): string {
			const settings = resolvePolyphaseSettings(pi.getSettings().polyphase);
			const agents = discoverAgents(ctx.cwd, "both", ctx.isProjectTrusted());
			const discovery = discoverSavedWorkflows({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				projectTrusted: ctx.isProjectTrusted(),
			});
			return buildAuthoringGuide({
				agentTypes: agents.map((agent) => agent.name),
				savedNames: discovery.workflows.map((workflow) => workflow.name),
				limits: {
					concurrency: settings.maxConcurrency,
					maxAgents: settings.maxAgentsPerRun,
					maxItems: settings.maxItemsPerCall,
				},
			});
		}

		const commandDeps: PolyphaseCommandDeps = {
			pi,
			getSession: (ctx) => getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase),
			getUi: () => ui,
			runner: options.runner,
			keyword: () => resolvePolyphaseSettings(pi.getSettings().polyphase).keyword,
			getSavedWorkflows: () => latestSavedWorkflows,
		};

		registerWorkflowCommands(commandDeps);

		pi.registerMessageRenderer("polyphase-workflow", createPolyphaseMessageRenderer());
		pi.registerMessageRenderer("polyphase-guidance", createGuidanceMessageRenderer());

		const keywordHooks = createKeywordHooks({
			pi,
			settings: () => resolvePolyphaseSettings(pi.getSettings().polyphase),
			ensureTool: ensureWorkflowTool,
			activate,
			deactivateIfAuto,
			buildGuide,
		});

		pi.on("input", (event, ctx) => keywordHooks.onInput(event, ctx));
		pi.on("before_agent_start", (event, ctx) => keywordHooks.onBeforeAgentStart(event, ctx));
		pi.on("agent_settled", (_event, ctx) => keywordHooks.onAgentSettled(ctx));

		pi.on("session_start", (_event, ctx) => {
			const session = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
			currentSession = session;
			const settings = session.settings();

			if (settings.workflowTool === "always") {
				if (ensureWorkflowTool()) activate({ auto: false });
			} else if (ctx.sessionManager.getBranch().some(isWorkflowToolResultEntry)) {
				ensureWorkflowTool();
			}

			const discovery = discoverSavedWorkflows({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				projectTrusted: ctx.isProjectTrusted(),
			});
			latestSavedWorkflows = discovery.workflows;
			const plan = planSavedWorkflowCommandsFor(pi, discovery.workflows);
			registerSavedWorkflowCommands(commandDeps, plan);

			const warningLines = [
				...settings.warnings,
				...discovery.diagnostics.filter((diagnostic) => diagnostic.level === "warning").map((d) => d.message),
				...plan.skipped.map(formatSkippedWarning),
			];
			const infoLines = discovery.diagnostics
				.filter((diagnostic) => diagnostic.level === "info")
				.map((d) => d.message);
			const diagnosticLines = [...warningLines, ...infoLines];
			if (diagnosticLines.length > 0) {
				ctx.ui.notify(diagnosticLines.join("\n"), warningLines.length > 0 ? "warning" : "info");
			}

			if (ctx.mode === "tui") {
				ui = installPolyphaseUi({
					ctx,
					session,
					getArchivedRuns: () =>
						collectArchivedRuns(
							ctx.sessionManager.getBranch(),
							new Set(session.store.runs().map((run) => run.id)),
						),
					getSavedWorkflows: () => summarizeSavedWorkflows(discovery.workflows, plan),
					hideThinkingBlock: () => pi.getSettings().hideThinkingBlock === true,
				});
			}
		});

		pi.on("session_shutdown", (_event, ctx) => {
			ui?.dispose();
			ui = undefined;
			disposePolyphaseSession(ctx.sessionManager, "shutdown");
			currentSession = undefined;
		});

		pi.on("ui_prompt_start", (event) => ui?.notePromptStart(event.kind));
		pi.on("ui_prompt_end", () => ui?.notePromptEnd());
	};
}

function planSavedWorkflowCommandsFor(pi: ExtensionAPI, workflows: readonly SavedWorkflow[]): SavedCommandPlan {
	return planSavedWorkflowCommands(workflows, {
		builtin: BUILTIN_SLASH_COMMANDS.map((command) => command.name),
		commands: pi.getCommands(),
		reserved: RESERVED_COMMAND_NAMES,
	});
}

export default createPolyphaseExtension();
