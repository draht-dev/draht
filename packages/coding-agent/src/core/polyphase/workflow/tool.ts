/**
 * The `workflow` tool definition (§14.1): model-only, defaultActive false, registered lazily by
 * `builtins/polyphase.ts` the first time the keyword or a resumed session needs it.
 */

import { Type } from "@sinclair/typebox";
import { getAgentDir } from "../../../config.ts";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "../../extensions/types.ts";
import { createPartialUpdateEmitter, type PartialUpdateEmitter } from "../emitter.ts";
import { createWorkflowRenderers, type PolyphaseRenderDeps, type PolyphaseRowState } from "../render/renderers.ts";
import type { PolyphaseSession } from "../session.ts";
import {
	type AgentRunner,
	currentPolyphaseDepth,
	type PolyphaseDetails,
	WORKFLOW_TOOL_NAME,
	type WorkflowSource,
} from "../types.ts";
import { WORKFLOW_PROMPT_GUIDELINES, WORKFLOW_PROMPT_SNIPPET, WORKFLOW_TOOL_DESCRIPTION } from "./guidance.ts";
import { startWorkflowRun } from "./launch.ts";
import { extractWorkflowMeta } from "./meta.ts";
import { discoverSavedWorkflows, findSavedWorkflow, readSavedWorkflowSource } from "./saved.ts";

const WorkflowParams = Type.Object({
	script: Type.Optional(
		Type.String({
			description:
				"Workflow script: `export const meta = {...}` first, then an async body using agent, parallel, pipeline, phase, log, args, budget",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Run a saved workflow (.draht/workflows/<name>.js or <agentDir>/workflows/<name>.js) instead of an inline script",
		}),
	),
	args: Type.Optional(Type.String({ description: "Input passed verbatim to the script as `args`" })),
	budgetTokens: Type.Optional(
		Type.Integer({
			minimum: 1000,
			description: "Hard ceiling on billable tokens (input + output + cache writes) across all agents of this run",
		}),
	),
});

/** Early errors (unknown name, invalid meta, wrong arguments) return before a run exists. */
type WorkflowToolDetails = PolyphaseDetails | Record<string, never>;

export interface WorkflowToolDeps {
	getSession(ctx: ExtensionContext): PolyphaseSession;
	runner?: AgentRunner;
	renderDeps: PolyphaseRenderDeps;
}

function errorResult(text: string): AgentToolResult<WorkflowToolDetails> {
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

export function createWorkflowToolDefinition(
	deps: WorkflowToolDeps,
): ToolDefinition<typeof WorkflowParams, WorkflowToolDetails, PolyphaseRowState> {
	const renderers = createWorkflowRenderers(deps.renderDeps);

	return {
		name: WORKFLOW_TOOL_NAME,
		label: "Workflow",
		description: WORKFLOW_TOOL_DESCRIPTION,
		promptSnippet: WORKFLOW_PROMPT_SNIPPET,
		promptGuidelines: [...WORKFLOW_PROMPT_GUIDELINES],
		parameters: WorkflowParams,
		exposure: "model-only",
		defaultActive: false,
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if ((params.script === undefined) === (params.name === undefined)) {
				return errorResult("Exactly one of `script` or `name` must be given.");
			}
			if (currentPolyphaseDepth() >= 1) {
				return errorResult("The workflow tool is not available to subagents.");
			}

			const session = deps.getSession(ctx);
			const settings = session.settings();

			let source: string;
			let sourceInfo: { kind: WorkflowSource; path?: string };
			if (params.script !== undefined) {
				source = params.script;
				sourceInfo = { kind: "inline" };
			} else if (params.name !== undefined) {
				const discovery = {
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					projectTrusted: ctx.isProjectTrusted(),
				};
				const found = findSavedWorkflow(params.name, discovery);
				if (!found) {
					const names = discoverSavedWorkflows(discovery)
						.workflows.map((workflow) => workflow.name)
						.join(", ");
					return errorResult(`Unknown saved workflow "${params.name}". Available: ${names || "(none)"}`);
				}
				try {
					source = readSavedWorkflowSource(found);
				} catch (error) {
					return errorResult(error instanceof Error ? error.message : String(error));
				}
				sourceInfo = { kind: found.source, path: found.path };
			} else {
				return errorResult("Exactly one of `script` or `name` must be given.");
			}

			const extraction = extractWorkflowMeta(source);
			if (!extraction.ok) {
				return errorResult(
					`Workflow meta is invalid at line ${extraction.error.line}, column ${extraction.error.column}: ${extraction.error.message}`,
				);
			}

			const handle = startWorkflowRun({
				ctx,
				session,
				id: toolCallId,
				origin: "tool",
				parentSignal: signal,
				meta: extraction.meta,
				body: extraction.body,
				args: params.args ?? "",
				source: sourceInfo,
				budgetTokens: params.budgetTokens ?? settings.defaultBudgetTokens,
				runner: deps.runner,
			});
			// §13.1: unknown meta keys (e.g. a typo'd phase field) produce warnings instead of
			// failing the run; without this they are silently discarded, with no sign anywhere that
			// the key was ignored.
			for (const warning of extraction.warnings) handle.run.appendLog(warning, "warning");

			let emitter: PartialUpdateEmitter;
			try {
				emitter = createPartialUpdateEmitter(handle.run, onUpdate, {
					mode: ctx.mode,
					liveUpdateMs: settings.liveUpdateMs,
				});
			} catch {
				// emitNow() runs synchronously inside the emitter's constructor (§10.7); if it throws,
				// the run is already under way with no subscriber. Cancel it rather than leaving it to
				// spend tokens unobserved, and still report its (failed) completion.
				handle.run.cancel("run");
				const completion = await handle.done;
				return {
					content: [{ type: "text", text: completion.text }],
					details: completion.details,
					usage: completion.usage,
					isError: completion.isError,
				};
			}
			try {
				const completion = await handle.done;
				return {
					content: [{ type: "text", text: completion.text }],
					details: completion.details,
					usage: completion.usage,
					isError: completion.isError,
				};
			} finally {
				emitter.dispose();
			}
		},
	};
}
