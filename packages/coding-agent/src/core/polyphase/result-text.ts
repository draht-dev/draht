import type { JsonValue } from "@draht/ai";
import { billableTokens, extractStatusLine } from "./child-events.ts";
import type { AgentView, RunView, SubagentMode } from "./types.ts";

/**
 * Text handed back to the parent model for subagent and workflow tool calls (D3). Bounded by
 * character budgets rather than the byte budgets `details.ts` uses, since this text is tokenized
 * context, not a persisted JSON blob.
 */

export interface HeadTailResult {
	text: string;
	omittedChars: number;
}

/**
 * Keeps the head and tail of `text`, snapped to line boundaries, with a marker in between.
 * `keepStatusLine` (default true) re-appends the source's last `STATUS: ...` line when the
 * result does not already contain it, so callers never lose it to truncation.
 */
export function capHeadTail(
	text: string,
	maxChars: number,
	options: { headRatio?: number; keepStatusLine?: boolean } = {},
): HeadTailResult {
	if (text.length <= maxChars) return { text, omittedChars: 0 };

	const headRatio = options.headRatio ?? 0.4;
	const keepStatusLine = options.keepStatusLine ?? true;

	const headBudget = Math.max(0, Math.floor(maxChars * headRatio));
	const tailBudget = Math.max(0, maxChars - headBudget);

	const headEnd = boundedSnap(text, headBudget, "backward", headBudget);
	const tailStart = Math.max(headEnd, boundedSnap(text, text.length - tailBudget, "forward", tailBudget));

	const head = text.slice(0, headEnd);
	const tail = text.slice(tailStart);
	const omittedChars = tailStart - headEnd;

	let result = `${head}\n[... ${omittedChars} characters omitted ...]\n${tail}`;
	if (keepStatusLine) {
		const statusLine = extractStatusLine(text);
		if (statusLine && !result.includes(statusLine)) result += `\n${statusLine}`;
	}

	return { text: result, omittedChars };
}

function snapToLineStart(text: string, pos: number, direction: "backward" | "forward"): number {
	if (direction === "backward") {
		const idx = text.lastIndexOf("\n", Math.max(0, pos));
		return idx === -1 ? Math.max(0, pos) : idx + 1;
	}
	const idx = text.indexOf("\n", Math.max(0, pos));
	return idx === -1 ? Math.min(text.length, Math.max(0, pos)) : idx + 1;
}

/**
 * Snaps `pos` to the nearest line boundary, but only when that stays within 20% of `budget` of the
 * raw position. A long paragraph with no nearby newline (or a text that ends right at a trailing
 * newline) would otherwise snap arbitrarily far, discarding almost the whole head or tail even
 * though the caller asked for `budget` characters.
 */
function boundedSnap(text: string, pos: number, direction: "backward" | "forward", budget: number): number {
	const raw = Math.max(0, Math.min(text.length, pos));
	const snapped = snapToLineStart(text, pos, direction);
	return Math.abs(snapped - raw) <= budget * 0.2 ? snapped : raw;
}

/** `clamp(floor(totalChars / agentCount), 2000, 16000)`. */
export function perAgentResultChars(totalChars: number, agentCount: number): number {
	const n = Math.max(1, agentCount);
	return Math.min(16_000, Math.max(2_000, Math.floor(totalChars / n)));
}

function agentOutput(agent: AgentView): string {
	return agent.result?.output ?? agent.state.finalText ?? "";
}

function modelLabel(agent: AgentView): string {
	const model = agent.state.model;
	if (model.provider && model.id) return `${model.provider}/${model.id}`;
	return model.requested ?? "default model";
}

function formatElapsedMs(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatElapsedAgent(agent: AgentView, now: number): string {
	const start = agent.state.startedAt ?? agent.createdAt;
	const end = agent.state.endedAt ?? now;
	return formatElapsedMs(end - start);
}

function formatElapsedRun(run: RunView, now: number): string {
	return formatElapsedMs((run.endedAt ?? now) - run.startedAt);
}

function tailChars(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function totalBillableTokens(run: RunView): number {
	return run.agents.reduce((sum, agent) => sum + billableTokens(agent.state.usage), 0);
}

function totalCost(run: RunView): number {
	return run.agents.reduce((sum, agent) => sum + (agent.state.usage?.cost.total ?? 0), 0);
}

function formatTokensPlain(n: number): string {
	return n.toLocaleString("en-US");
}

function formatCostPlain(n: number): string {
	return `$${n.toFixed(2)}`;
}

function collectBlockedSamples(run: RunView, limit = 3): string[] {
	const samples: string[] = [];
	for (const agent of run.agents) {
		for (const blocked of agent.state.blocked) {
			samples.push(truncateLine(`${blocked.toolName}: ${blocked.summary}`, 200));
			if (samples.length >= limit) return samples;
		}
	}
	return samples;
}

function totalBlockedToolCalls(run: RunView): number {
	return run.agents.reduce((sum, agent) => sum + agent.state.blockedCount, 0);
}

/** `undefined` when `count` is zero. */
export function formatBlockedNote(count: number, samples: readonly string[]): string | undefined {
	if (count <= 0) return undefined;
	const suffix = samples.length > 0 ? `: ${samples.join(", ")}` : "";
	return `${count} tool call(s) inside subagents were blocked because subagents cannot ask for approval${suffix}. Allow them with rules in permissions.yml, /permissions auto, or /yolo, then retry.`;
}

function appendBlockedNote(parts: string[], run: RunView): void {
	const count = totalBlockedToolCalls(run);
	const note = formatBlockedNote(count, collectBlockedSamples(run));
	if (note) parts.push(note);
}

function formatSingleAgent(agent: AgentView | undefined, now: number): string {
	if (!agent) return "";
	if (agent.status === "cancelled") {
		const base = `CANCELLED by ${agent.cancelReason ?? "user"} after ${formatElapsedAgent(agent, now)}`;
		const output = agentOutput(agent);
		return output.length > 0 ? `${base}\n${capHeadTail(output, 8000).text}` : base;
	}
	if (agent.status === "failed") {
		const exitCode = agent.result?.exitCode ?? 1;
		const stderr = agent.result?.stderr ?? "";
		return `FAILED (exit ${exitCode}, model ${modelLabel(agent)})\n${capHeadTail(agentOutput(agent), 8000).text}\nstderr:\n${tailChars(stderr, 2000)}`;
	}
	return capHeadTail(agentOutput(agent), 50_000).text;
}

function parallelStatusLabel(agent: AgentView): "ok" | "FAILED" | "CANCELLED" | "merge-failed" {
	if (agent.result?.merge && !agent.result.merge.success) return "merge-failed";
	if (agent.status === "cancelled") return "CANCELLED";
	if (agent.status === "failed") return "FAILED";
	return "ok";
}

function isMergeFailed(agent: AgentView): boolean {
	return agent.result?.merge !== undefined && !agent.result.merge.success;
}

function formatParallel(run: RunView, resultChars: number, now: number): string {
	const total = run.agents.length;
	// A merge-failed agent's own block reads "merge-failed", not "ok", so it must not also count
	// toward "succeeded" here; it is folded into the failed count instead.
	const succeeded = run.agents.filter((a) => a.status === "done" && !isMergeFailed(a)).length;
	const failed = run.agents.filter((a) => a.status === "failed" || (a.status === "done" && isMergeFailed(a))).length;
	const cancelled = run.agents.filter((a) => a.status === "cancelled").length;

	const headerParts = [`${succeeded}/${total} succeeded`];
	if (failed > 0) headerParts.push(`${failed} failed`);
	if (cancelled > 0) headerParts.push(`${cancelled} cancelled`);
	const header = `Parallel: ${headerParts.join(", ")}`;

	const perAgentChars = perAgentResultChars(resultChars, total);
	const blocks = run.agents.map((agent, i) => {
		const label = parallelStatusLabel(agent);
		const title = `=== [${i + 1}/${total}] ${agent.label} (${agent.agentType}) — ${label} · ${modelLabel(agent)} · ${formatElapsedAgent(agent, now)} ===`;
		const lines = [title, capHeadTail(agentOutput(agent), perAgentChars).text];
		if (label === "FAILED" || label === "merge-failed") {
			const stderr = agent.result?.stderr ?? "";
			if (stderr.length > 0) lines.push(`stderr:\n${tailChars(stderr, 1500)}`);
		}
		return lines.join("\n");
	});

	return [header, ...blocks].join("\n\n");
}

function chainStatusWord(agent: AgentView): string {
	if (agent.status === "cancelled") return "CANCELLED";
	if (agent.status === "failed") return "FAILED";
	if (agent.status === "done") return "ok";
	// "pending"/"skipped" (never started because the chain already stopped), or a status this
	// text is never expected to see (e.g. "running"): show it verbatim rather than mislabel it "ok".
	return agent.status;
}

/** Steps the chain never started (pending/skipped after a break) have no elapsed time to show. */
function formatChainStepLine(agent: AgentView, now: number): string {
	const step = agent.step ?? agent.index + 1;
	const word = chainStatusWord(agent);
	if (agent.status === "pending" || agent.status === "skipped") return `${step}. ${agent.label} ${word}`;
	return `${step}. ${agent.label} ${word} · ${formatElapsedAgent(agent, now)}`;
}

function formatChain(run: RunView, now: number): string {
	// Every step is rendered, including pending/skipped ones after a break, so the parent model
	// sees where the chain stopped (D3 owner decision).
	const steps = run.agents;
	const lines = steps.map((a) => formatChainStepLine(a, now));
	const stepsText = lines.join("\n");

	const brokenStep = steps.find((a) => a.status === "failed" || a.status === "cancelled");
	if (brokenStep) {
		const verb = brokenStep.status === "cancelled" ? "cancelled" : "failed";
		const parts = [
			stepsText,
			`Chain ${verb} at step ${brokenStep.step ?? brokenStep.index + 1} (${brokenStep.label})`,
			capHeadTail(agentOutput(brokenStep), 8000).text,
		];
		const stderr = brokenStep.result?.stderr ?? "";
		if (stderr.length > 0) parts.push(`stderr:\n${tailChars(stderr, 2000)}`);
		return parts.join("\n");
	}

	const last = steps[steps.length - 1];
	const lastOutput = last ? capHeadTail(agentOutput(last), 50_000).text : "";
	return [stepsText, lastOutput].join("\n\n");
}

export function formatSubagentResultText(
	run: RunView,
	options: { mode: SubagentMode; resultChars: number; notices?: readonly string[] },
): string {
	const now = Date.now();
	const body =
		options.mode === "parallel"
			? formatParallel(run, options.resultChars, now)
			: options.mode === "chain"
				? formatChain(run, now)
				: formatSingleAgent(run.agents[0], now);

	const parts = [body];
	if (options.notices && options.notices.length > 0) parts.push(...options.notices);
	appendBlockedNote(parts, run);
	return parts.join("\n\n");
}

export interface WorkflowOutcomeSummary {
	ok: boolean;
	value?: JsonValue;
	errorKind?: string;
	errorMessage?: string;
	errorLine?: number;
	consoleOutput: readonly string[];
}

function formatWorkflowHeader(run: RunView, now: number): string {
	const name = run.workflow?.name ?? run.title;
	const total = run.agents.length;
	const done = run.agents.filter((a) => a.status === "done").length;
	const failed = run.agents.filter((a) => a.status === "failed").length;
	const cancelled = run.agents.filter((a) => a.status === "cancelled").length;
	return `Workflow ${name}: ${run.status} · ${total} agents (${done} ok, ${failed} failed, ${cancelled} cancelled) · ${formatElapsedRun(run, now)} · ${formatTokensPlain(totalBillableTokens(run))} tokens · ${formatCostPlain(totalCost(run))}`;
}

function formatWorkflowPhases(run: RunView): string {
	const lines = run.phases.map((phase, i) => {
		const agents = run.agents.filter((a) => a.phase === i);
		const done = agents.filter((a) => a.status === "done").length;
		const failed = agents.filter((a) => a.status === "failed").length;
		const cancelled = agents.filter((a) => a.status === "cancelled").length;
		const tally = [`${done}/${agents.length} ok`];
		if (failed > 0) tally.push(`${failed} failed`);
		if (cancelled > 0) tally.push(`${cancelled} cancelled`);
		return `${i + 1}. ${phase.title} — ${tally.join(", ")}`;
	});
	return ["Phases:", ...lines].join("\n");
}

function formatWorkflowResult(outcome: WorkflowOutcomeSummary): string {
	const value = outcome.value;
	const text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return ["Result:", capHeadTail(text, 32_000).text].join("\n");
}

function formatWorkflowLog(run: RunView): string {
	const lines = run.log.slice(-30).map((line) => truncateLine(line.text, 200));
	return ["Log:", ...lines].join("\n");
}

function formatWorkflowConsole(outcome: WorkflowOutcomeSummary): string {
	return ["Console:", capHeadTail(outcome.consoleOutput.join("\n"), 8000).text].join("\n");
}

function firstNonBlankLine(text: string): string {
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) return line;
	}
	return "";
}

function formatWorkflowAgents(run: RunView): string {
	const lines = run.agents.slice(0, 100).map((agent) => {
		const output = agentOutput(agent);
		const info =
			extractStatusLine(output) ?? firstNonBlankLine(agent.result?.stderr || agent.state.errorMessage || "");
		return truncateLine(`${agent.label} ${agent.status} ${modelLabel(agent)} ${info}`.trimEnd(), 200);
	});
	return ["Agents:", ...lines].join("\n");
}

function formatBudgetNotice(run: RunView): string {
	const total = run.budget.totalTokens ?? 0;
	return `Budget exhausted: ${formatTokensPlain(run.budget.spentTokens)} / ${formatTokensPlain(total)} tokens; remaining agents were skipped.`;
}

function formatScriptError(outcome: WorkflowOutcomeSummary): string | undefined {
	if (outcome.ok || !outcome.errorMessage) return undefined;
	const prefix =
		outcome.errorKind && outcome.errorKind !== "script" ? `Workflow ${outcome.errorKind}` : "Script error";
	return outcome.errorLine !== undefined
		? `${prefix} at line ${outcome.errorLine}: ${outcome.errorMessage}`
		: `${prefix}: ${outcome.errorMessage}`;
}

export function formatWorkflowResultText(run: RunView, outcome: WorkflowOutcomeSummary): string {
	const now = Date.now();
	const sections = [
		formatWorkflowHeader(run, now),
		formatWorkflowPhases(run),
		formatWorkflowResult(outcome),
		formatWorkflowLog(run),
	];
	if (outcome.consoleOutput.length > 0) sections.push(formatWorkflowConsole(outcome));
	sections.push(formatWorkflowAgents(run));

	const trailer: string[] = [];
	if (run.budget.exhausted) trailer.push(formatBudgetNotice(run));
	const scriptError = formatScriptError(outcome);
	if (scriptError) trailer.push(scriptError);
	appendBlockedNote(trailer, run);
	if (trailer.length > 0) sections.push(trailer.join("\n"));

	return sections.join("\n\n");
}

/** ≤ 20 lines, each ≤ 120 chars. */
export function formatPartialStatusText(run: RunView, now: number = Date.now()): string {
	const lines: string[] = [];
	const done = run.agents.filter((a) => a.status === "done").length;
	lines.push(truncateLine(`${run.title}: ${done}/${run.agents.length} done · ${formatElapsedRun(run, now)}`, 120));
	for (const agent of run.agents) {
		if (lines.length >= 20) break;
		const activity = agent.status === "running" ? agent.state.nowLine : agent.status;
		lines.push(truncateLine(`${agent.index + 1}. ${agent.label} ${activity}`, 120));
	}
	return lines.slice(0, 20).join("\n");
}

function truncateLine(text: string, maxChars: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length <= maxChars ? singleLine : `${singleLine.slice(0, maxChars - 1)}…`;
}
