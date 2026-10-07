/**
 * Bridges a workflow script's `agent()`/`phase()`/`log()` calls to real subagent runs (§14.3): one
 * `WorkflowHost` per run, created by `launch.ts` and handed to `runWorkflowScript`.
 */

import { discoverAgents, runSingleTask } from "../../builtins/subagent.ts";
import type { ExtensionContext } from "../../extensions/types.ts";
import { type ChildModelChoice, ModelSelectionError, resolveChildModel } from "../model-selection.ts";
import type { PolyphaseSession } from "../session.ts";
import type { PolyphaseRun } from "../store.ts";
import {
	type AgentConfig,
	type AgentRunner,
	type CancelReason,
	currentPolyphaseDepth,
	POLYPHASE_RESULT_TOOL_NAME,
	type RunResult,
} from "../types.ts";
import type { WorkflowMeta } from "./meta.ts";
import type { WorkflowAgentReply, WorkflowAgentRequest, WorkflowHost } from "./runtime.ts";
import { prepareResultSchema, STRUCTURED_OUTPUT_INSTRUCTION } from "./structured-output.ts";

export interface WorkflowAgentHostDeps {
	ctx: ExtensionContext;
	session: PolyphaseSession;
	run: PolyphaseRun;
	meta: WorkflowMeta;
	mailbox: string;
	runner?: AgentRunner;
}

const DEFAULT_WORKFLOW_AGENT_CONFIG: AgentConfig = {
	name: "workflow-agent",
	description: "polyphase workflow agent",
	systemPrompt:
		"You are an agent in a polyphase workflow. Do the task; your final message is returned to the orchestrating script.",
	source: "user",
};

/** First non-empty trimmed line of `stderr`, else `errorMessage`'s first non-empty trimmed line,
 * else `exit code N`: a stderr that is blank or starts with a bare newline (or a leading runtime
 * warning line) must not leave the failure log line with no detail at all. */
function failureDetail(stderr: string, errorMessage: string | undefined, exitCode: number): string {
	for (const candidate of [stderr, errorMessage ?? ""]) {
		for (const line of candidate.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) return trimmed;
		}
	}
	return `exit code ${exitCode}`;
}

/** `cancelReason "user"` reads as "you" in the log line; every other reason reads verbatim. */
function cancelReasonText(reason: CancelReason | undefined): string {
	return reason === "user" ? "you" : (reason ?? "run");
}

export interface WorkflowAgentHost extends WorkflowHost {
	/** Resolves once every `runSingleTask` started by this host has settled; bounded by the child
	 * kill grace period. Waiting on it after the script finishes (or throws) avoids returning while
	 * an agent orphaned by a sandbox abort is still being torn down (DESIGN.md §13.3 "Awaiting"). */
	settled(): Promise<void>;
}

export function createWorkflowAgentHost(deps: WorkflowAgentHostDeps): WorkflowAgentHost {
	let cachedAgents: Map<string, AgentConfig> | undefined;
	let budgetNoticeLogged = false;
	const agentTypeCounts = new Map<string, number>();
	const usedLabels = new Set<string>();
	const inFlight = new Set<Promise<unknown>>();

	function agentsByName(): Map<string, AgentConfig> {
		if (!cachedAgents) {
			cachedAgents = new Map(
				discoverAgents(deps.ctx.cwd, "both", deps.ctx.isProjectTrusted()).map((agent) => [agent.name, agent]),
			);
		}
		return cachedAgents;
	}

	/** Dedupe within this run: an explicit label keeps its text until it collides, appending `#2`,
	 * `#3`. A default label never collides by construction: its per-type counter advances past any
	 * slot already in `usedLabels` (including one taken by an explicit label of the same text). */
	function nextLabel(explicit: string | undefined, agentTypeDisplay: string): string {
		const text = explicit?.trim();
		if (!text) {
			let n = agentTypeCounts.get(agentTypeDisplay) ?? 0;
			let candidate: string;
			do {
				n++;
				candidate = `${agentTypeDisplay}#${n}`;
			} while (usedLabels.has(candidate));
			agentTypeCounts.set(agentTypeDisplay, n);
			usedLabels.add(candidate);
			return candidate;
		}
		if (!usedLabels.has(text)) {
			usedLabels.add(text);
			return text;
		}
		let n = 2;
		while (usedLabels.has(`${text}#${n}`)) n++;
		const deduped = `${text}#${n}`;
		usedLabels.add(deduped);
		return deduped;
	}

	async function runAgent(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentReply> {
		if (deps.run.budget.exhausted) {
			if (!budgetNoticeLogged) {
				budgetNoticeLogged = true;
				deps.run.appendLog("budget exhausted; agent(...) returns null", "warning");
			}
			return { kind: "null", reason: "budget" };
		}

		let agentTypeDisplay: string;
		let config: AgentConfig;
		if (request.agentType) {
			const found = agentsByName().get(request.agentType);
			if (!found) {
				const available = [...agentsByName().keys()].sort().join(", ");
				return {
					kind: "error",
					message: `unknown agentType "${request.agentType}"; available: ${available || "(none)"}`,
				};
			}
			agentTypeDisplay = request.agentType;
			config = found;
		} else {
			agentTypeDisplay = "agent";
			config = DEFAULT_WORKFLOW_AGENT_CONFIG;
		}

		// Side-effect-free lookup for the model step: declaring a phase permanently (and may log a
		// one-time warning) must wait until every other validation has passed, so a rejected agent()
		// call (bad agentType/model) never mutates the run as a side effect (DESIGN.md §14.3).
		const declaredIndex =
			request.phase === undefined
				? deps.run.currentPhase
				: deps.run.phases.findIndex((phase) => phase.title === request.phase);
		const phaseModel =
			declaredIndex !== undefined && declaredIndex >= 0 ? deps.meta.phases[declaredIndex]?.model : undefined;

		let choice: ChildModelChoice;
		try {
			choice = resolveChildModel({
				override: request.model,
				effort: request.effort,
				phaseModel,
				agentModel: config.model,
				parentModel: deps.ctx.model,
				parentThinking: deps.ctx.thinkingLevel,
				available: deps.ctx.modelRegistry.getAvailable(),
			});
		} catch (error) {
			if (error instanceof ModelSelectionError) return { kind: "error", message: error.message };
			throw error;
		}

		const schemaPrep = request.schema ? prepareResultSchema(request.schema) : undefined;
		const label = nextLabel(request.label, agentTypeDisplay);
		const phaseIndex = deps.run.resolvePhase(request.phase);

		const live = deps.run.addAgent({
			label,
			agentType: agentTypeDisplay,
			task: request.prompt,
			phase: phaseIndex,
			model: choice.info,
		});

		const combined = AbortSignal.any([signal, live.signal]);
		signal.addEventListener("abort", () => live.cancel("run"), { once: true });

		const depth = currentPolyphaseDepth();
		const maxDepth = deps.session.settings().maxDepth;

		const resultPromise = runSingleTask(deps.ctx.cwd, config, request.prompt, {
			signal: combined,
			worktree: request.isolation === "worktree",
			runner: deps.runner,
			resultMailbox: deps.mailbox,
			limiter: deps.session.limiter,
			run: live.createRunContext({
				model: choice.modelArg,
				thinking: choice.thinking,
				modelInfo: choice.info,
				fallbackToChildDefaultModel: choice.info.source === "inherited",
				excludeTools: depth + 1 >= maxDepth ? ["subagent"] : [],
				schema: schemaPrep?.toolSchema,
				extraTools: schemaPrep ? [POLYPHASE_RESULT_TOOL_NAME] : undefined,
				extraSystemPrompt: schemaPrep ? STRUCTURED_OUTPUT_INSTRUCTION : undefined,
			}),
		});
		inFlight.add(resultPromise);
		let result: RunResult;
		try {
			result = await resultPromise;
		} finally {
			inFlight.delete(resultPromise);
		}

		if (result.merge && !result.merge.success) {
			deps.run.appendLog(
				`${label} merge-back failed; work is on branch ${result.merge.branch ?? "unknown"}`,
				"warning",
			);
		}

		if (result.cancelled) {
			deps.run.appendLog(`${label} skipped (cancelled by ${cancelReasonText(live.cancelReason)})`, "info");
			return { kind: "null", reason: "cancelled" };
		}
		if (result.exitCode !== 0) {
			const detail = failureDetail(result.stderr, live.state.errorMessage, result.exitCode);
			deps.run.appendLog(`${label} failed: ${detail}`, "warning");
			return { kind: "null", reason: "failed" };
		}
		if (request.schema && !result.structured) {
			deps.run.appendLog(`${label} did not return structured output matching the schema`, "warning");
			return { kind: "null", reason: "no-structured-output" };
		}

		const value =
			request.schema && schemaPrep && result.structured ? schemaPrep.unwrap(result.structured.value) : result.output;
		return { kind: "value", value };
	}

	return {
		runAgent,
		onPhase: (title) => deps.run.enterPhase(title),
		onLog: (text, level) => deps.run.appendLog(text, level),
		spentTokens: () => deps.run.spentTokens(),
		settled: () => Promise.allSettled([...inFlight]).then(() => undefined),
	};
}
