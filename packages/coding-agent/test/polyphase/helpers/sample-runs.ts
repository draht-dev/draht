import type { ChildExit, ChildWireRecord } from "../../../src/core/polyphase/child-events.ts";
import { toRunResult } from "../../../src/core/polyphase/child-events.ts";
import { type LiveAgent, type PolyphaseRun, PolyphaseStore, type RunInit } from "../../../src/core/polyphase/store.ts";
import type { AgentModelInfo, AgentRunContext, RunStatus } from "../../../src/core/polyphase/types.ts";
import { createUpdatePump } from "../../../src/core/polyphase/update-pump.ts";
import {
	agentStart,
	assistantEnd,
	assistantStart,
	blockedToolEnd,
	sessionHeader,
	settled,
	textDelta,
	textEnd,
	textStart,
	thinkingDelta,
	thinkingStart,
	toolEnd,
	toolStart,
} from "./wire.ts";

/**
 * Builders that feed real `ChildWireRecord`s through real `LiveAgent`s, exercising the same
 * `createRunContext()` hooks `child-process.ts` drives. Used by wave-3 render and inspector tests.
 */

export interface SampleRun {
	store: PolyphaseStore;
	run: PolyphaseRun;
	agents: LiveAgent[];
	/** Finishes the run with `status` (default "done"). `chainRun({ failed: true })` already calls
	 *  `run.finish("failed", ...)` itself before returning, so calling this again is a no-op. */
	finish(status?: RunStatus, error?: string): void;
	/** Disposes the store, stopping its heartbeat and flush timers. */
	dispose(): void;
}

export interface SampleRunOptions {
	/** Defaults to a fixed deterministic clock so elapsed-time text is reproducible across runs. */
	now?: () => number;
}

const SAMPLE_CLOCK_EPOCH = 1_700_000_000_000;

/** A fresh counter starting at a fixed epoch, advancing 1s per call. */
function deterministicClock(): () => number {
	let t = SAMPLE_CLOCK_EPOCH;
	return () => {
		t += 1_000;
		return t;
	};
}

export function createSampleStore(now: () => number = Date.now): PolyphaseStore {
	const pump = createUpdatePump({ intervalMs: 250 });
	return new PolyphaseStore({ pump, retainRuns: 20, now });
}

function confirmedModel(provider = "anthropic", id = "claude-sonnet-5"): AgentModelInfo {
	return { source: "inherited", provider, id, confirmed: true };
}

function pendingModel(requested = "claude-sonnet-5"): AgentModelInfo {
	return { source: "inherited", requested, confirmed: false };
}

/** Applies `records` through the agent's reducer and forwards every real change via `onChange`. */
function drive(agent: LiveAgent, ctx: AgentRunContext, records: readonly ChildWireRecord[]): void {
	for (const record of records) {
		const change = agent.reducer.apply(record);
		if (change !== "none") ctx.onChange?.(change);
	}
}

function queue(ctx: AgentRunContext): void {
	ctx.onQueued?.();
}

function start(ctx: AgentRunContext): void {
	ctx.onStart?.({ pid: 4242, argv: ["draht", "--mode", "json"] });
}

function settle(agent: LiveAgent, ctx: AgentRunContext, exit: Partial<ChildExit> = {}): void {
	const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false, ...exit });
	const result = toRunResult(
		agent.reducer.state,
		{ agent: agent.agentType, task: agent.task, step: agent.step },
		finish,
		{
			cancelled: exit.cancelled ?? false,
			structured: agent.reducer.state.structured,
			durationMs: 1_000,
		},
	);
	ctx.onFinish?.(result);
}

const DONE_TEXT = "All checks pass.\nSTATUS: DONE";

function doneRecords(provider = "anthropic", model = "claude-sonnet-5"): ChildWireRecord[] {
	return [
		sessionHeader(),
		agentStart(),
		assistantStart(provider, model),
		textStart(0),
		textDelta(0, "All checks pass.\n"),
		textDelta(0, "STATUS: DONE"),
		textEnd(0, DONE_TEXT),
		assistantEnd({ provider, model, text: DONE_TEXT }),
		settled(),
	];
}

function runningTailRecords(provider = "anthropic", model = "claude-sonnet-5"): ChildWireRecord[] {
	return [
		sessionHeader(),
		agentStart(),
		assistantStart(provider, model),
		thinkingStart(0),
		thinkingDelta(0, "Checking the diff for edge cases around auth."),
		toolStart("call-1", "bash", { command: "npm test -- auth" }),
		toolEnd("call-1", "bash", "12 passed", false),
		toolStart("call-2", "bash", { command: "git push" }),
	];
}

function blockedTailRecords(): ChildWireRecord[] {
	return [blockedToolEnd("call-2", "bash", "git push")];
}

function failingRecords(provider = "anthropic", model = "claude-sonnet-5"): ChildWireRecord[] {
	return [
		sessionHeader(),
		agentStart(),
		assistantStart(provider, model),
		textStart(0),
		textDelta(0, "The fix did not apply cleanly."),
		textEnd(0, "The fix did not apply cleanly."),
		assistantEnd({
			provider,
			model,
			text: "The fix did not apply cleanly.",
			stopReason: "error",
			errorMessage: "patch failed",
		}),
	];
}

function makeStoreRun(init: RunInit, options: SampleRunOptions = {}): { store: PolyphaseStore; run: PolyphaseRun } {
	const store = createSampleStore(options.now ?? deterministicClock());
	const run = store.createRun(init);
	return { store, run };
}

/** Three agents: one done (with a STATUS line), one running (thinking + tool tail + a blocked call), one queued. */
export function parallelRun(options: SampleRunOptions = {}): SampleRun {
	const { store, run } = makeStoreRun(
		{
			id: "run-parallel",
			kind: "subagent",
			origin: "tool",
			mode: "parallel",
			title: "review the diff from three angles",
			budgetTokens: null,
		},
		options,
	);

	const reviewer1 = run.addAgent({
		label: "reviewer#1",
		agentType: "reviewer",
		task: "review for correctness",
		model: confirmedModel(),
	});
	const ctx1 = reviewer1.createRunContext();
	start(ctx1);
	drive(reviewer1, ctx1, doneRecords());
	settle(reviewer1, ctx1, { code: 0 });

	const reviewer2 = run.addAgent({
		label: "reviewer#2",
		agentType: "reviewer",
		task: "review for style",
		model: confirmedModel(),
	});
	const ctx2 = reviewer2.createRunContext();
	start(ctx2);
	drive(reviewer2, ctx2, runningTailRecords());
	drive(reviewer2, ctx2, blockedTailRecords());

	const reviewer3 = run.addAgent({
		label: "reviewer#3",
		agentType: "reviewer",
		task: "review for security",
		model: pendingModel(),
	});
	const ctx3 = reviewer3.createRunContext();
	queue(ctx3);

	return {
		store,
		run,
		agents: [reviewer1, reviewer2, reviewer3],
		finish: (status = "done", error) => run.finish(status, error),
		dispose: () => store.dispose(),
	};
}

/** One agent, either still running or finished ("done" with a STATUS line), depending on `final`. */
export function singleRun(options: { final?: boolean } & SampleRunOptions = {}): SampleRun {
	const { store, run } = makeStoreRun(
		{
			id: "run-single",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "investigate the flaky test",
			budgetTokens: null,
		},
		options,
	);

	const agent = run.addAgent({
		label: "investigator",
		agentType: "investigator",
		task: "find the flake",
		model: confirmedModel(),
	});
	const ctx = agent.createRunContext();
	start(ctx);
	if (options.final) {
		drive(agent, ctx, doneRecords());
		settle(agent, ctx, { code: 0 });
	} else {
		drive(agent, ctx, runningTailRecords());
	}

	return {
		store,
		run,
		agents: [agent],
		finish: (status = "done", error) => run.finish(status, error),
		dispose: () => store.dispose(),
	};
}

/** A chain of three steps: done, running, pending — or, when `failed`, a failed step 1 that skips step 2. */
export function chainRun(options: { failed?: boolean } & SampleRunOptions = {}): SampleRun {
	const { store, run } = makeStoreRun(
		{
			id: "run-chain",
			kind: "subagent",
			origin: "tool",
			mode: "chain",
			title: "fix then verify",
			budgetTokens: null,
		},
		options,
	);

	const step1 = run.addAgent({
		label: "step 1",
		agentType: "fixer",
		task: "fix the bug",
		step: 1,
		model: confirmedModel(),
	});
	const ctx1 = step1.createRunContext();
	start(ctx1);

	if (options.failed) {
		drive(step1, ctx1, failingRecords());
		settle(step1, ctx1, { code: 1 });
		const step2 = run.addAgent({
			label: "step 2",
			agentType: "verifier",
			task: "verify the fix",
			step: 2,
			model: pendingModel(),
		});
		run.finish("failed", "step 1 failed");
		return {
			store,
			run,
			agents: [step1, step2],
			finish: (status = "failed", error) => run.finish(status, error),
			dispose: () => store.dispose(),
		};
	}

	drive(step1, ctx1, doneRecords());
	settle(step1, ctx1, { code: 0 });

	const step2 = run.addAgent({
		label: "step 2",
		agentType: "verifier",
		task: "verify the fix",
		step: 2,
		model: confirmedModel(),
	});
	const ctx2 = step2.createRunContext();
	start(ctx2);
	drive(step2, ctx2, runningTailRecords());

	const step3 = run.addAgent({
		label: "step 3",
		agentType: "reporter",
		task: "write the report",
		step: 3,
		model: pendingModel(),
	});

	return {
		store,
		run,
		agents: [step1, step2, step3],
		finish: (status = "done", error) => run.finish(status, error),
		dispose: () => store.dispose(),
	};
}

/** Three declared phases plus one dynamic phase, log lines, a budget, and one cancelled agent. */
export function workflowRun(options: SampleRunOptions = {}): SampleRun {
	const { store, run } = makeStoreRun(
		{
			id: "run-workflow",
			kind: "workflow",
			origin: "command",
			title: "/release v1.2.3",
			workflow: {
				name: "release",
				description: "Ship a release",
				source: "project",
				path: ".draht/workflows/release.js",
				args: "v1.2.3",
			},
			phases: [{ title: "plan" }, { title: "implement" }, { title: "verify" }],
			budgetTokens: 10_000,
		},
		options,
	);

	run.enterPhase("plan");
	run.appendLog("planning the release");
	const planner = run.addAgent({
		label: "planner",
		agentType: "planner",
		task: "plan the release",
		phase: 0,
		model: confirmedModel(),
	});
	const plannerCtx = planner.createRunContext();
	start(plannerCtx);
	drive(planner, plannerCtx, doneRecords());
	settle(planner, plannerCtx, { code: 0 });

	run.enterPhase("implement");
	run.appendLog("implementing the release notes");
	const implementer = run.addAgent({
		label: "implementer",
		agentType: "implementer",
		task: "write the release notes",
		phase: 1,
		model: confirmedModel(),
	});
	const implementerCtx = implementer.createRunContext();
	start(implementerCtx);
	drive(implementer, implementerCtx, runningTailRecords());
	implementer.cancel("user");
	settle(implementer, implementerCtx, { cancelled: true, code: 1 });

	run.enterPhase("verify");
	run.enterPhase("cleanup"); // not declared in meta.phases: a dynamic phase, warned once

	const cleaner = run.addAgent({
		label: "cleanup",
		agentType: "cleanup",
		task: "remove temp files",
		phase: 3,
		model: confirmedModel(),
	});
	const cleanerCtx = cleaner.createRunContext();
	start(cleanerCtx);
	drive(cleaner, cleanerCtx, runningTailRecords());

	return {
		store,
		run,
		agents: [planner, implementer, cleaner],
		finish: (status = "done", error) => run.finish(status, error),
		dispose: () => store.dispose(),
	};
}

/** `n` agents spread across done, running and queued, for scale (snapshot/render) tests. */
export function largeRun(n: number, options: SampleRunOptions = {}): SampleRun {
	const { store, run } = makeStoreRun(
		{
			id: "run-large",
			kind: "subagent",
			origin: "tool",
			mode: "parallel",
			title: `parallel review across ${n} agents`,
			budgetTokens: null,
		},
		options,
	);

	const agents: LiveAgent[] = [];
	for (let i = 0; i < n; i++) {
		const agent = run.addAgent({
			label: `agent#${i}`,
			agentType: "worker",
			task: `work on part ${i}`,
			model: i % 3 === 2 ? pendingModel() : confirmedModel(),
		});
		const ctx = agent.createRunContext();
		if (i % 3 === 0) {
			start(ctx);
			drive(agent, ctx, doneRecords());
			settle(agent, ctx, { code: 0 });
		} else if (i % 3 === 1) {
			start(ctx);
			drive(agent, ctx, runningTailRecords());
		} else {
			queue(ctx);
		}
		agents.push(agent);
	}

	return {
		store,
		run,
		agents,
		finish: (status = "done", error) => run.finish(status, error),
		dispose: () => store.dispose(),
	};
}
