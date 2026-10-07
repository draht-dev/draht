import { afterEach, describe, expect, it, vi } from "vitest";
import { toRunResult } from "../../src/core/polyphase/child-events.ts";
import { PolyphaseStore, type RunInit, type StoreChange } from "../../src/core/polyphase/store.ts";
import { type AgentModelInfo, DEFAULT_CHILD_STATE_LIMITS } from "../../src/core/polyphase/types.ts";
import { createUpdatePump, type UpdatePump } from "../../src/core/polyphase/update-pump.ts";
import { agentStart, assistantEnd, assistantStart, thinkingDelta, thinkingEnd, thinkingStart } from "./helpers/wire.ts";

function model(): AgentModelInfo {
	return { source: "inherited", confirmed: false };
}

function baseRunInit(overrides: Partial<RunInit> = {}): RunInit {
	return { id: "run-1", kind: "subagent", origin: "tool", title: "a run", budgetTokens: null, ...overrides };
}

function counter(): () => number {
	let t = 0;
	return () => t++;
}

function makeStore(
	options: {
		intervalMs?: number;
		coarseDelayMs?: number;
		retainRuns?: number;
		keepTranscriptRuns?: number;
		now?: () => number;
	} = {},
): {
	store: PolyphaseStore;
	pump: UpdatePump;
} {
	const pump = createUpdatePump({ intervalMs: options.intervalMs ?? 50, coarseDelayMs: options.coarseDelayMs ?? 10 });
	const store = new PolyphaseStore({
		pump,
		retainRuns: options.retainRuns ?? 20,
		keepTranscriptRuns: options.keepTranscriptRuns,
		now: options.now ?? counter(),
	});
	return { store, pump };
}

describe("LiveAgent status derivation", () => {
	it("goes through queued -> starting -> running -> done", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "worker", task: "do the thing", model: model() });
		const ctx = agent.createRunContext();

		expect(agent.status).toBe("pending");

		ctx.onQueued?.();
		expect(agent.status).toBe("queued");

		agent.reducer.markSpawning();
		ctx.onStart?.({ pid: 123, argv: [] });
		expect(agent.status).toBe("starting");

		agent.reducer.apply(agentStart());
		ctx.onChange?.("coarse");
		expect(agent.status).toBe("running");

		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: "worker", task: "do the thing" }, finish, {
			cancelled: false,
			durationMs: 10,
		});
		ctx.onFinish?.(result);
		expect(agent.status).toBe("done");
	});

	it("is failed when the result has a non-zero exit code", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "worker", task: "t", model: model() });
		const ctx = agent.createRunContext();

		const finish = agent.reducer.finish({ code: 1, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: "worker", task: "t" }, finish, {
			cancelled: false,
			durationMs: 10,
		});
		ctx.onFinish?.(result);
		expect(agent.status).toBe("failed");
	});

	it("is cancelled when the result is cancelled, regardless of exit code", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "worker", task: "t", model: model() });
		const ctx = agent.createRunContext();

		const finish = agent.reducer.finish({ code: 1, signal: null, cancelled: true });
		const result = toRunResult(agent.reducer.state, { agent: "worker", task: "t" }, finish, {
			cancelled: true,
			durationMs: 10,
		});
		ctx.onFinish?.(result);
		expect(agent.status).toBe("cancelled");
	});

	it("is skipped once markSkipped is called, unless already completed", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "worker", task: "t", model: model() });

		agent.markSkipped();
		expect(agent.status).toBe("skipped");

		const ctx = agent.createRunContext();
		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: "worker", task: "t" }, finish, {
			cancelled: false,
			durationMs: 1,
		});
		ctx.onFinish?.(result);
		expect(agent.status).toBe("skipped"); // markSkipped already finalized the agent; complete() is a no-op
	});

	it("markSkipped after complete is a no-op", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "worker", task: "t", model: model() });
		const ctx = agent.createRunContext();

		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: "worker", task: "t" }, finish, {
			cancelled: false,
			durationMs: 1,
		});
		ctx.onFinish?.(result);
		expect(agent.status).toBe("done");

		agent.markSkipped();
		expect(agent.status).toBe("done"); // complete() already finalized the agent; markSkipped() is a no-op
	});
});

describe("run.finish", () => {
	it("turns pending agents into skipped", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "worker", task: "t", model: model() });
		expect(agent.status).toBe("pending");

		run.finish("done");

		expect(agent.status).toBe("skipped");
		expect(run.counts().skipped).toBe(1);
	});
});

describe("cancellation", () => {
	it("cancelAgent aborts only that agent's signal", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const a1 = run.addAgent({ label: "a1", agentType: "w", task: "t", model: model() });
		const a2 = run.addAgent({ label: "a2", agentType: "w", task: "t", model: model() });

		expect(store.cancelAgent(run.id, 0, "user")).toBe(true);
		expect(a1.signal.aborted).toBe(true);
		expect(a1.cancelReason).toBe("user");
		expect(a2.signal.aborted).toBe(false);
		expect(a2.cancelReason).toBeUndefined();
	});

	it("cancelAgent returns false for an unknown run or an out-of-range index", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		run.addAgent({ label: "a1", agentType: "w", task: "t", model: model() });

		expect(store.cancelAgent("missing", 0)).toBe(false);
		expect(store.cancelAgent(run.id, 5)).toBe(false);
	});

	it("cancelRun aborts every agent, the run signal, and propagates the reason", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const a1 = run.addAgent({ label: "a1", agentType: "w", task: "t", model: model() });
		const a2 = run.addAgent({ label: "a2", agentType: "w", task: "t", model: model() });

		expect(store.cancelRun(run.id, "user")).toBe(true);
		expect(a1.cancelReason).toBe("user");
		expect(a2.cancelReason).toBe("user");
		expect(a1.signal.aborted).toBe(true);
		expect(a2.signal.aborted).toBe(true);
		expect(run.signal.aborted).toBe(true);
	});

	it("a parentSignal abort cancels the run with reason 'parent'", () => {
		const { store } = makeStore();
		const controller = new AbortController();
		const run = store.createRun(baseRunInit({ parentSignal: controller.signal }));
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });

		controller.abort();

		expect(agent.cancelReason).toBe("parent");
		expect(agent.signal.aborted).toBe(true);
		expect(run.signal.aborted).toBe(true);
	});

	it("an already-aborted parentSignal cancels immediately at run creation", () => {
		const { store } = makeStore();
		const controller = new AbortController();
		controller.abort();
		const run = store.createRun(baseRunInit({ parentSignal: controller.signal }));
		expect(run.signal.aborted).toBe(true);
	});

	it("a late-added agent after run.cancel inherits the run's cancel reason", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		run.addAgent({ label: "early", agentType: "w", task: "t", model: model() });
		run.cancel("budget");

		const late = run.addAgent({ label: "late", agentType: "w", task: "t", model: model() });

		expect(late.signal.aborted).toBe(true);
		expect(late.cancelReason).toBe("budget");
	});
});

describe("budget", () => {
	it("exhaustion cancels every unfinished agent once, with a single warning log line", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit({ budgetTokens: 10 }));
		const a1 = run.addAgent({ label: "a1", agentType: "w", task: "t", model: model() });
		const a2 = run.addAgent({ label: "a2", agentType: "w", task: "t", model: model() });
		const ctx1 = a1.createRunContext();

		a1.reducer.apply(assistantStart("anthropic", "claude-sonnet-5"));
		const change = a1.reducer.apply(assistantEnd()); // default usage billableTokens 15 >= 10
		if (change !== "none") ctx1.onChange?.(change);

		expect(run.budget.exhausted).toBe(true);
		expect(a1.cancelReason).toBe("budget");
		expect(a2.cancelReason).toBe("budget");

		const warnings = run.log.filter((line) => line.level === "warning" && line.text.includes("budget"));
		expect(warnings).toHaveLength(1);

		// A later dirty signal must not re-trigger the budget warning.
		run.markDirty("fine");
		expect(run.log.filter((line) => line.level === "warning" && line.text.includes("budget"))).toHaveLength(1);
	});

	it("never exhausts when totalTokens is null", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit({ budgetTokens: null }));
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });
		const ctx = agent.createRunContext();
		const change = agent.reducer.apply(assistantEnd());
		if (change !== "none") ctx.onChange?.(change);
		expect(run.budget.exhausted).toBe(false);
	});
});

describe("focusRunId", () => {
	it("picks the newest running run with origin tool and kind subagent or workflow", () => {
		const { store } = makeStore({ now: counter() });
		store.createRun(baseRunInit({ id: "r1", origin: "tool", kind: "subagent" }));
		store.createRun(baseRunInit({ id: "r2", origin: "tool", kind: "workflow" }));
		store.createRun(baseRunInit({ id: "r3", origin: "command", kind: "workflow" }));

		expect(store.focusRunId()).toBe("r2");
	});

	it("ignores command-origin and duet-kind runs, and finished runs", () => {
		const { store } = makeStore({ now: counter() });
		const duet = store.createRun(baseRunInit({ id: "r1", origin: "tool", kind: "duet" }));
		duet.finish("done");
		const finishedTool = store.createRun(baseRunInit({ id: "r2", origin: "tool", kind: "subagent" }));
		finishedTool.finish("done");
		store.createRun(baseRunInit({ id: "r3", origin: "command", kind: "subagent" }));

		expect(store.focusRunId()).toBeUndefined();
	});
});

describe("flush", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("bumps version and coarseVersion, and notifies run flush listeners and store subscribers once", () => {
		vi.useFakeTimers();
		const { store, pump } = makeStore({ intervalMs: 50, coarseDelayMs: 10, now: () => Date.now() });
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });
		const ctx = agent.createRunContext();

		const flushListener = vi.fn();
		run.onFlush(flushListener);
		const subscriber = vi.fn();
		store.subscribe(subscriber);

		const versionBefore = run.version;
		ctx.onQueued?.();
		vi.advanceTimersByTime(10);

		expect(run.version).toBeGreaterThan(versionBefore);
		expect(run.coarseVersion).toBeGreaterThan(0);
		expect(flushListener).toHaveBeenCalledTimes(1);
		expect(flushListener).toHaveBeenCalledWith(run, true);
		expect(subscriber).toHaveBeenCalledTimes(1);
		expect(subscriber).toHaveBeenCalledWith({ type: "runs", runIds: [run.id], coarse: true });

		pump.dispose();
	});
});

describe("dynamic phases", () => {
	it("creates a dynamic phase for an undeclared title and warns exactly once", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit({ phases: [{ title: "plan" }] }));

		const buildIndex = run.enterPhase("build");
		const shipIndex = run.enterPhase("ship");

		expect(run.phases[buildIndex]?.dynamic).toBe(true);
		expect(run.phases[shipIndex]?.dynamic).toBe(true);
		expect(run.phases[0]?.dynamic).toBe(false);

		const warnings = run.log.filter((line) => line.level === "warning");
		expect(warnings).toHaveLength(1);
	});

	it("resolves an existing phase by title without creating a duplicate", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit({ phases: [{ title: "plan" }, { title: "verify" }] }));
		expect(run.resolvePhase("verify")).toBe(1);
		expect(run.phases).toHaveLength(2);
	});

	it("resolvePhase(undefined) returns currentPhase", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit({ phases: [{ title: "plan" }] }));
		run.enterPhase("plan");
		expect(run.resolvePhase(undefined)).toBe(0);
	});

	it("caps dynamic phases at 100 and throws past the limit, without growing further", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit({ phases: [{ title: "plan" }] }));
		for (let i = 0; i < 99; i++) run.enterPhase(`dynamic-${i}`);
		expect(run.phases).toHaveLength(100);

		expect(() => run.enterPhase("one-too-many")).toThrow(/phase cap reached/);
		expect(run.phases).toHaveLength(100);

		// A title that already exists still resolves; only growth past the cap is rejected.
		expect(run.resolvePhase("dynamic-0")).toBe(1);

		const warnings = run.log.filter((line) => line.level === "warning");
		expect(warnings.map((line) => line.text)).toContainEqual(expect.stringContaining("100-phase cap"));
	});
});

describe("retention", () => {
	/** Each item is 7000 chars, closed (`thinkingEnd`), well under `maxItemChars` but five of them exceed `finishedMaxChars`. */
	function finishRunWithTranscript(store: PolyphaseStore, id: string): void {
		const run = store.createRun(baseRunInit({ id }));
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });
		const ctx = agent.createRunContext();
		for (let i = 0; i < 5; i++) {
			const content = "x".repeat(7_000);
			for (const record of [thinkingStart(0), thinkingDelta(0, content), thinkingEnd(0, content)]) {
				const change = agent.reducer.apply(record);
				if (change !== "none") ctx.onChange?.(change);
			}
		}
		run.finish("done");
	}

	it("trims the transcript on finish, drops it beyond keepTranscriptRuns, and evicts beyond retainRuns", () => {
		const { store } = makeStore({ retainRuns: 3, keepTranscriptRuns: 1 });

		finishRunWithTranscript(store, "r1");
		const r1State = store.getRun("r1")?.agents[0]?.state;
		expect(r1State?.transcript.length).toBeGreaterThan(0);
		expect(r1State?.transcriptChars).toBeLessThanOrEqual(DEFAULT_CHILD_STATE_LIMITS.finishedMaxChars);
		expect(r1State?.droppedItems).toBeGreaterThan(0);

		finishRunWithTranscript(store, "r2");
		expect(store.getRun("r1")?.agents[0]?.state.transcript.length).toBe(0);
		expect(store.getRun("r2")?.agents[0]?.state.transcript.length).toBeGreaterThan(0);

		finishRunWithTranscript(store, "r3");
		finishRunWithTranscript(store, "r4");

		expect(store.getRun("r1")).toBeUndefined();
		expect(store.runs()).toHaveLength(3);
		expect(store.runs().map((run) => run.id)).toEqual(["r4", "r3", "r2"]);
	});

	it("keeps transcripts for the newest 5 finished runs by default, dropping only the oldest", () => {
		const { store } = makeStore({ retainRuns: 10 });

		for (const id of ["r1", "r2", "r3", "r4", "r5", "r6"]) {
			finishRunWithTranscript(store, id);
		}

		expect(store.getRun("r1")?.agents[0]?.state.transcript.length).toBe(0);
		for (const id of ["r2", "r3", "r4", "r5", "r6"]) {
			expect(store.getRun(id)?.agents[0]?.state.transcript.length).toBeGreaterThan(0);
		}
	});

	it("dropTranscripts is idempotent: a second call does not bump agent state version again", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });

		run.dropTranscripts();
		const versionAfterFirst = agent.state.version;

		run.dropTranscripts();
		expect(agent.state.version).toBe(versionAfterFirst);
	});

	it("re-trims a late-completing agent to the finished bound when it settles after its run finished", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });
		const ctx = agent.createRunContext();
		agent.reducer.apply(agentStart()); // "running", so run.finish() does not mark it skipped
		run.finish("cancelled");

		for (let i = 0; i < 5; i++) {
			const content = "x".repeat(7_000);
			for (const record of [thinkingStart(0), thinkingDelta(0, content), thinkingEnd(0, content)]) {
				const change = agent.reducer.apply(record);
				if (change !== "none") ctx.onChange?.(change);
			}
		}
		expect(agent.state.transcriptChars).toBeGreaterThan(DEFAULT_CHILD_STATE_LIMITS.finishedMaxChars);

		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: true });
		const result = toRunResult(agent.reducer.state, { agent: "w", task: "t" }, finish, {
			cancelled: true,
			durationMs: 10,
		});
		ctx.onFinish?.(result);

		expect(agent.state.transcriptChars).toBeLessThanOrEqual(DEFAULT_CHILD_STATE_LIMITS.finishedMaxChars);
	});

	it("drops a late-completing agent's transcript entirely when the run's transcripts were already dropped", () => {
		const { store } = makeStore();
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });
		const ctx = agent.createRunContext();
		agent.reducer.apply(agentStart()); // "running", so run.finish() does not mark it skipped
		agent.reducer.apply(thinkingStart(0));
		agent.reducer.apply(thinkingDelta(0, "some thinking"));
		run.finish("cancelled");
		run.dropTranscripts();

		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: true });
		const result = toRunResult(agent.reducer.state, { agent: "w", task: "t" }, finish, {
			cancelled: true,
			durationMs: 10,
		});
		ctx.onFinish?.(result);

		expect(agent.state.transcript.length).toBe(0);
		expect(agent.state.transcriptChars).toBe(0);
	});
});

describe("dispose", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("cancels every run with 'shutdown', emits disposed once, and clears every pump timer", () => {
		vi.useFakeTimers();
		const pump = createUpdatePump({ intervalMs: 50 });
		const store = new PolyphaseStore({ pump, retainRuns: 20 });
		const run = store.createRun(baseRunInit());
		const agent = run.addAgent({ label: "a", agentType: "w", task: "t", model: model() });

		const events: StoreChange[] = [];
		store.subscribe((change) => events.push(change));

		store.dispose();

		expect(agent.cancelReason).toBe("shutdown");
		expect(run.signal.aborted).toBe(true);
		expect(events).toEqual([{ type: "disposed" }]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
