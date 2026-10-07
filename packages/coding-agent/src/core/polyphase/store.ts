/**
 * Session-scoped live state for polyphase runs: `LiveAgent` wraps a child's `ChildEventReducer`
 * with lifecycle/cancellation, `PolyphaseRun` groups agents into one subagent/workflow run, and
 * `PolyphaseStore` owns every run plus the pump flush cycle and retention.
 */

import { billableTokens, ChildEventReducer } from "./child-events.ts";
import {
	type AgentModelInfo,
	type AgentRunContext,
	type AgentStatus,
	type AgentView,
	type CancelReason,
	type ChildAgentState,
	DEFAULT_CHILD_STATE_LIMITS,
	type LogLine,
	type PhaseInfo,
	type RunKind,
	type RunOrigin,
	type RunResult,
	type RunStatus,
	type RunView,
	type SubagentMode,
	type WorkflowRunInfo,
} from "./types.ts";
import type { UpdatePump } from "./update-pump.ts";

export interface RunInit {
	id: string;
	kind: RunKind;
	origin: RunOrigin;
	title: string;
	mode?: SubagentMode;
	workflow?: WorkflowRunInfo;
	phases?: readonly { title: string; detail?: string; model?: string }[];
	budgetTokens: number | null;
	parentSignal?: AbortSignal;
}

export interface AgentInit {
	label: string;
	agentType: string;
	task: string;
	phase?: number;
	step?: number;
	model: AgentModelInfo;
}

const TERMINAL_STATUSES: readonly AgentStatus[] = ["done", "failed", "cancelled", "skipped"];

/**
 * Meta caps declared phases at 20 (`meta.ts`); this caps the dynamic ones a script can add by
 * calling `phase()` with a new title each time. Without a cap, every new title grows `phasesList`
 * forever, so each later `phase()` call's `findIndex` scan gets more expensive and the run keeps
 * broadcasting a coarse update for each one.
 */
const MAX_PHASES = 100;

/** Finished runs newest-first, by `endedAt` then the store-assigned `finishSeq` tiebreak. */
function finishedNewestFirst(a: PolyphaseRun, b: PolyphaseRun): number {
	return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || (b.finishSeq ?? 0) - (a.finishSeq ?? 0);
}

function isTerminal(status: AgentStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

/** Live state of one child agent, wired into its owning run's dirty/cancel machinery. */
export class LiveAgent implements AgentView {
	readonly key: string;
	readonly index: number;
	readonly label: string;
	readonly agentType: string;
	readonly task: string;
	readonly phase?: number;
	readonly step?: number;
	readonly createdAt: number;
	readonly reducer: ChildEventReducer;
	/** `AbortSignal.any([run.signal, own controller])`. */
	readonly signal: AbortSignal;

	private readonly run: PolyphaseRun;
	private readonly controller = new AbortController();
	private _cancelReason: CancelReason | undefined;
	private _result: RunResult | undefined;
	private _skipped = false;

	constructor(run: PolyphaseRun, index: number, init: AgentInit, now: () => number) {
		this.run = run;
		this.index = index;
		this.key = `${run.id}#${index}`;
		this.label = init.label;
		this.agentType = init.agentType;
		this.task = init.task;
		this.phase = init.phase;
		this.step = init.step;
		this.createdAt = now();
		this.reducer = new ChildEventReducer({ model: init.model, now });
		this.signal = AbortSignal.any([run.signal, this.controller.signal]);
	}

	get state(): Readonly<ChildAgentState> {
		return this.reducer.state;
	}

	get result(): Readonly<RunResult> | undefined {
		return this._result;
	}

	get cancelReason(): CancelReason | undefined {
		return this._cancelReason;
	}

	get status(): AgentStatus {
		if (this._result) {
			if (this._result.cancelled) return "cancelled";
			return this._result.exitCode === 0 ? "done" : "failed";
		}
		if (this._skipped) return "skipped";
		switch (this.reducer.state.lifecycle) {
			case "running":
			case "settled":
			case "exited":
				return "running";
			case "spawning":
				return "starting";
			case "queued":
				return "queued";
			default:
				return "pending";
		}
	}

	/** Sets `cancelReason` once and aborts this agent's own controller. False when already finished. */
	cancel(reason: CancelReason): boolean {
		if (isTerminal(this.status)) return false;
		if (this._cancelReason === undefined) this._cancelReason = reason;
		if (!this.controller.signal.aborted) this.controller.abort();
		return true;
	}

	createRunContext(
		base: Omit<AgentRunContext, "reducer" | "onQueued" | "onStart" | "onChange" | "onFinish"> = {},
	): AgentRunContext {
		return {
			...base,
			reducer: this.reducer,
			onQueued: () => {
				this.reducer.markQueued();
				this.run.markDirty("coarse");
			},
			onStart: () => {
				this.run.markDirty("coarse");
			},
			onChange: (change) => {
				this.run.markDirty(change);
			},
			onFinish: (result) => {
				this.complete(result);
			},
		};
	}

	complete(result: RunResult): void {
		if (this._result !== undefined || this._skipped) return;
		this._result = result;
		if (this.run.status !== "running") {
			// The run already ran retention when it finished. An agent that settles afterwards
			// (e.g. still being SIGTERM'd) would otherwise keep growing under the running-time
			// transcript cap until the next unrelated run finishes and sweeps it.
			if (this.run.transcriptsDropped) this.reducer.dropTranscript();
			else this.reducer.trimForRetention(DEFAULT_CHILD_STATE_LIMITS.finishedMaxChars);
		}
		this.run.markDirty("coarse");
	}

	markSkipped(): void {
		if (this._result !== undefined || this._skipped) return;
		this._skipped = true;
		this.run.markDirty("coarse");
	}
}

export type StoreChange = { type: "runs"; runIds: readonly string[]; coarse: boolean } | { type: "disposed" };

export interface StoreTotals {
	runs: number;
	running: number;
	queued: number;
	active: number;
	done: number;
	failed: number;
	cancelled: number;
	tokens: number;
	cost: number;
}

interface RunDeps {
	pump: UpdatePump;
	now: () => number;
	nextSeq: () => number;
	onFinished: (run: PolyphaseRun) => void;
}

/** One subagent/duet/workflow run: its agents, phases, log and budget. */
export class PolyphaseRun implements RunView {
	readonly id: string;
	readonly kind: RunKind;
	readonly origin: RunOrigin;
	readonly mode?: SubagentMode;
	readonly title: string;
	readonly workflow?: Readonly<WorkflowRunInfo>;
	readonly startedAt: number;
	/** Monotonic store-assigned sequence, for tie-breaking same-timestamp ordering. */
	readonly createSeq: number;
	/** Aborted by `cancel()` and by `parentSignal` (via `cancel("parent")`). */
	readonly signal: AbortSignal;
	version = 0;
	coarseVersion = 0;

	private readonly deps: RunDeps;
	private readonly controller = new AbortController();
	private readonly agentsList: LiveAgent[] = [];
	private readonly phasesList: PhaseInfo[];
	private readonly logList: LogLine[] = [];
	private readonly flushListeners = new Set<(run: PolyphaseRun, coarse: boolean) => void>();
	private readonly budgetTotal: number | null;
	private readonly parentSignal: AbortSignal | undefined;
	private readonly parentAbortHandler: (() => void) | undefined;

	private currentPhaseValue: number | undefined;
	private statusValue: RunStatus = "running";
	private endedAtValue: number | undefined;
	private finishSeqValue: number | undefined;
	private resultPreviewValue: string | undefined;
	private errorValue: string | undefined;
	private logDroppedValue = 0;
	private budgetExhausted = false;
	private warnedDynamicPhase = false;
	private warnedPhaseCap = false;
	private cancelReasonValue: CancelReason | undefined;
	private transcriptsDroppedValue = false;

	constructor(init: RunInit, deps: RunDeps) {
		this.deps = deps;
		this.id = init.id;
		this.kind = init.kind;
		this.origin = init.origin;
		this.mode = init.mode;
		this.title = init.title;
		this.workflow = init.workflow;
		this.phasesList = (init.phases ?? []).map((phase) => ({ ...phase, dynamic: false }));
		this.budgetTotal = init.budgetTokens;
		this.startedAt = deps.now();
		this.createSeq = deps.nextSeq();
		this.signal = this.controller.signal;

		if (init.parentSignal) {
			this.parentSignal = init.parentSignal;
			if (init.parentSignal.aborted) {
				this.cancel("parent");
			} else {
				this.parentAbortHandler = () => this.cancel("parent");
				init.parentSignal.addEventListener("abort", this.parentAbortHandler, { once: true });
			}
		}
	}

	get phases(): readonly PhaseInfo[] {
		return this.phasesList;
	}

	get currentPhase(): number | undefined {
		return this.currentPhaseValue;
	}

	get status(): RunStatus {
		return this.statusValue;
	}

	get endedAt(): number | undefined {
		return this.endedAtValue;
	}

	/** Monotonic store-assigned sequence set in `finish()`, for tie-breaking same-timestamp ordering. */
	get finishSeq(): number | undefined {
		return this.finishSeqValue;
	}

	get agents(): readonly LiveAgent[] {
		return this.agentsList;
	}

	get log(): readonly LogLine[] {
		return this.logList;
	}

	get logDropped(): number {
		return this.logDroppedValue;
	}

	get budget(): Readonly<{ totalTokens: number | null; spentTokens: number; exhausted: boolean }> {
		return { totalTokens: this.budgetTotal, spentTokens: this.spentTokens(), exhausted: this.budgetExhausted };
	}

	get resultPreview(): string | undefined {
		return this.resultPreviewValue;
	}

	get error(): string | undefined {
		return this.errorValue;
	}

	addAgent(init: AgentInit): LiveAgent {
		const agent = new LiveAgent(this, this.agentsList.length, init, this.deps.now);
		this.agentsList.push(agent);
		// The agent's own signal is already aborted (AbortSignal.any includes this.signal), but it
		// carries no cancelReason yet: inherit the run's, so it matches its siblings.
		if (this.signal.aborted && this.cancelReasonValue !== undefined) agent.cancel(this.cancelReasonValue);
		this.markDirty("coarse");
		return agent;
	}

	/** Index of an existing phase with this title, or a new dynamic phase (one-time warning). `undefined` title returns `currentPhase`. */
	resolvePhase(title: string | undefined): number | undefined {
		if (title === undefined) return this.currentPhaseValue;
		return this.phaseIndexFor(title);
	}

	enterPhase(title: string): number {
		const index = this.phaseIndexFor(title);
		this.currentPhaseValue = index;
		this.markDirty("coarse");
		return index;
	}

	private phaseIndexFor(title: string): number {
		const existing = this.phasesList.findIndex((phase) => phase.title === title);
		if (existing !== -1) return existing;
		if (this.phasesList.length >= MAX_PHASES) {
			if (!this.warnedPhaseCap) {
				this.warnedPhaseCap = true;
				this.appendLog(`workflow reached the ${MAX_PHASES}-phase cap; new phase titles are ignored`, "warning");
			}
			throw new Error(`phase cap reached: a run may have at most ${MAX_PHASES} phases`);
		}
		this.phasesList.push({ title, dynamic: true });
		if (!this.warnedDynamicPhase) {
			this.warnedDynamicPhase = true;
			this.appendLog("workflow entered a phase not declared in meta.phases", "warning");
		}
		return this.phasesList.length - 1;
	}

	appendLog(text: string, level: "info" | "warning" = "info"): void {
		const capped = text.length > 2000 ? text.slice(0, 2000) : text;
		this.logList.push({ at: this.deps.now(), level, text: capped, phase: this.currentPhaseValue });
		if (this.logList.length > 200) {
			this.logList.shift();
			this.logDroppedValue++;
		}
		this.markDirty("coarse");
	}

	setResultPreview(text: string): void {
		this.resultPreviewValue = text;
		this.markDirty("coarse");
	}

	markDirty(change: "fine" | "coarse"): void {
		this.deps.pump.schedule(this.id, change);
		this.checkBudget();
	}

	spentTokens(): number {
		let total = 0;
		for (const agent of this.agentsList) {
			total += billableTokens(agent.state.usage) + billableTokens(agent.state.liveUsage);
		}
		return total;
	}

	counts(): Record<AgentStatus, number> {
		const result: Record<AgentStatus, number> = {
			pending: 0,
			queued: 0,
			starting: 0,
			running: 0,
			done: 0,
			failed: 0,
			cancelled: 0,
			skipped: 0,
		};
		for (const agent of this.agentsList) result[agent.status]++;
		return result;
	}

	cancel(reason: CancelReason): void {
		if (this.cancelReasonValue === undefined) this.cancelReasonValue = reason;
		for (const agent of this.agentsList) agent.cancel(reason);
		if (!this.controller.signal.aborted) this.controller.abort();
		this.markDirty("coarse");
	}

	/** Pending agents become skipped; the heartbeat stops; retention runs. */
	finish(status: RunStatus, error?: string): void {
		if (this.statusValue !== "running") return;
		for (const agent of this.agentsList) {
			if (agent.status === "pending") agent.markSkipped();
		}
		this.statusValue = status;
		this.endedAtValue = this.deps.now();
		this.finishSeqValue = this.deps.nextSeq();
		if (error !== undefined) this.errorValue = error;
		this.deps.pump.stopHeartbeat(this.id);
		this.detachParentSignal();
		for (const agent of this.agentsList) {
			agent.reducer.trimForRetention(DEFAULT_CHILD_STATE_LIMITS.finishedMaxChars);
		}
		this.markDirty("coarse");
		this.deps.onFinished(this);
	}

	/** Store-internal: detaches the `parentSignal` abort listener (idempotent). */
	detachParentSignal(): void {
		if (this.parentSignal && this.parentAbortHandler) {
			this.parentSignal.removeEventListener("abort", this.parentAbortHandler);
		}
	}

	onFlush(listener: (run: PolyphaseRun, coarse: boolean) => void): () => void {
		this.flushListeners.add(listener);
		return () => this.flushListeners.delete(listener);
	}

	/** Store-internal: drops every agent's transcript (retention beyond `keepTranscriptRuns`). Idempotent:
	 *  `handleRunFinished` calls this again on every old finished run each time any run finishes. */
	dropTranscripts(): void {
		if (this.transcriptsDroppedValue) return;
		this.transcriptsDroppedValue = true;
		for (const agent of this.agentsList) agent.reducer.dropTranscript();
	}

	/** Store-internal: whether `dropTranscripts()` has already run, so a late-completing agent is
	 *  dropped rather than re-trimmed to the finished bound. */
	get transcriptsDropped(): boolean {
		return this.transcriptsDroppedValue;
	}

	/** Store-internal: called once per dirty run during a pump flush. */
	bumpVersion(coarse: boolean): void {
		this.version++;
		if (coarse) this.coarseVersion++;
	}

	/** Store-internal: notifies this run's own flush listeners. */
	emitFlush(coarse: boolean): void {
		for (const listener of this.flushListeners) {
			try {
				listener(this, coarse);
			} catch {
				// A renderer's flush listener must not stall the pump's flush cycle.
			}
		}
	}

	private checkBudget(): void {
		if (this.budgetTotal === null || this.budgetExhausted) return;
		if (this.spentTokens() < this.budgetTotal) return;
		this.budgetExhausted = true;
		for (const agent of this.agentsList) agent.cancel("budget");
		this.appendLog(`budget of ${this.budgetTotal} tokens reached; remaining agents are skipped`, "warning");
	}
}

export class PolyphaseStore {
	private readonly pump: UpdatePump;
	private readonly retainRuns: number;
	private readonly keepTranscriptRuns: number;
	private readonly now: () => number;
	private readonly runsById = new Map<string, PolyphaseRun>();
	private readonly listeners = new Set<(change: StoreChange) => void>();
	private seqCounter = 0;

	constructor(options: { pump: UpdatePump; retainRuns: number; keepTranscriptRuns?: number; now?: () => number }) {
		this.pump = options.pump;
		this.retainRuns = options.retainRuns;
		this.keepTranscriptRuns = options.keepTranscriptRuns ?? 5;
		this.now = options.now ?? Date.now;
		this.pump.setFlushHandler((dirty) => this.handleFlush(dirty));
	}

	createRun(init: RunInit): PolyphaseRun {
		const run = new PolyphaseRun(init, {
			pump: this.pump,
			now: this.now,
			nextSeq: () => this.nextSeq(),
			onFinished: (finished) => this.handleRunFinished(finished),
		});
		this.runsById.set(run.id, run);
		this.pump.startHeartbeat(run.id);
		return run;
	}

	getRun(id: string): PolyphaseRun | undefined {
		return this.runsById.get(id);
	}

	/** Running runs newest-first, then finished runs newest-first. */
	runs(): readonly PolyphaseRun[] {
		const all = [...this.runsById.values()];
		const running = all
			.filter((run) => run.status === "running")
			.sort((a, b) => b.startedAt - a.startedAt || b.createSeq - a.createSeq);
		const finished = all.filter((run) => run.status !== "running").sort(finishedNewestFirst);
		return [...running, ...finished];
	}

	/** Newest running run with origin "tool" and kind "subagent" | "workflow". */
	focusRunId(): string | undefined {
		let focus: PolyphaseRun | undefined;
		for (const run of this.runsById.values()) {
			if (run.status !== "running" || run.origin !== "tool") continue;
			if (run.kind !== "subagent" && run.kind !== "workflow") continue;
			if (
				!focus ||
				run.startedAt > focus.startedAt ||
				(run.startedAt === focus.startedAt && run.createSeq > focus.createSeq)
			) {
				focus = run;
			}
		}
		return focus?.id;
	}

	private nextSeq(): number {
		return this.seqCounter++;
	}

	totals(): StoreTotals {
		const totals: StoreTotals = {
			runs: 0,
			running: 0,
			queued: 0,
			active: 0,
			done: 0,
			failed: 0,
			cancelled: 0,
			tokens: 0,
			cost: 0,
		};
		for (const run of this.runsById.values()) {
			totals.runs++;
			switch (run.status) {
				case "running":
					totals.running++;
					break;
				case "done":
					totals.done++;
					break;
				case "failed":
					totals.failed++;
					break;
				case "cancelled":
					totals.cancelled++;
					break;
			}
			totals.tokens += run.spentTokens();
			for (const agent of run.agents) {
				if (agent.status === "queued") totals.queued++;
				if (agent.status === "starting" || agent.status === "running") totals.active++;
				totals.cost += agent.state.usage?.cost.total ?? 0;
				totals.cost += agent.state.liveUsage?.cost.total ?? 0;
			}
		}
		return totals;
	}

	subscribe(listener: (change: StoreChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	cancelAgent(runId: string, index: number, reason: CancelReason = "user"): boolean {
		const run = this.runsById.get(runId);
		const agent = run?.agents[index];
		if (!run || !agent) return false;
		const cancelled = agent.cancel(reason);
		if (cancelled) run.markDirty("coarse");
		return cancelled;
	}

	cancelRun(runId: string, reason: CancelReason = "user"): boolean {
		const run = this.runsById.get(runId);
		if (!run) return false;
		run.cancel(reason);
		return true;
	}

	dispose(): void {
		for (const run of this.runsById.values()) {
			run.cancel("shutdown");
			run.detachParentSignal();
		}
		this.pump.dispose();
		this.notify({ type: "disposed" });
		this.listeners.clear();
	}

	private handleFlush(dirty: ReadonlyMap<string, boolean>): void {
		const runIds: string[] = [];
		let anyCoarse = false;
		for (const [runId, coarse] of dirty) {
			const run = this.runsById.get(runId);
			if (!run) continue;
			run.bumpVersion(coarse);
			run.emitFlush(coarse);
			runIds.push(runId);
			if (coarse) anyCoarse = true;
		}
		if (runIds.length > 0) this.notify({ type: "runs", runIds, coarse: anyCoarse });
	}

	private handleRunFinished(_run: PolyphaseRun): void {
		const finished = [...this.runsById.values()].filter((run) => run.status !== "running").sort(finishedNewestFirst);
		for (let i = this.keepTranscriptRuns; i < finished.length; i++) {
			finished[i]?.dropTranscripts();
		}
		while (finished.length > this.retainRuns) {
			const oldest = finished.pop();
			if (!oldest) break;
			oldest.detachParentSignal();
			this.runsById.delete(oldest.id);
			this.pump.stopHeartbeat(oldest.id);
		}
	}

	private notify(change: StoreChange): void {
		for (const listener of this.listeners) {
			try {
				listener(change);
			} catch {
				// A store subscriber (dock/inspector rendering) must not stall the flush cycle.
			}
		}
	}
}
