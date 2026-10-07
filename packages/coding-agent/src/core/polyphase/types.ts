/**
 * Shared types and constants for polyphase: subagent/workflow orchestration, the child
 * event stream, and the persisted/live views consumed by rendering and the inspector.
 *
 * This module owns the vocabulary. Other polyphase modules import from here instead of
 * redeclaring these shapes.
 */

import type { ThinkingLevel } from "@draht/agent-core";
import type { JsonObject, JsonValue, StopReason, Usage } from "@draht/ai";
import type { MergeResult } from "../multi-agent/index.ts";
import type { ChildEventReducer } from "./child-events.ts";

// ── Names and limits ───────────────────────────────────────────────────────

export const POLYPHASE_DEPTH_ENV = "DRAHT_POLYPHASE_DEPTH";
export const POLYPHASE_SCHEMA_FILE_ENV = "DRAHT_POLYPHASE_SCHEMA_FILE";
export const SUBAGENT_TOOL_NAME = "subagent";
export const WORKFLOW_TOOL_NAME = "workflow";
export const DUET_DELEGATE_TOOL_NAME = "duet_delegate";
export const POLYPHASE_RESULT_TOOL_NAME = "polyphase_result";

/** Suffix of the permission gate's block reason when no UI can answer (builtins/subagent.ts). */
export const NO_UI_APPROVAL_SUFFIX = "(no UI available to request approval)";

export const FINAL_DETAILS_MAX_BYTES = 16_384;
export const PARTIAL_DETAILS_MAX_BYTES = 8_192;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Nesting depth of this process: 0 for the user's session, n for a child spawned at depth n-1. */
export function currentPolyphaseDepth(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[POLYPHASE_DEPTH_ENV] ?? "0", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// ── Agent definitions and the runner seam (moved from builtins/subagent.ts) ──

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Disable user and project extensions in the child process. Core builtins still load. */
	disableExtensions?: boolean;
	systemPrompt: string;
	source: "user" | "project";
}

export interface ModelRef {
	provider: string;
	id: string;
}

export interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	usage?: Usage;
	step?: number;
	merge?: MergeResult;
	/** Confirmed from the child's first assistant message_start. */
	model?: ModelRef;
	/** Confirmed from the child's assistant message_end. */
	thinkingLevel?: ThinkingLevel;
	stopReason?: StopReason;
	turns?: number;
	toolCalls?: number;
	blockedToolCalls?: number;
	/** Validated polyphase_result arguments when a schema was requested. */
	structured?: { value: JsonValue };
	cancelled?: boolean;
	durationMs?: number;
}

export type ProgressFn = (activity: string) => void;
export type ChildStateChange = "none" | "fine" | "coarse";

/** Per-run options threaded from orchestrators to the process runner. All optional. */
export interface AgentRunContext {
	/** `--model` value. Overrides agent.model when set. */
	model?: string;
	/** `--thinking` value. */
	thinking?: ThinkingLevel;
	/** Model display info used when the runner creates its own reducer. */
	modelInfo?: AgentModelInfo;
	/** Retry once without --model/--thinking when the child cannot resolve the inherited model (§7.3). */
	fallbackToChildDefaultModel?: boolean;
	/** Added to the runner's fixed exclusions (workflow, duet_delegate). */
	excludeTools?: readonly string[];
	/** Appended to `--tools` only when the agent has a tools allowlist. */
	extraTools?: readonly string[];
	/** Appended to the agent system prompt in the same temp file. */
	extraSystemPrompt?: string;
	/** Extra environment for the child. */
	env?: Readonly<Record<string, string>>;
	/** Object JSON Schema for polyphase_result. The runner writes it to a 0600 temp file. */
	schema?: JsonObject;
	/** Live state sink. When absent the runner uses a private reducer. */
	reducer?: ChildEventReducer;
	onQueued?: () => void;
	onStart?: (info: { pid: number | undefined; argv: readonly string[] }) => void;
	onChange?: (change: "fine" | "coarse") => void;
	/** Called once by runAgentWithLifecycle with the final result (after merge-back). */
	onFinish?: (result: RunResult) => void;
}

export type AgentRunner = (
	cwd: string,
	agent: AgentConfig,
	task: string,
	signal?: AbortSignal,
	step?: number,
	onProgress?: ProgressFn,
	run?: AgentRunContext,
) => Promise<RunResult>;

// ── Child state ─────────────────────────────────────────────────────────────

export type AgentStatus =
	| "pending" // created, not yet asked to run (later chain step)
	| "queued" // waiting for a limiter slot
	| "starting" // process spawned, no agent_start yet
	| "running"
	| "done"
	| "failed"
	| "cancelled"
	| "skipped"; // never started because its run ended (e.g. chain stopped)
export type AgentActivity = "idle" | "waiting" | "thinking" | "writing" | "tool" | "retrying" | "compacting";
export type ModelSource = "override" | "phase" | "frontmatter" | "inherited" | "child-default";
export type CancelReason = "user" | "budget" | "run" | "parent" | "shutdown";

export interface AgentModelInfo {
	source: ModelSource;
	/** Value passed with --model (or the frontmatter pattern). */
	requested?: string;
	requestedThinking?: ThinkingLevel;
	/** Pre-resolved in the parent, then confirmed by the child's assistant message_start. */
	provider?: string;
	id?: string;
	/** Confirmed at message_end, or by thinking_level_changed. */
	thinkingLevel?: ThinkingLevel;
	confirmed: boolean;
}

export type ToolItemStatus = "pending" | "running" | "ok" | "error" | "blocked";

/** `rev` increments on every mutation of the item (cache key for wrapped lines). */
export type TranscriptItem =
	| {
			kind: "thinking";
			seq: number;
			rev: number;
			text: string;
			droppedChars: number;
			done: boolean;
			redacted: boolean;
	  }
	| { kind: "text"; seq: number; rev: number; text: string; droppedChars: number; done: boolean }
	| {
			kind: "tool";
			seq: number;
			rev: number;
			toolCallId: string;
			name: string;
			summary: string;
			status: ToolItemStatus;
			startedAt?: number;
			endedAt?: number;
			resultPreview?: string;
			blockedReason?: string;
	  }
	| { kind: "notice"; seq: number; rev: number; level: "info" | "warning" | "error"; text: string; at: number };

export interface BlockedToolCall {
	toolName: string;
	summary: string;
	reason: string;
}

export interface ChildStateLimits {
	maxItems: number; // 400
	maxChars: number; // 256_000 transcript chars while running
	maxItemChars: number; // 32_000 per thinking/text item (tail kept)
	maxFinalTextChars: number; // 200_000
	maxStderrChars: number; // 16_384 (tail kept)
	finishedMaxChars: number; // 32_000 after the run finished
}
export const DEFAULT_CHILD_STATE_LIMITS: ChildStateLimits = {
	maxItems: 400,
	maxChars: 256_000,
	maxItemChars: 32_000,
	maxFinalTextChars: 200_000,
	maxStderrChars: 16_384,
	finishedMaxChars: 32_000,
};

export interface ChildAgentState {
	lifecycle: "pending" | "queued" | "spawning" | "running" | "settled" | "exited";
	activity: AgentActivity;
	sessionId?: string;
	model: AgentModelInfo;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	toolCounts: Record<string, number>;
	/** Newest last, at most 20 kept. */
	blocked: BlockedToolCall[];
	blockedCount: number;
	currentTool?: { toolCallId: string; name: string; summary: string; startedAt: number };
	/** Sum of finished assistant message usage (combineUsage). */
	usage?: Usage;
	/** Cumulative usage of the in-flight assistant message. */
	liveUsage?: Usage;
	transcript: TranscriptItem[];
	transcriptChars: number;
	droppedItems: number;
	nextSeq: number;
	/** One line, ≤ 160 chars: what the agent is doing right now. */
	nowLine: string;
	/** First text part of the last assistant message that had text, capped. */
	finalText: string;
	stopReason?: StopReason;
	errorMessage?: string;
	/** Arguments of the last successful polyphase_result call (validated later by the runner). */
	structured?: { value: JsonValue };
	retry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };
	stderrTail: string;
	malformedLines: number;
	droppedLines: number;
	recordsSeen: number;
	queuedAt?: number;
	startedAt?: number;
	endedAt?: number;
	lastEventAt?: number;
	/** ++ on every fine or coarse change. */
	version: number;
	/** ++ on every coarse change. */
	coarseVersion: number;
}

// ── Runs: read-only views implemented by store.ts, consumed by details/text/render/inspector ──

export type RunKind = "subagent" | "workflow" | "duet";
export type RunOrigin = "tool" | "command";
export type SubagentMode = "single" | "parallel" | "chain";
export type RunStatus = "running" | "done" | "failed" | "cancelled";
export type WorkflowSource = "inline" | "project" | "user";

export interface PhaseInfo {
	title: string;
	detail?: string;
	model?: string;
	/** True for phases created by phase()/agent({phase}) that meta did not declare. */
	dynamic: boolean;
}

export interface WorkflowRunInfo {
	name: string;
	description: string;
	source: WorkflowSource;
	path?: string;
	args: string;
}

export interface LogLine {
	at: number;
	level: "info" | "warning";
	text: string;
	phase?: number;
}

export interface AgentView {
	/** `${runId}#${index}` */
	readonly key: string;
	readonly index: number;
	readonly label: string;
	readonly agentType: string;
	readonly task: string;
	readonly phase?: number;
	/** 1-based chain step. */
	readonly step?: number;
	readonly status: AgentStatus;
	readonly cancelReason?: CancelReason;
	readonly state: Readonly<ChildAgentState>;
	readonly result?: Readonly<RunResult>;
	readonly createdAt: number;
}

export interface RunView {
	readonly id: string;
	readonly kind: RunKind;
	readonly origin: RunOrigin;
	readonly mode?: SubagentMode;
	readonly title: string;
	readonly workflow?: Readonly<WorkflowRunInfo>;
	readonly phases: readonly PhaseInfo[];
	readonly currentPhase?: number;
	readonly status: RunStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly agents: readonly AgentView[];
	readonly log: readonly LogLine[];
	readonly logDropped: number;
	readonly budget: Readonly<{ totalTokens: number | null; spentTokens: number; exhausted: boolean }>;
	readonly resultPreview?: string;
	readonly error?: string;
	readonly version: number;
	readonly coarseVersion: number;
}

// ── Persisted, bounded, JSON-compatible tool-result details (D2) ────────────

export interface PolyphaseDetails {
	v: 1;
	runId: string;
	kind: RunKind;
	origin: RunOrigin;
	mode?: SubagentMode;
	title: string;
	/** "running" in partial details. */
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	workflow?: { name: string; description: string; source: WorkflowSource; path?: string; args?: string };
	phases?: PhaseDetails[];
	currentPhase?: number;
	agents: AgentDetails[];
	agentsOmitted?: { count: number; byStatus: Partial<Record<AgentStatus, number>> };
	log?: string[];
	logOmitted?: number;
	totals: {
		agents: number;
		/** Billable tokens: input + output + cacheWrite. */
		tokens: number;
		/** USD. */
		cost: number;
		byStatus: Partial<Record<AgentStatus, number>>;
		blockedToolCalls: number;
	};
	budget?: { totalTokens: number; spentTokens: number; exhausted: boolean };
	resultPreview?: string;
	error?: string;
	/** Degradation level applied to fit the byte cap (§9.2). */
	degraded?: 0 | 1 | 2 | 3 | 4;
}

export interface PhaseDetails {
	title: string;
	detail?: string;
	model?: string;
	dynamic?: boolean;
}

export interface AgentDetails {
	i: number;
	label: string;
	agent: string;
	phase?: number;
	step?: number;
	status: AgentStatus;
	cancelReason?: CancelReason;
	/** "provider/id" when known, else the requested pattern. */
	model?: string;
	thinking?: ThinkingLevel;
	modelSource?: ModelSource;
	modelConfirmed?: boolean;
	startedAt?: number;
	endedAt?: number;
	turns?: number;
	toolCalls?: number;
	tools?: Record<string, number>;
	tokens?: number;
	cost?: number;
	blocked?: number;
	/** e.g. "bash: npm test -- auth". */
	blockedSample?: string;
	task: string;
	/** Partial details only. */
	now?: string;
	/** Last `STATUS: ...` line of the output. */
	statusLine?: string;
	/** Head+tail preview of the final output. */
	output?: string;
	error?: string;
	merge?: "ok" | "failed";
}
