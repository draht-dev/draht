import type { Usage } from "@draht/ai";
import type { SessionEntry } from "../session-manager.ts";
import { combineUsage } from "../usage-totals.ts";
import { billableTokens, extractStatusLine } from "./child-events.ts";
import { capHeadTail } from "./result-text.ts";
import type {
	AgentDetails,
	AgentStatus,
	AgentView,
	PhaseDetails,
	PhaseInfo,
	PolyphaseDetails,
	RunView,
} from "./types.ts";
import { FINAL_DETAILS_MAX_BYTES, PARTIAL_DETAILS_MAX_BYTES, SUBAGENT_TOOL_NAME, WORKFLOW_TOOL_NAME } from "./types.ts";

/**
 * Builds the bounded, JSON-compatible `PolyphaseDetails` persisted as a tool result (D2), and
 * reads them back out of the session log for the inspector's archived-run view.
 */

/** Reserve for capHeadTail's "[... N characters omitted ...]" marker, so the final `output` text
 * still fits `outputMax` even though the marker is appended after the head/tail split. */
const OUTPUT_MARKER_RESERVE = 48;

interface LevelPlan {
	level: 0 | 1 | 2 | 3 | 4;
	outputMax: number;
	outputHeadRatio: number;
	taskMax: number;
	errorMax: number;
	nowMax: number;
	logLines: number;
	logLineMax: number;
	resultPreviewMax: number;
	includeTools: boolean;
	/** `undefined` at L4, where `phase.detail` is dropped outright. */
	phaseDetailMax?: number;
	/** Caps for fields that are not per-agent (§9.2 finding: these were unbounded at every level). */
	titleMax: number;
	workflowDescMax: number;
	workflowArgsMax: number;
	workflowPathMax: number;
	maxPhases: number;
	phaseTitleMax: number;
	phaseModelMax: number;
	runErrorMax: number;
	agentLabelMax: number;
	agentTypeMax: number;
	agentModelMax: number;
}

const LEVEL_PLANS: readonly LevelPlan[] = [
	{
		level: 0,
		outputMax: 1200,
		outputHeadRatio: 1 / 3,
		taskMax: 200,
		errorMax: 400,
		nowMax: 160,
		logLines: 20,
		logLineMax: 200,
		resultPreviewMax: 1200,
		includeTools: true,
		phaseDetailMax: 200,
		titleMax: 200,
		workflowDescMax: 2000,
		workflowArgsMax: 2000,
		workflowPathMax: 300,
		maxPhases: 100,
		phaseTitleMax: 120,
		phaseModelMax: 60,
		runErrorMax: 2000,
		agentLabelMax: 200,
		agentTypeMax: 100,
		agentModelMax: 200,
	},
	{
		level: 1,
		outputMax: 300,
		outputHeadRatio: 1 / 3,
		taskMax: 200,
		errorMax: 400,
		nowMax: 160,
		logLines: 5,
		logLineMax: 200,
		resultPreviewMax: 300,
		includeTools: false,
		phaseDetailMax: 160,
		titleMax: 200,
		workflowDescMax: 1000,
		workflowArgsMax: 1000,
		workflowPathMax: 300,
		maxPhases: 60,
		phaseTitleMax: 100,
		phaseModelMax: 50,
		runErrorMax: 1000,
		agentLabelMax: 200,
		agentTypeMax: 100,
		agentModelMax: 150,
	},
	{
		level: 2,
		outputMax: 0,
		outputHeadRatio: 1 / 3,
		taskMax: 80,
		errorMax: 160,
		nowMax: 0,
		logLines: 0,
		logLineMax: 200,
		resultPreviewMax: 120,
		includeTools: false,
		phaseDetailMax: 120,
		titleMax: 160,
		workflowDescMax: 400,
		workflowArgsMax: 400,
		workflowPathMax: 200,
		maxPhases: 40,
		phaseTitleMax: 80,
		phaseModelMax: 40,
		runErrorMax: 400,
		agentLabelMax: 160,
		agentTypeMax: 80,
		agentModelMax: 100,
	},
	{
		level: 3,
		outputMax: 0,
		outputHeadRatio: 1 / 3,
		taskMax: 80,
		errorMax: 160,
		nowMax: 0,
		logLines: 0,
		logLineMax: 200,
		resultPreviewMax: 120,
		includeTools: false,
		phaseDetailMax: 80,
		titleMax: 120,
		workflowDescMax: 200,
		workflowArgsMax: 200,
		workflowPathMax: 160,
		maxPhases: 30,
		phaseTitleMax: 60,
		phaseModelMax: 30,
		runErrorMax: 200,
		agentLabelMax: 120,
		agentTypeMax: 60,
		agentModelMax: 80,
	},
	{
		level: 4,
		outputMax: 0,
		outputHeadRatio: 1 / 3,
		taskMax: 40,
		errorMax: 160,
		nowMax: 0,
		logLines: 0,
		logLineMax: 200,
		resultPreviewMax: 120,
		includeTools: false,
		titleMax: 80,
		workflowDescMax: 80,
		workflowArgsMax: 80,
		workflowPathMax: 80,
		maxPhases: 20,
		phaseTitleMax: 40,
		phaseModelMax: 20,
		runErrorMax: 120,
		agentLabelMax: 40,
		agentTypeMax: 40,
		agentModelMax: 40,
	},
] as const;

function truncateChars(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function firstLine(text: string): string {
	const idx = text.indexOf("\n");
	return idx === -1 ? text : text.slice(0, idx);
}

function byteLength(details: PolyphaseDetails): number {
	return Buffer.byteLength(JSON.stringify(details), "utf8");
}

const IMPORTANT_STATUSES: readonly AgentStatus[] = ["failed", "running", "queued", "starting"];

/** Every important-status agent, plus the first/last 20 by index, capped at `cap` total. */
function selectAgentsBounded(allAgents: readonly AgentView[], cap: number): AgentView[] {
	const important = allAgents.filter((a) => IMPORTANT_STATUSES.includes(a.status));
	const firstN = allAgents.slice(0, 20);
	const lastN = allAgents.slice(Math.max(0, allAgents.length - 20));

	const seen = new Set<number>();
	const selected: AgentView[] = [];
	for (const agent of [...important, ...firstN, ...lastN]) {
		if (seen.has(agent.index)) continue;
		seen.add(agent.index);
		selected.push(agent);
		if (selected.length >= cap) break;
	}
	return selected.sort((a, b) => a.index - b.index);
}

/** Failed agents first, then running, then the rest in index order, capped at `cap`. */
function selectAgentsMinimal(allAgents: readonly AgentView[], cap: number): AgentView[] {
	const failed = allAgents.filter((a) => a.status === "failed");
	const running = allAgents.filter((a) => a.status === "running");
	const rest = allAgents.filter((a) => a.status !== "failed" && a.status !== "running");
	return [...failed, ...running, ...rest].slice(0, cap).sort((a, b) => a.index - b.index);
}

/** Same priority order as {@link selectAgentsMinimal} (failed, then running, then the rest),
 * for `forceFit`, which must drop already-selected `AgentDetails` in that same order. */
function rankAgentDetailsByPriority(agents: readonly AgentDetails[]): AgentDetails[] {
	const failed = agents.filter((a) => a.status === "failed");
	const running = agents.filter((a) => a.status === "running");
	const rest = agents.filter((a) => a.status !== "failed" && a.status !== "running");
	return [...failed, ...running, ...rest];
}

function selectAgents(
	allAgents: readonly AgentView[],
	plan: LevelPlan,
): { agents: readonly AgentView[]; agentsOmitted?: { count: number; byStatus: Partial<Record<AgentStatus, number>> } } {
	if (plan.level < 3) return { agents: allAgents };

	const selected = plan.level === 4 ? selectAgentsMinimal(allAgents, 20) : selectAgentsBounded(allAgents, 60);
	if (selected.length === allAgents.length) return { agents: selected };

	const selectedIndices = new Set(selected.map((a) => a.index));
	const omitted = allAgents.filter((a) => !selectedIndices.has(a.index));
	const byStatus: Partial<Record<AgentStatus, number>> = {};
	for (const agent of omitted) byStatus[agent.status] = (byStatus[agent.status] ?? 0) + 1;

	return { agents: selected, agentsOmitted: { count: omitted.length, byStatus } };
}

function buildTotals(allAgents: readonly AgentView[]): PolyphaseDetails["totals"] {
	const byStatus: Partial<Record<AgentStatus, number>> = {};
	let tokens = 0;
	let cost = 0;
	let blockedToolCalls = 0;
	for (const agent of allAgents) {
		byStatus[agent.status] = (byStatus[agent.status] ?? 0) + 1;
		tokens += billableTokens(agent.state.usage) + billableTokens(agent.state.liveUsage);
		cost += (agent.state.usage?.cost.total ?? 0) + (agent.state.liveUsage?.cost.total ?? 0);
		blockedToolCalls += agent.state.blockedCount;
	}
	return { agents: allAgents.length, tokens, cost, byStatus, blockedToolCalls };
}

function modelText(agent: AgentView): string | undefined {
	const model = agent.state.model;
	if (model.provider && model.id) return `${model.provider}/${model.id}`;
	return model.requested;
}

/** `extractStatusLine` scans the whole output with a global regex; computing it once per agent
 * (instead of once per agent per degradation level) keeps buildDetails O(agents), not O(agents * levels). */
function computeStatusLines(agents: readonly AgentView[]): Map<number, string | undefined> {
	const lines = new Map<number, string | undefined>();
	for (const agent of agents) {
		const outputText = agent.result?.output ?? agent.state.finalText;
		lines.set(agent.index, outputText ? extractStatusLine(outputText) : undefined);
	}
	return lines;
}

function buildAgentDetails(
	agent: AgentView,
	plan: LevelPlan,
	ctx: { final: boolean },
	statusLines: ReadonlyMap<number, string | undefined>,
): AgentDetails {
	const details: AgentDetails = {
		i: agent.index,
		label: truncateChars(agent.label, plan.agentLabelMax),
		agent: truncateChars(agent.agentType, plan.agentTypeMax),
		status: agent.status,
		task: truncateChars(agent.task, plan.taskMax),
	};

	const model = modelText(agent);
	if (model !== undefined) details.model = truncateChars(model, plan.agentModelMax);

	// L4 keeps only i, label, agent, status, model, task (§9.2); everything below is dropped.
	if (plan.level === 4) return details;

	if (agent.phase !== undefined) details.phase = agent.phase;
	if (agent.step !== undefined) details.step = agent.step;
	if (agent.cancelReason !== undefined) details.cancelReason = agent.cancelReason;
	if (agent.state.model.thinkingLevel !== undefined) details.thinking = agent.state.model.thinkingLevel;

	details.modelSource = agent.state.model.source;
	details.modelConfirmed = agent.state.model.confirmed;

	if (agent.state.startedAt !== undefined) details.startedAt = agent.state.startedAt;
	if (agent.state.endedAt !== undefined) details.endedAt = agent.state.endedAt;
	if (agent.state.turns > 0) details.turns = agent.state.turns;
	if (agent.state.toolCalls > 0) details.toolCalls = agent.state.toolCalls;
	if (plan.includeTools && Object.keys(agent.state.toolCounts).length > 0) {
		details.tools = { ...agent.state.toolCounts };
	}

	const tokens = billableTokens(agent.state.usage) + billableTokens(agent.state.liveUsage);
	if (tokens > 0) details.tokens = tokens;
	const cost = (agent.state.usage?.cost.total ?? 0) + (agent.state.liveUsage?.cost.total ?? 0);
	if (cost > 0) details.cost = cost;

	if (agent.state.blockedCount > 0) {
		details.blocked = agent.state.blockedCount;
		const first = agent.state.blocked[0];
		if (first) details.blockedSample = `${first.toolName}: ${first.summary}`;
	}

	const outputText = agent.result?.output ?? agent.state.finalText;
	if (outputText) {
		const statusLine = statusLines.get(agent.index);
		if (statusLine !== undefined) details.statusLine = truncateChars(statusLine, 120);
		if (plan.outputMax > 0) {
			const budget = Math.max(1, plan.outputMax - OUTPUT_MARKER_RESERVE);
			const capped = capHeadTail(outputText, budget, { headRatio: plan.outputHeadRatio, keepStatusLine: false });
			details.output = truncateChars(capped.text, plan.outputMax);
		}
	}

	if (!ctx.final && plan.nowMax > 0 && agent.state.nowLine) {
		details.now = truncateChars(agent.state.nowLine, plan.nowMax);
	}

	const errorSource = agent.result?.stderr || agent.state.errorMessage;
	if (errorSource) details.error = truncateChars(firstLine(errorSource), plan.errorMax);

	if (agent.result?.merge !== undefined) details.merge = agent.result.merge.success ? "ok" : "failed";

	return details;
}

function buildPhaseDetails(phase: PhaseInfo, plan: LevelPlan): PhaseDetails {
	const details: PhaseDetails = { title: truncateChars(phase.title, plan.phaseTitleMax) };
	if (plan.phaseDetailMax !== undefined && phase.detail !== undefined) {
		details.detail = truncateChars(phase.detail, plan.phaseDetailMax);
	}
	if (phase.model !== undefined) details.model = truncateChars(phase.model, plan.phaseModelMax);
	if (phase.dynamic) details.dynamic = phase.dynamic;
	return details;
}

function buildLog(run: RunView, plan: LevelPlan): { lines?: string[]; omitted: number } {
	if (plan.logLines <= 0) return { omitted: run.logDropped + run.log.length };
	const kept = run.log.slice(-plan.logLines);
	return {
		lines: kept.map((line) => truncateChars(line.text, plan.logLineMax)),
		omitted: run.logDropped + (run.log.length - kept.length),
	};
}

function buildAtLevel(
	run: RunView,
	plan: LevelPlan,
	ctx: { final: boolean },
	statusLines: ReadonlyMap<number, string | undefined>,
): PolyphaseDetails {
	const { agents, agentsOmitted } = selectAgents(run.agents, plan);
	const log = buildLog(run, plan);

	const details: PolyphaseDetails = {
		v: 1,
		runId: run.id,
		kind: run.kind,
		origin: run.origin,
		title: truncateChars(run.title, plan.titleMax),
		status: run.status,
		startedAt: run.startedAt,
		agents: agents.map((agent) => buildAgentDetails(agent, plan, ctx, statusLines)),
		totals: buildTotals(run.agents),
		degraded: plan.level,
	};

	if (run.mode !== undefined) details.mode = run.mode;
	if (run.endedAt !== undefined) details.endedAt = run.endedAt;
	if (run.workflow !== undefined) {
		details.workflow = {
			name: run.workflow.name,
			description: truncateChars(run.workflow.description, plan.workflowDescMax),
			source: run.workflow.source,
			...(run.workflow.path !== undefined ? { path: truncateChars(run.workflow.path, plan.workflowPathMax) } : {}),
			args: truncateChars(run.workflow.args, plan.workflowArgsMax),
		};
	}
	if (run.phases.length > 0) {
		details.phases = run.phases.slice(0, plan.maxPhases).map((phase) => buildPhaseDetails(phase, plan));
	}
	if (run.currentPhase !== undefined) details.currentPhase = run.currentPhase;
	if (agentsOmitted !== undefined) details.agentsOmitted = agentsOmitted;
	if (log.lines !== undefined) details.log = log.lines;
	if (log.omitted > 0) details.logOmitted = log.omitted;
	if (run.budget.totalTokens !== null) {
		details.budget = {
			totalTokens: run.budget.totalTokens,
			spentTokens: run.budget.spentTokens,
			exhausted: run.budget.exhausted,
		};
	}
	if (run.resultPreview !== undefined) {
		details.resultPreview = truncateChars(
			capHeadTail(run.resultPreview, plan.resultPreviewMax).text,
			plan.resultPreviewMax,
		);
	}
	if (run.error !== undefined) details.error = truncateChars(run.error, plan.runErrorMax);

	return details;
}

/**
 * Last-resort fit for L4 results that still exceed `maxBytes` (e.g. many agents each carrying a
 * close-to-the-cap label/agent/model string). Strips optional fields, then drops agents in
 * reverse priority order (the rest, then running, then failed last; §9.2 finding: dropping by
 * index order instead could discard the one failed agent a user most needs to see), until the
 * result fits. Always terminates: with zero agents and no optional fields, the remaining scalar
 * fields and `totals` are far below either byte budget.
 */
function forceFit(details: PolyphaseDetails, maxBytes: number): PolyphaseDetails {
	let d = details;
	if (byteLength(d) <= maxBytes) return d;

	if (d.workflow && (d.workflow.description.length > 0 || (d.workflow.args?.length ?? 0) > 0)) {
		d = { ...d, workflow: { ...d.workflow, description: "", args: "" } };
		if (byteLength(d) <= maxBytes) return d;
	}
	if (d.phases !== undefined) {
		d = { ...d, phases: undefined };
		if (byteLength(d) <= maxBytes) return d;
	}
	if (d.error !== undefined) {
		d = { ...d, error: undefined };
		if (byteLength(d) <= maxBytes) return d;
	}

	const originalAgents = d.agents;
	const priorOmitted = d.agentsOmitted;
	// Rank by the same priority selectAgentsMinimal uses (failed, then running, then the rest),
	// so dropping from the low-priority end here never sacrifices a failed or running agent
	// before every less important one is already gone.
	const ranked = rankAgentDetailsByPriority(originalAgents);
	for (let cap = originalAgents.length - 1; cap >= 0; cap--) {
		const keptIds = new Set(ranked.slice(0, cap).map((a) => a.i));
		const kept = originalAgents.filter((a) => keptIds.has(a.i));
		const dropped = originalAgents.filter((a) => !keptIds.has(a.i));
		const byStatus: Partial<Record<AgentStatus, number>> = { ...priorOmitted?.byStatus };
		for (const agent of dropped) byStatus[agent.status] = (byStatus[agent.status] ?? 0) + 1;
		const candidate: PolyphaseDetails = {
			...d,
			agents: kept,
			agentsOmitted: { count: (priorOmitted?.count ?? 0) + dropped.length, byStatus },
		};
		if (byteLength(candidate) <= maxBytes || cap === 0) return candidate;
	}
	return d;
}

/**
 * Degrades `run` through L0-L4 (§9.2) until the JSON-stringified result fits `maxBytes`
 * (`FINAL_DETAILS_MAX_BYTES` or `PARTIAL_DETAILS_MAX_BYTES` by default). L4 always fits: per-level
 * caps keep run-level strings and phases bounded at every level, and a final {@link forceFit} pass
 * strips fields and agents if an L4 result (e.g. hundreds of near-cap agents) still does not.
 *
 * `options.now` is accepted for signature symmetry with the rest of the polyphase API (store.ts's
 * injectable clock) but is not currently read: every persisted field is an absolute timestamp, and
 * no derived field here depends on "the current time".
 */
export function buildDetails(
	run: RunView,
	options: { final: boolean; maxBytes?: number; now?: number },
): PolyphaseDetails {
	const maxBytes = options.maxBytes ?? (options.final ? FINAL_DETAILS_MAX_BYTES : PARTIAL_DETAILS_MAX_BYTES);
	const statusLines = computeStatusLines(run.agents);

	let result: PolyphaseDetails | undefined;
	for (const plan of LEVEL_PLANS) {
		result = buildAtLevel(run, plan, options, statusLines);
		if (plan.level === 4 || byteLength(result) <= maxBytes) break;
	}
	const built = result as PolyphaseDetails;
	return byteLength(built) <= maxBytes ? built : forceFit(built, maxBytes);
}

function isAgentDetailsLike(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const a = value as Record<string, unknown>;
	return (
		typeof a.i === "number" &&
		typeof a.label === "string" &&
		typeof a.agent === "string" &&
		typeof a.status === "string" &&
		typeof a.task === "string"
	);
}

function isTotalsLike(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const t = value as Record<string, unknown>;
	return typeof t.agents === "number" && typeof t.tokens === "number" && typeof t.cost === "number";
}

/** Structural guard: `v === 1`, the required top-level fields, every agent's required fields, and
 * the shape of the optional array/object fields (`phases`, `log`, `totals`). Persisted details can
 * be hand-edited or come from an older schema version, so this is read defensively, not just at the
 * top level: {@link collectArchivedRuns} hands these straight to renderers as `PolyphaseDetails`. */
export function isPolyphaseDetails(value: unknown): value is PolyphaseDetails {
	if (typeof value !== "object" || value === null) return false;
	const d = value as Record<string, unknown>;
	if (d.v !== 1) return false;
	if (typeof d.runId !== "string") return false;
	if (typeof d.kind !== "string") return false;
	if (typeof d.origin !== "string") return false;
	if (typeof d.title !== "string") return false;
	if (typeof d.status !== "string") return false;
	if (typeof d.startedAt !== "number") return false;
	if (!Array.isArray(d.agents)) return false;
	if (d.phases !== undefined && !Array.isArray(d.phases)) return false;
	if (d.log !== undefined && !Array.isArray(d.log)) return false;
	if (!isTotalsLike(d.totals)) return false;
	return d.agents.every(isAgentDetailsLike);
}

export interface ArchivedRun {
	runId: string;
	entryId: string;
	timestamp: number;
	source: "toolResult" | "message";
	toolName?: string;
	details: PolyphaseDetails;
}

function extractArchivedRun(entry: SessionEntry): ArchivedRun | undefined {
	if (entry.type === "message" && entry.message.role === "toolResult") {
		const { toolName, details } = entry.message;
		if (toolName !== SUBAGENT_TOOL_NAME && toolName !== WORKFLOW_TOOL_NAME) return undefined;
		if (!isPolyphaseDetails(details)) return undefined;
		return {
			runId: details.runId,
			entryId: entry.id,
			timestamp: Date.parse(entry.timestamp),
			source: "toolResult",
			toolName,
			details,
		};
	}
	if (entry.type === "custom_message" && entry.customType === "polyphase-workflow") {
		if (!isPolyphaseDetails(entry.details)) return undefined;
		return {
			runId: entry.details.runId,
			entryId: entry.id,
			timestamp: Date.parse(entry.timestamp),
			source: "message",
			details: entry.details,
		};
	}
	return undefined;
}

/**
 * `toolResult` entries for `subagent`/`workflow` and `custom_message` "polyphase-workflow"
 * entries whose `details` pass {@link isPolyphaseDetails}, excluding `liveRunIds`, deduped by
 * `runId` (newest kept), newest first, capped at `limit`.
 */
export function collectArchivedRuns(
	entries: readonly SessionEntry[],
	liveRunIds: ReadonlySet<string>,
	limit = 50,
): ArchivedRun[] {
	const byRunId = new Map<string, ArchivedRun>();
	for (const entry of entries) {
		const candidate = extractArchivedRun(entry);
		if (!candidate || liveRunIds.has(candidate.runId)) continue;
		const existing = byRunId.get(candidate.runId);
		if (!existing || candidate.timestamp >= existing.timestamp) byRunId.set(candidate.runId, candidate);
	}
	return [...byRunId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/** `combineUsage` over every agent's `state.usage`. */
export function sumRunUsage(run: RunView): Usage | undefined {
	let total: Usage | undefined;
	for (const agent of run.agents) {
		const usage = agent.state.usage;
		if (!usage) continue;
		total = total ? combineUsage(total, usage) : usage;
	}
	return total;
}
