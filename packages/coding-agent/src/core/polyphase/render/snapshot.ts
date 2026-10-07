/**
 * Render model: a plain-data snapshot of a run, taken either from the live store (`snapshotFromRun`)
 * or from persisted details (`snapshotFromDetails`). `render/run-block.ts` (P9) and `ui/inspector.ts`
 * (P10) consume only this snapshot, never `RunView`/`AgentView` or `PolyphaseDetails` directly, so the
 * same layout code renders live and archived runs identically.
 */

import type { ThinkingLevel } from "@draht/agent-core";
import { billableTokens, extractStatusLine } from "../child-events.ts";
import type { LimiterStats } from "../limiter.ts";
import type {
	AgentDetails,
	AgentStatus,
	AgentView,
	CancelReason,
	ChildAgentState,
	ModelSource,
	PhaseDetails,
	PhaseInfo,
	PolyphaseDetails,
	RunKind,
	RunOrigin,
	RunStatus,
	RunView,
	SubagentMode,
	TranscriptItem,
	WorkflowSource,
} from "../types.ts";

export interface PhaseSnapshot {
	index: number;
	title: string;
	detail?: string;
	model?: string;
	dynamic: boolean;
	status: "pending" | "running" | "done" | "failed";
	agentIdx: number[];
	done: number;
	total: number;
	elapsedMs?: number;
	/** True when `done`/`total` are computed from a subset of agents (archived details with
	 * `agentsOmitted`), so they must not be read as the phase's true totals. See `RunSnapshot.agentsOmitted`
	 * for the omitted count. */
	incomplete?: boolean;
}

export interface AgentSnapshotRow {
	i: number;
	label: string;
	agentType: string;
	phase?: number;
	step?: number;
	status: AgentStatus;
	cancelReason?: CancelReason;
	provider?: string;
	modelId?: string;
	modelText?: string;
	thinking?: ThinkingLevel;
	modelSource?: ModelSource;
	modelConfirmed?: boolean;
	elapsedMs?: number;
	turns: number;
	toolCalls: number;
	tools?: Record<string, number>;
	tokens: number;
	cost: number;
	blocked: number;
	blockedSample?: string;
	task: string;
	now?: string;
	statusLine?: string;
	output?: string;
	error?: string;
	merge?: "ok" | "failed";
	/** Live only: the newest `tailItems` transcript items (references, not copies). */
	tail?: readonly TranscriptItem[];
}

export interface RunSnapshot {
	runId: string;
	kind: RunKind;
	origin: RunOrigin;
	mode?: SubagentMode;
	title: string;
	status: RunStatus;
	live: boolean;
	startedAt: number;
	elapsedMs: number;
	counts: Record<AgentStatus, number>;
	tokens: number;
	cost: number;
	budget?: { totalTokens: number; spentTokens: number; exhausted: boolean };
	workflow?: { name: string; description: string; source: WorkflowSource; args?: string };
	phases: PhaseSnapshot[];
	currentPhase?: number;
	agents: AgentSnapshotRow[];
	agentsOmitted?: { count: number; byStatus: Partial<Record<AgentStatus, number>> };
	log: string[];
	resultPreview?: string;
	error?: string;
	blockedToolCalls: number;
	limiter?: LimiterStats;
	version: number;
}

function emptyCounts(): Record<AgentStatus, number> {
	return { pending: 0, queued: 0, starting: 0, running: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 };
}

const ACTIVE_STATUSES: readonly AgentStatus[] = ["running", "starting"];
const FINISHED_STATUSES: readonly AgentStatus[] = ["done", "failed", "cancelled", "skipped"];

function isActive(status: AgentStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}

function isFinished(status: AgentStatus): boolean {
	return FINISHED_STATUSES.includes(status);
}

function firstLine(text: string): string {
	const idx = text.indexOf("\n");
	return idx === -1 ? text : text.slice(0, idx);
}

function splitModel(model: string | undefined): { provider?: string; id?: string } {
	if (!model) return {};
	const slash = model.indexOf("/");
	if (slash === -1) return { id: model };
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * Implements DESIGN §11.1's phase status rules, plus two deliberate extra rules the design's
 * unordered rule list leaves ambiguous (both pinned by tests in render-snapshot.test.ts):
 *  1. **Precedence is failed > done > running > pending.** A non-current phase whose agents all
 *     finished with at least one failure reads "failed", not "done", because that is the more
 *     actionable signal.
 *  2. **A non-current phase with some finished and some not-yet-started (queued/pending) agents,
 *     but none active, reads "running" rather than falling through to "pending".** "Pending" is
 *     reserved for phases where no agent has made any progress yet; partial progress should not
 *     look identical to "not started".
 */
function phaseStatusFor(agentRows: readonly AgentSnapshotRow[], isCurrent: boolean): PhaseSnapshot["status"] {
	const total = agentRows.length;
	const anyActive = agentRows.some((row) => isActive(row.status));
	const anyFinished = agentRows.some((row) => isFinished(row.status));
	const allFinished = total > 0 && agentRows.every((row) => isFinished(row.status));
	const anyFailed = agentRows.some((row) => row.status === "failed");
	if (anyFailed && !anyActive) return "failed";
	if (allFinished && !isCurrent) return "done";
	if (isCurrent || anyActive) return "running";
	if (anyFinished) return "running";
	return "pending";
}

function phaseElapsedMs(agentRows: readonly AgentSnapshotRow[]): number | undefined {
	const withElapsed = agentRows.map((row) => row.elapsedMs).filter((ms): ms is number => ms !== undefined);
	if (withElapsed.length === 0) return undefined;
	return Math.max(...withElapsed);
}

function boundedTail(items: readonly TranscriptItem[], tailItems: number): readonly TranscriptItem[] {
	return tailItems > 0 ? items.slice(-tailItems) : [];
}

function buildPhaseSnapshots(
	phases: readonly { title: string; detail?: string; model?: string; dynamic: boolean }[],
	agents: readonly AgentSnapshotRow[],
	currentPhase: number | undefined,
	incomplete = false,
): PhaseSnapshot[] {
	return phases.map((phase, index) => {
		const agentRows = agents.filter((row) => row.phase === index);
		const agentIdx = agentRows.map((row) => row.i);
		const done = agentRows.filter((row) => row.status === "done").length;
		return {
			index,
			title: phase.title,
			detail: phase.detail,
			model: phase.model,
			dynamic: phase.dynamic,
			status: phaseStatusFor(agentRows, currentPhase === index),
			agentIdx,
			done,
			total: agentRows.length,
			elapsedMs: phaseElapsedMs(agentRows),
			...(incomplete ? { incomplete: true } : {}),
		};
	});
}

function rowFromAgentView(agent: AgentView, now: number, tailItems: number): AgentSnapshotRow {
	const state: Readonly<ChildAgentState> = agent.state;
	const tokens = billableTokens(state.usage) + billableTokens(state.liveUsage);
	const cost = (state.usage?.cost.total ?? 0) + (state.liveUsage?.cost.total ?? 0);
	const firstBlocked = state.blocked[0];
	const result = agent.result;
	// Matches details.ts's buildAgentDetails: gate on status, and prefer stderr over errorMessage
	// (details.ts: `agent.result?.stderr || agent.state.errorMessage`), so the error text does not
	// change when a row switches from the live store to persisted details at completion.
	const isFailureStatus = agent.status === "failed" || agent.status === "cancelled";
	const errorSource = result?.stderr || state.errorMessage;
	const error = isFailureStatus && errorSource ? firstLine(errorSource) : undefined;
	const elapsedMs = state.startedAt === undefined ? undefined : Math.max(0, (state.endedAt ?? now) - state.startedAt);
	const resolved = Boolean(state.model.provider && state.model.id);
	const modelText =
		!state.model.confirmed && !resolved
			? (state.model.requested ?? (state.model.source === "child-default" ? "default model" : undefined))
			: undefined;
	return {
		i: agent.index,
		label: agent.label,
		agentType: agent.agentType,
		phase: agent.phase,
		step: agent.step,
		status: agent.status,
		cancelReason: agent.cancelReason,
		provider: state.model.provider,
		modelId: state.model.id,
		modelText,
		// Matches details.ts's buildAgentDetails, which writes `thinking` only from the confirmed
		// `state.model.thinkingLevel`, never from `requestedThinking`. A queued/pending agent's
		// requested thinking level is therefore not shown until the child confirms it.
		thinking: state.model.thinkingLevel,
		modelSource: state.model.source,
		modelConfirmed: state.model.confirmed,
		elapsedMs,
		turns: state.turns,
		toolCalls: state.toolCalls,
		tools: Object.keys(state.toolCounts).length > 0 ? state.toolCounts : undefined,
		tokens,
		cost,
		blocked: state.blockedCount,
		blockedSample: firstBlocked ? `${firstBlocked.toolName}: ${firstBlocked.summary}` : undefined,
		task: agent.task,
		now: isFinished(agent.status) ? undefined : state.nowLine || undefined,
		statusLine: extractStatusLine(result?.output ?? state.finalText),
		output: result?.output,
		error,
		merge: result?.merge ? (result.merge.success ? "ok" : "failed") : undefined,
		tail: boundedTail(state.transcript, tailItems),
	};
}

/** Live view of a run, taken from the store. `tailItems` bounds `AgentSnapshotRow.tail`. */
export function snapshotFromRun(
	run: RunView,
	options: { now: number; tailItems: number; limiter?: LimiterStats },
): RunSnapshot {
	const counts = emptyCounts();
	const agents = run.agents.map((agent) => {
		const row = rowFromAgentView(agent, options.now, options.tailItems);
		counts[row.status]++;
		return row;
	});
	const tokens = agents.reduce((sum, row) => sum + row.tokens, 0);
	const cost = agents.reduce((sum, row) => sum + row.cost, 0);
	const blockedToolCalls = agents.reduce((sum, row) => sum + row.blocked, 0);
	const phases: readonly PhaseInfo[] = run.phases;
	const elapsedMs = Math.max(0, (run.endedAt ?? options.now) - run.startedAt);
	return {
		runId: run.id,
		kind: run.kind,
		origin: run.origin,
		mode: run.mode,
		title: run.title,
		status: run.status,
		live: true,
		startedAt: run.startedAt,
		elapsedMs,
		counts,
		tokens,
		cost,
		budget: run.budget.totalTokens === null ? undefined : { ...run.budget, totalTokens: run.budget.totalTokens },
		workflow: run.workflow
			? {
					name: run.workflow.name,
					description: run.workflow.description,
					source: run.workflow.source,
					args: run.workflow.args,
				}
			: undefined,
		phases: buildPhaseSnapshots(phases, agents, run.status === "running" ? run.currentPhase : undefined),
		currentPhase: run.currentPhase,
		agents,
		log: run.log.map((line) => line.text),
		resultPreview: run.resultPreview,
		error: run.error,
		blockedToolCalls,
		limiter: options.limiter,
		version: run.version,
	};
}

function rowFromAgentDetails(d: AgentDetails, now: number): AgentSnapshotRow {
	// details.ts's modelText() writes "provider/id" when both are known, else the raw requested
	// pattern verbatim (§9.2). A requested pattern can itself contain a "/" (e.g. a frontmatter
	// model written as "anthropic/claude-opus"), so a resolved value cannot be told apart from an
	// unresolved one by searching for a slash; that inference wrongly split such patterns.
	// Override, phase and inherited sources always resolve provider/id before the child even
	// starts (model-selection.ts), so `model` is "provider/id" for them regardless of confirmation.
	// Frontmatter is the only source whose pre-confirmation display resolution is ambiguous from
	// `model` alone, so it is treated as resolved only once `modelConfirmed` is true; `child-default`
	// never sets `model` while unconfirmed (modelText() returns `requested`, which is undefined).
	const resolved =
		d.model !== undefined &&
		(d.modelConfirmed === true ||
			d.modelSource === "override" ||
			d.modelSource === "phase" ||
			d.modelSource === "inherited");
	const split = resolved ? splitModel(d.model) : {};
	const modelText = resolved
		? undefined
		: (d.model ?? (d.modelSource === "child-default" ? "default model" : undefined));
	const elapsedMs = d.startedAt === undefined ? undefined : Math.max(0, (d.endedAt ?? now) - d.startedAt);
	const isFailureStatus = d.status === "failed" || d.status === "cancelled";
	return {
		i: d.i,
		label: d.label,
		agentType: d.agent,
		phase: d.phase,
		step: d.step,
		status: d.status,
		cancelReason: d.cancelReason,
		provider: split.provider,
		modelId: split.id,
		modelText,
		thinking: d.thinking,
		modelSource: d.modelSource,
		modelConfirmed: d.modelConfirmed,
		elapsedMs,
		turns: d.turns ?? 0,
		toolCalls: d.toolCalls ?? 0,
		tools: d.tools,
		tokens: d.tokens ?? 0,
		cost: d.cost ?? 0,
		blocked: d.blocked ?? 0,
		blockedSample: d.blockedSample,
		task: d.task,
		now: d.now,
		statusLine: d.statusLine,
		output: d.output,
		error: isFailureStatus ? d.error : undefined,
		merge: d.merge,
	};
}

function phaseInfoFromDetails(phase: PhaseDetails): {
	title: string;
	detail?: string;
	model?: string;
	dynamic: boolean;
} {
	return { title: phase.title, detail: phase.detail, model: phase.model, dynamic: phase.dynamic ?? false };
}

/** Cheap djb2 hash of the whole payload, so a line cache keyed on `RunSnapshot.version` (§11.2)
 * invalidates on every field a renderer can show (model confirmation, log lines, resultPreview,
 * agent `now`/tokens, degradation level, ...), not only status/endedAt/totals.byStatus. Details are
 * capped at `FINAL_DETAILS_MAX_BYTES`/`PARTIAL_DETAILS_MAX_BYTES`, so stringifying them is cheap.
 * `PolyphaseDetails` carries no version counter of its own. */
function detailsVersion(details: PolyphaseDetails): number {
	const fingerprint = JSON.stringify(details);
	let hash = 5381;
	for (let i = 0; i < fingerprint.length; i++) {
		hash = (hash * 33) ^ fingerprint.charCodeAt(i);
	}
	return hash >>> 0;
}

/** Archived or persisted view of a run, taken from `PolyphaseDetails`. No transcript is available, so
 * every `AgentSnapshotRow.tail` is left undefined. */
export function snapshotFromDetails(details: PolyphaseDetails, options?: { now?: number }): RunSnapshot {
	const now = options?.now ?? Date.now();
	const agents = details.agents.map((agent) => rowFromAgentDetails(agent, now));
	const counts: Record<AgentStatus, number> = { ...emptyCounts(), ...details.totals.byStatus };
	const phases = (details.phases ?? []).map(phaseInfoFromDetails);
	const elapsedMs = Math.max(0, (details.endedAt ?? now) - details.startedAt);
	return {
		runId: details.runId,
		kind: details.kind,
		origin: details.origin,
		mode: details.mode,
		title: details.title,
		status: details.status,
		live: false,
		startedAt: details.startedAt,
		elapsedMs,
		counts,
		tokens: details.totals.tokens,
		cost: details.totals.cost,
		budget: details.budget,
		workflow: details.workflow
			? {
					name: details.workflow.name,
					description: details.workflow.description,
					source: details.workflow.source,
					args: details.workflow.args,
				}
			: undefined,
		phases: buildPhaseSnapshots(
			phases,
			agents,
			details.status === "running" ? details.currentPhase : undefined,
			details.agentsOmitted !== undefined,
		),
		currentPhase: details.currentPhase,
		agents,
		agentsOmitted: details.agentsOmitted,
		log: details.log ?? [],
		resultPreview: details.resultPreview,
		error: details.error,
		blockedToolCalls: details.totals.blockedToolCalls,
		version: detailsVersion(details),
	};
}
