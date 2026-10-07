import { getKeybindings, KeybindingsManager, setKeybindings, type TUI, visibleWidth } from "@draht/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import type { ChildWireRecord } from "../../src/core/polyphase/child-events.ts";
import { toRunResult } from "../../src/core/polyphase/child-events.ts";
import { buildDetails } from "../../src/core/polyphase/details.ts";
import { AgentLimiter } from "../../src/core/polyphase/limiter.ts";
import type { PolyphaseSession } from "../../src/core/polyphase/session.ts";
import { resolvePolyphaseSettings } from "../../src/core/polyphase/settings.ts";
import type { PolyphaseStore } from "../../src/core/polyphase/store.ts";
import type { InspectorDeps, InspectorInitialView } from "../../src/core/polyphase/ui/inspector.ts";
import { PolyphaseInspector } from "../../src/core/polyphase/ui/inspector.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createSampleStore, largeRun, parallelRun, singleRun, workflowRun } from "./helpers/sample-runs.ts";
import {
	agentStart,
	assistantEnd,
	assistantStart,
	sessionHeader,
	settled,
	textDelta,
	textEnd,
	textStart,
	thinkingDelta,
	thinkingStart,
	toolEnd,
	toolStart,
} from "./helpers/wire.ts";

initTheme("dark");

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	x: "x",
	X: "X",
	f: "f",
	ctrlT: "\x14",
	ctrlO: "\x0f",
	altA: "\x1ba",
};

function testSession(sample: { store: PolyphaseStore; dispose(): void }, capacity = 4): PolyphaseSession {
	const limiter = new AgentLimiter(capacity);
	return {
		store: sample.store,
		limiter,
		settings: () => resolvePolyphaseSettings(undefined),
		refreshSettings: () => {},
		permissionMode: () => "default",
		setPermissionModeProvider: () => {},
		onParentPrompt: () => () => {},
		notifyParentPrompt: () => {},
		setInspectorOpen: () => {},
		disposed: false,
		dispose: () => sample.dispose(),
	};
}

function fakeTui(rows = 24, columns = 80): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	const tui = { terminal: { rows, columns }, requestRender } as unknown as TUI;
	return { tui, requestRender };
}

function buildDeps(overrides: Partial<InspectorDeps> & { tui?: TUI } = {}): InspectorDeps {
	return {
		session: overrides.session ?? testSession(singleRun()),
		tui: overrides.tui ?? fakeTui().tui,
		theme,
		keybindings: overrides.keybindings ?? new KeybindingsManager(KEYBINDINGS),
		getArchivedRuns: overrides.getArchivedRuns ?? (() => []),
		getSavedWorkflows: overrides.getSavedWorkflows ?? (() => []),
		initial: overrides.initial ?? { view: "auto" },
		showThinking: overrides.showThinking ?? true,
		close: overrides.close ?? vi.fn(),
		insertCommand: overrides.insertCommand ?? vi.fn(),
	};
}

function out(inspector: PolyphaseInspector, width = 80): string {
	return inspector
		.render(width)
		.map((line) => stripAnsi(line))
		.join("\n");
}

/** `out()` minus the border lines: the agent detail header's right side (§12.2) tracks the agent's
 * current activity live, even while the transcript body below is paused, so checks for what a pause
 * keeps stable must not look at the border. */
function transcriptBodyOf(rendered: string): string {
	return rendered
		.split("\n")
		.filter((line) => !line.startsWith("┌") && !line.startsWith("└"))
		.join("\n");
}

const disposables: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposables.splice(0)) dispose();
});

describe("initial view", () => {
	it("opens the run view, with the first running agent selected, when exactly one run is live", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "auto" } });
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("investigate the flaky test");
		expect(out(inspector)).not.toContain("polyphase ·");
	});

	it("selects the first running agent, not just the first agent, when a run is live", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "run", runId: sample.run.id },
		});
		const inspector = new PolyphaseInspector(deps);

		// reviewer#1 is done, reviewer#2 is running, reviewer#3 is queued: the cursor must land on
		// reviewer#2, the first running agent, not on reviewer#1.
		expect(out(inspector)).toContain("› ● reviewer#2");
	});

	it("opens the runs view when several runs are live", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const runA = store.createRun({ id: "a", kind: "subagent", origin: "tool", title: "run a", budgetTokens: null });
		runA.addAgent({ label: "a1", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });
		const runB = store.createRun({ id: "b", kind: "subagent", origin: "tool", title: "run b", budgetTokens: null });
		runB.addAgent({ label: "b1", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });

		const deps = buildDeps({ session: testSession({ store, dispose: () => store.dispose() }) });
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("polyphase · 2 live");
	});

	it("opens the (empty) runs view when there are no live runs", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const deps = buildDeps({ session: testSession({ store, dispose: () => store.dispose() }) });
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("polyphase · 0 live");
		expect(out(inspector)).toContain("No agents yet.");
	});
});

describe("runs view row layout", () => {
	it("keeps the cursor, glyph and a readable slice of the title visible as width narrows", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "runs" } });
		const inspector = new PolyphaseInspector(deps);

		for (const width of [60, 80, 120]) {
			const rendered = out(inspector, width);
			const selectedLine = rendered.split("\n").find((line) => line.includes("›"));
			if (!selectedLine) throw new Error(`expected a selected row at width ${width}`);
			expect(selectedLine).toContain("› ");
			// A readable slice of the run title ("review the diff from three angles"), not squeezed to
			// nothing by the fixed subtitle/counts/duration/tokens/cost columns.
			expect(selectedLine).toContain("review the diff");
		}
	});

	it("separates the status glyph from the title by exactly one space, matching the run-view agent rows", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "runs" } });
		const inspector = new PolyphaseInspector(deps);

		const selectedLine = out(inspector)
			.split("\n")
			.find((line) => line.includes("review the diff"));
		if (!selectedLine) throw new Error("expected the selected run row");
		expect(selectedLine).toMatch(/› \S review the diff/);
	});
});

describe("runs view selection stability", () => {
	it("tracks the selection by run id from the first render, so a newly inserted run above does not change what enter opens", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const runB = store.createRun({ id: "b", kind: "subagent", origin: "tool", title: "run b", budgetTokens: null });
		runB.addAgent({ label: "b1", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });

		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			initial: { view: "runs" },
		});
		const inspector = new PolyphaseInspector(deps);

		// First render only, no arrow key pressed: before the fix, the selection was tracked purely by
		// index until the user pressed up/down.
		out(inspector);

		// A newer live run sorts above "b" (store.runs() sorts running runs newest-first), so "a" now
		// occupies the index "b" held when it was selected.
		const runA = store.createRun({ id: "a", kind: "subagent", origin: "tool", title: "run a", budgetTokens: null });
		runA.addAgent({ label: "a1", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });

		inspector.handleInput(KEYS.enter);
		expect(out(inspector)).toContain("run b");
	});
});

describe("saved workflows list", () => {
	it("abbreviates the source column to 'proj'/'user', as in the §12.2 mockup", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			getSavedWorkflows: () => [
				{ name: "review-pr", description: "Review a change", source: "project", valid: true },
				{ name: "triage", description: "Triage open issues", source: "user", valid: true },
			],
			initial: { view: "runs" },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector, 80);
		const lines = rendered.split("\n");
		const reviewLine = lines.find((line) => line.includes("review-pr"));
		const triageLine = lines.find((line) => line.includes("triage"));
		expect(reviewLine).toContain("proj");
		// The pre-fix column (6 columns wide, raw `saved.source`) truncated "project" to "projec";
		// the fix shows the abbreviated "proj" instead, so this string must not appear at all.
		expect(reviewLine).not.toContain("projec");
		expect(triageLine).toContain("user");
	});
});

describe("subagent run title", () => {
	it("shows the agent count only once, in the subtitle, not in the title", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const run = store.createRun({
			id: "run-parallel-2",
			kind: "subagent",
			origin: "tool",
			mode: "parallel",
			title: "subagent parallel · 2 agents",
			budgetTokens: null,
		});
		run.addAgent({ label: "a1", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });
		run.addAgent({ label: "a2", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });

		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			initial: { view: "runs" },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector, 100);
		const row = rendered.split("\n").find((line) => line.includes("subagent parallel"));
		if (!row) throw new Error("expected the subagent parallel row");
		expect(row).toContain("2 agents");
		// Before the fix, the title cell also carried " · 2 agents", doubling the count.
		expect(row.match(/2 agents/g)?.length).toBe(1);
	});
});

describe("workflow phase marker", () => {
	it("shows the current-phase marker while running, but not once the run has finished", () => {
		const sample = workflowRun();
		disposables.push(sample.dispose);
		const session = testSession(sample);

		const runningRuns = new PolyphaseInspector(buildDeps({ session, initial: { view: "runs" } }));
		const runningRow = out(runningRuns)
			.split("\n")
			.find((line) => line.includes("workflow release"));
		if (!runningRow) throw new Error("expected the workflow run row");
		expect(runningRow).toContain("▸ cleanup");

		const runningHeader = new PolyphaseInspector(
			buildDeps({ session, initial: { view: "run", runId: sample.run.id } }),
		);
		expect(out(runningHeader).split("\n")[0]).toContain("▸ cleanup");

		sample.finish("done");

		const finishedRuns = new PolyphaseInspector(buildDeps({ session, initial: { view: "runs" } }));
		const finishedRow = out(finishedRuns)
			.split("\n")
			.find((line) => line.includes("workflow release"));
		if (!finishedRow) throw new Error("expected the workflow run row");
		expect(finishedRow).not.toContain("▸");

		const finishedHeader = new PolyphaseInspector(
			buildDeps({ session, initial: { view: "run", runId: sample.run.id } }),
		);
		expect(out(finishedHeader).split("\n")[0]).not.toContain("▸");
	});
});

describe("drill-down, back and tab cycling", () => {
	it("drills from runs into a run into agent detail, and back with escape, closing from the runs view", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const close = vi.fn();
		const deps = buildDeps({ session: testSession(sample), initial: { view: "runs" }, close });
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("polyphase ·");

		inspector.handleInput(KEYS.enter);
		expect(out(inspector)).toContain("review the diff from three angles");

		// reviewer#1 is done, reviewer#2 is running: the run view auto-selects reviewer#2. Only the
		// agent detail view renders a "task" line and a follow/pause footer, so these are markers that
		// enter actually drilled in, not just a run view that happens to list reviewer#2's label.
		inspector.handleInput(KEYS.enter);
		const detailView = out(inspector);
		expect(detailView).toContain("task  review for style");
		expect(detailView).toContain("following");

		inspector.handleInput(KEYS.escape);
		expect(out(inspector)).toContain("review the diff from three angles");

		inspector.handleInput(KEYS.escape);
		expect(out(inspector)).toContain("polyphase ·");

		inspector.handleInput(KEYS.escape);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("cycles agents with tab in the run view and in the detail view", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		inspector.handleInput(KEYS.tab); // reviewer#2 -> reviewer#3
		// The run view's cursor glyph confirms tab actually moved the selection before we drill in.
		expect(out(inspector)).toContain("› ◌ reviewer#3");

		inspector.handleInput(KEYS.enter);
		const reviewer3Detail = out(inspector);
		expect(reviewer3Detail).toContain("task  review for security");
		expect(reviewer3Detail).toContain("following");

		inspector.handleInput(KEYS.tab); // reviewer#3 -> wraps to reviewer#1
		const reviewer1Detail = out(inspector);
		expect(reviewer1Detail).toContain("task  review for correctness");
		expect(reviewer1Detail).not.toContain("review for security");
		expect(reviewer1Detail).not.toContain("review for style");

		inspector.handleInput(KEYS.shiftTab); // back to reviewer#3
		const backToReviewer3 = out(inspector);
		expect(backToReviewer3).toContain("task  review for security");
		expect(backToReviewer3).not.toContain("review for correctness");
	});
});

describe("agent detail header", () => {
	it("appends the agent's phase title for a workflow run", () => {
		const sample = workflowRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("planner · planner · plan");
	});

	it("singularizes 'turn' and 'tool' for a count of exactly one", () => {
		// singleRun()'s live tail has exactly one assistant turn (one message_start) and two tool
		// calls, so "turns" stays plural but "tool" must not read "1 tools".
		const sample = singleRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector);
		expect(rendered).toContain("1 turn ·");
		expect(rendered).not.toContain("1 turns");
	});
});

describe("run view agent rows", () => {
	it("shows an elapsed duration and falls back to the output's first line for a finished agent with no STATUS line", () => {
		// A deterministic clock advancing 1s per call, so `markSpawning`/`finish` (the same two calls
		// `child-process.ts` makes outside `ctx`) produce a real, reproducible elapsed time.
		let t = 1_700_000_000_000;
		const now = () => {
			t += 1_000;
			return t;
		};
		const store = createSampleStore(now);
		disposables.push(() => store.dispose());
		const run = store.createRun({
			id: "run-done-no-status",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "tidy the imports",
			budgetTokens: null,
		});
		const agent = run.addAgent({
			label: "tidier",
			agentType: "tidier",
			task: "tidy the imports",
			model: { source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: true },
		});
		const ctx = agent.createRunContext();
		agent.reducer.markSpawning();
		ctx.onStart?.({ pid: 1, argv: [] });
		const text = "Removed three unused imports.";
		const apply = (record: ChildWireRecord) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		apply(sessionHeader());
		apply(agentStart());
		apply(assistantStart("anthropic", "claude-sonnet-5"));
		apply(textStart(0));
		apply(textDelta(0, text));
		apply(textEnd(0, text));
		apply(assistantEnd({ provider: "anthropic", model: "claude-sonnet-5", text }));
		apply(settled());
		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(
			agent.reducer.state,
			{ agent: agent.agentType, task: agent.task, step: agent.step },
			finish,
			{ cancelled: false, structured: agent.reducer.state.structured, durationMs: 7_000 },
		);
		ctx.onFinish?.(result);

		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			initial: { view: "run", runId: run.id },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector);
		expect(rendered).toContain("Removed three unused imports.");
		const row = rendered.split("\n").find((line) => line.includes("tidier"));
		if (!row) throw new Error("expected a row for the 'tidier' agent");
		// A finished agent's row must show elapsed time, not a blank duration column.
		expect(row).toMatch(/\d+:\d{2}/);
	});
});

describe("follow / pause", () => {
	it("does not get stuck paused when f is pressed against an empty transcript", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const run = store.createRun({
			id: "run-empty",
			kind: "subagent",
			origin: "tool",
			title: "empty",
			budgetTokens: null,
		});
		run.addAgent({ label: "a1", agentType: "x", task: "t", model: { source: "child-default", confirmed: false } });

		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			initial: { view: "agent", runId: "run-empty", agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("following");

		inspector.handleInput(KEYS.f);
		const afterF = out(inspector);
		// There is nothing to anchor a pause to: `f` must stay a no-op, not flip to a paused state that
		// `scrollTranscript` can never resolve back to following (it only resumes once the pinned end
		// line reaches the total, which an undefined anchor can never do).
		expect(afterF).toContain("following");
		expect(afterF).not.toContain("paused");
	});

	it("follows the tail, pauses on scroll-up keeping the position as items arrive, and resumes with f", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const agent = sample.agents[0];
		if (!agent) throw new Error("expected an agent");
		const ctx = agent.createRunContext();

		const applyStep = (i: number) => {
			const apply = (record: ReturnType<typeof toolStart>) => {
				const change = agent.reducer.apply(record);
				if (change !== "none") ctx.onChange?.(change);
			};
			apply(toolStart(`call-${i}`, "bash", { command: `step ${i}` }));
			apply(toolEnd(`call-${i}`, "bash", `output ${i}`, false));
		};

		// 500 transcript items: past ChildStateLimits.maxItems (400), so this also exercises the
		// store's transcript cap and the "… N earlier items not kept" path inside the inspector.
		for (let i = 0; i < 500; i++) applyStep(i);

		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("step 499");
		expect(out(inspector)).toContain("following");

		inspector.handleInput(KEYS.up);
		const pausedView = out(inspector);
		expect(pausedView).toContain("paused");

		for (let i = 500; i < 520; i++) applyStep(i);

		const stillPaused = out(inspector);
		expect(stillPaused).toContain("paused");
		// The absolute window is pinned: whatever was visible right after pausing stays visible in the
		// transcript body as later items arrive, so the new items must not have pushed it out.
		let sawStepLine = false;
		for (const line of transcriptBodyOf(pausedView).split("\n")) {
			if (line.includes("step")) {
				expect(transcriptBodyOf(stillPaused)).toContain(line);
				sawStepLine = true;
				break;
			}
		}
		expect(sawStepLine).toBe(true);
		expect(transcriptBodyOf(stillPaused)).not.toContain("step 519");

		inspector.handleInput(KEYS.f);
		expect(out(inspector)).toContain("step 519");
		expect(out(inspector)).toContain("following");
	});

	it("does not blank the transcript when scrolling up past the top of a short run", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		for (let i = 0; i < 50; i++) inspector.handleInput(KEYS.up);

		const rendered = out(inspector);
		expect(rendered).toContain("thinking");
		expect(rendered).not.toContain("paused");
	});

	it("keeps a pinned line visible across evictions of multi-line items while paused", () => {
		// A regression test for a pin that was anchored to an absolute line index and corrected for
		// eviction by counting *items* dropped, not *lines* dropped: once evicted items spanned more
		// than one line (a multi-line text item, say), the correction undershot and the paused view
		// silently drifted forward as new output evicted old items.
		const sample = singleRun();
		disposables.push(sample.dispose);
		const agent = sample.agents[0];
		if (!agent) throw new Error("expected an agent");
		const ctx = agent.createRunContext();
		const apply = (record: ChildWireRecord) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		const step = (i: number) => {
			apply(toolStart(`call-${i}`, "bash", { command: `step ${i}` }));
			apply(toolEnd(`call-${i}`, "bash", `output ${i}`, false));
			// Single unbroken tokens (no internal spaces), so word-wrap cannot split "PARA<i>-<line>"
			// across two rendered lines and break the substring match below.
			const paragraph = Array.from({ length: 5 }, (_, line) => `PARA${i}-${line}_${"filler".repeat(8)}`).join(" ");
			apply(textStart(0));
			apply(textDelta(0, paragraph));
			apply(textEnd(0, paragraph));
		};

		// Past ChildStateLimits.maxItems (400): the live transcript is already evicting items by the
		// time the inspector first renders, so droppedItems > 0 before we ever pause.
		for (let i = 0; i < 250; i++) step(i);

		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("PARA249-");

		inspector.handleInput(KEYS.up);
		const pausedView = out(inspector);
		expect(pausedView).toContain("paused");
		const pinnedLine = pausedView.split("\n").find((line) => line.includes("PARA"));
		if (!pinnedLine) throw new Error("expected a visible transcript line after pausing");

		// Five more steps evict roughly ten more items (one tool line each, five text lines each), far
		// more lines than items: a line-count-correct pin keeps `pinnedLine` on screen regardless.
		for (let i = 250; i < 255; i++) step(i);

		const stillPaused = out(inspector);
		expect(stillPaused).toContain("paused");
		expect(stillPaused).toContain(pinnedLine);
	});
});

describe("two-press cancel", () => {
	it("arms on the first press, disarms on a different key, confirms on the second press", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const cancelAgent = vi.spyOn(sample.store, "cancelAgent");
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		// The run view auto-selects reviewer#2 (the only running agent).
		inspector.handleInput(KEYS.x);
		expect(out(inspector)).toContain("press x again to cancel reviewer#2");

		inspector.handleInput(KEYS.ctrlT);
		expect(out(inspector)).not.toContain("press x again");
		expect(cancelAgent).not.toHaveBeenCalled();

		inspector.handleInput(KEYS.x);
		inspector.handleInput(KEYS.x);
		expect(cancelAgent).toHaveBeenCalledTimes(1);
		const [runId, agentIndex] = cancelAgent.mock.calls[0] ?? [];
		expect(runId).toBe(sample.run.id);
		expect(agentIndex).toBe(1);
	});

	it("X X calls cancelRun", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const cancelRun = vi.spyOn(sample.store, "cancelRun");
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		inspector.handleInput(KEYS.X);
		expect(out(inspector)).toContain("press X again to cancel the run");
		inspector.handleInput(KEYS.X);
		expect(cancelRun).toHaveBeenCalledTimes(1);
		expect(cancelRun.mock.calls[0]?.[0]).toBe(sample.run.id);
	});

	it("shows 'already finished' for a finished agent and does not arm", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const cancelAgent = vi.spyOn(sample.store, "cancelAgent");
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		// Move the selection up from reviewer#2 (running) to reviewer#1 (done).
		inspector.handleInput(KEYS.up);
		inspector.handleInput(KEYS.x);

		expect(out(inspector)).toContain("already finished");
		inspector.handleInput(KEYS.x);
		expect(cancelAgent).not.toHaveBeenCalled();
	});
});

describe("finished agent detail", () => {
	it("shows no following indicator and no cancel hint for a finished agent, unlike a running one", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);

		// reviewer#1 (agentIndex 0) is already "done" in parallelRun()'s fixture.
		const finishedDeps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
		});
		const finished = out(new PolyphaseInspector(finishedDeps));
		expect(finished).not.toContain("following");
		expect(finished).not.toContain("paused");
		const finishedFooter = finished.split("\n").at(-2);
		expect(finishedFooter).not.toContain("cancel");
		expect(finishedFooter).toContain("thinking");

		// reviewer#2 (agentIndex 1) is still running: both must still be present.
		const runningDeps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 1 },
		});
		const running = out(new PolyphaseInspector(runningDeps));
		expect(running).toContain("following");
		const runningFooter = running.split("\n").at(-2);
		expect(runningFooter).toContain("cancel");
	});
});

describe("thinking and tool-preview toggles", () => {
	it("hides thinking text with ctrl+t", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const agent = sample.agents[0];
		if (!agent) throw new Error("expected an agent");
		const ctx = agent.createRunContext();
		const apply = (record: ReturnType<typeof thinkingStart>) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		apply(thinkingStart(0));
		apply(thinkingDelta(0, "a secret chain of reasoning"));

		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
			showThinking: true,
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("a secret chain of reasoning");

		inspector.handleInput(KEYS.ctrlT);
		const hidden = out(inspector);
		expect(hidden).not.toContain("a secret chain of reasoning");
		expect(hidden).toContain("hidden");
	});

	it("shows only 'thinking' (not its content) in the run view's now column once thinking is hidden", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const agent = sample.agents[0];
		if (!agent) throw new Error("expected an agent");
		const ctx = agent.createRunContext();
		const apply = (record: ReturnType<typeof thinkingStart>) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		apply(thinkingStart(1));
		apply(thinkingDelta(1, "a secret chain of reasoning"));

		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "run", runId: sample.run.id },
			showThinking: true,
		});
		const inspector = new PolyphaseInspector(deps);

		// The column is narrow, so only a prefix of the secret text is visible even before hiding it.
		expect(out(inspector)).toContain("a secret chain");
		expect(out(inspector)).not.toContain("a secret chain of reasoning");

		inspector.handleInput(KEYS.ctrlT);
		const hiddenRow = out(inspector)
			.split("\n")
			.find((line) => line.includes("investigator"));
		if (!hiddenRow) throw new Error("expected the agent row");
		expect(hiddenRow).not.toContain("a secret chain");
		expect(hiddenRow).toContain("thinking");
	});

	it("shows tool previews with ctrl+o", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const agent = sample.agents[0];
		if (!agent) throw new Error("expected an agent");
		const ctx = agent.createRunContext();
		const apply = (record: ReturnType<typeof toolStart>) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		apply(toolStart("call-1", "read", { path: "src/foo.ts" }));
		apply(toolEnd("call-1", "read", "SECRET_PREVIEW_TEXT", false));

		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 0 },
			showThinking: true,
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).not.toContain("SECRET_PREVIEW_TEXT");
		inspector.handleInput(KEYS.ctrlO);
		expect(out(inspector)).toContain("SECRET_PREVIEW_TEXT");
	});
});

describe("archived runs", () => {
	it("shows the archived-transcript note for a run no longer in the live store", () => {
		const sample = singleRun({ final: true });
		const details = buildDetails(sample.run, { final: true });
		sample.dispose();

		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			getArchivedRuns: () => [
				{ runId: details.runId, entryId: "entry-1", timestamp: Date.now(), source: "toolResult", details },
			],
			initial: { view: "agent", runId: details.runId, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector);
		expect(rendered).toContain("Live transcript is only kept while the run is in memory.");
		expect(rendered).toContain("STATUS: DONE");
		expect(rendered).toContain("All checks pass.");
	});

	it("falls back to the same summary body for a finished run still in the live store whose transcript was dropped by retention", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());

		const finishRun = (id: string): void => {
			const run = store.createRun({ id, kind: "subagent", origin: "tool", title: id, budgetTokens: null });
			const agent = run.addAgent({
				label: "a1",
				agentType: "x",
				task: "t",
				model: { source: "child-default", confirmed: false },
			});
			const ctx = agent.createRunContext();
			const apply = (record: ChildWireRecord) => {
				const change = agent.reducer.apply(record);
				if (change !== "none") ctx.onChange?.(change);
			};
			const text = "All checks pass.\nSTATUS: DONE";
			for (const record of [
				sessionHeader(),
				agentStart(),
				assistantStart("anthropic", "claude-sonnet-5"),
				textStart(0),
				textDelta(0, text),
				textEnd(0, text),
				assistantEnd({ text }),
			]) {
				apply(record);
			}
			const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
			const result = toRunResult(agent.reducer.state, { agent: agent.agentType, task: agent.task }, finish, {
				cancelled: false,
				structured: agent.reducer.state.structured,
				durationMs: 1_000,
			});
			ctx.onFinish?.(result);
			run.finish("done");
		};

		// The store default keeps live transcripts for only the newest 5 finished runs
		// (`keepTranscriptRuns`): the 6th and 7th finished runs here have theirs dropped, even though
		// the runs themselves are still in the store (within `retainRuns`).
		for (let i = 0; i < 7; i++) finishRun(`run-${i}`);

		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			initial: { view: "agent", runId: "run-0", agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector);
		expect(rendered).toContain("STATUS: DONE");
		expect(rendered).toContain("Live transcript is only kept while the run is in memory.");
	});
});

describe("archived/retention-dropped body at a small height", () => {
	it("keeps the muted retention note visible by trimming the output preview first", () => {
		const store = createSampleStore();
		const run = store.createRun({
			id: "run-long-output",
			kind: "subagent",
			origin: "tool",
			title: "long output",
			budgetTokens: null,
		});
		const agent = run.addAgent({
			label: "a1",
			agentType: "x",
			task: "t",
			model: { source: "child-default", confirmed: false },
		});
		const ctx = agent.createRunContext();
		const apply = (record: ChildWireRecord) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		const longText = Array.from({ length: 20 }, (_, i) => `line ${i} of a long result`).join("\n");
		for (const record of [
			sessionHeader(),
			agentStart(),
			assistantStart("anthropic", "claude-sonnet-5"),
			textStart(0),
			textDelta(0, longText),
			textEnd(0, longText),
			assistantEnd({ text: longText }),
		]) {
			apply(record);
		}
		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: agent.agentType, task: agent.task }, finish, {
			cancelled: false,
			structured: agent.reducer.state.structured,
			durationMs: 1_000,
		});
		ctx.onFinish?.(result);
		run.finish("done");
		const details = buildDetails(run, { final: true });
		store.dispose();

		const emptyStore = createSampleStore();
		disposables.push(() => emptyStore.dispose());
		// rows=12 gives a content height of 7 inside the agent detail body: not enough for the header
		// (3 lines), the status line, 20 lines of output and the note all at once.
		const { tui } = fakeTui(12, 80);
		const deps = buildDeps({
			session: testSession({ store: emptyStore, dispose: () => emptyStore.dispose() }),
			tui,
			getArchivedRuns: () => [
				{ runId: details.runId, entryId: "entry-1", timestamp: Date.now(), source: "toolResult", details },
			],
			initial: { view: "agent", runId: details.runId, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector, 80);
		expect(rendered).toContain("Live transcript is only kept while the run is in memory.");
	});

	it("keeps the note visible ahead of the error and status lines at the smallest supported height", () => {
		const store = createSampleStore();
		const run = store.createRun({
			id: "run-status-and-error",
			kind: "subagent",
			origin: "tool",
			title: "status and error",
			budgetTokens: null,
		});
		const agent = run.addAgent({
			label: "a1",
			agentType: "x",
			task: "t",
			model: { source: "child-default", confirmed: false },
		});
		const ctx = agent.createRunContext();
		const apply = (record: ChildWireRecord) => {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		};
		const text = "work done\nSTATUS: PARTIAL";
		for (const record of [
			sessionHeader(),
			agentStart(),
			assistantStart("anthropic", "claude-sonnet-5"),
			textStart(0),
			textDelta(0, text),
			textEnd(0, text),
			assistantEnd({ text, stopReason: "error", errorMessage: "tool call failed: write" }),
		]) {
			apply(record);
		}
		const finish = agent.reducer.finish({ code: 1, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: agent.agentType, task: agent.task }, finish, {
			cancelled: false,
			structured: agent.reducer.state.structured,
			durationMs: 1_000,
		});
		ctx.onFinish?.(result);
		run.finish("failed");
		const details = buildDetails(run, { final: true });
		store.dispose();

		const emptyStore = createSampleStore();
		disposables.push(() => emptyStore.dispose());
		// rows=10 is the minimum the inspector accepts: contentHeight is 5, one less than header (3)
		// + status + error + note (6), so one of status/error must give way to keep the note visible.
		const { tui } = fakeTui(10, 80);
		const deps = buildDeps({
			session: testSession({ store: emptyStore, dispose: () => emptyStore.dispose() }),
			tui,
			getArchivedRuns: () => [
				{ runId: details.runId, entryId: "entry-1", timestamp: Date.now(), source: "toolResult", details },
			],
			initial: { view: "agent", runId: details.runId, agentIndex: 0 },
		});
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector, 80);
		expect(rendered).toContain("Live transcript is only kept while the run is in memory.");
	});
});

describe("saved workflows", () => {
	it("enter on a saved workflow with no registered command falls back to /workflow <name>", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const insertCommand = vi.fn();
		const close = vi.fn();
		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			getSavedWorkflows: () => [
				{ name: "review-pr", description: "Review a change", source: "project", valid: true },
			],
			initial: { view: "runs" },
			insertCommand,
			close,
		});
		const inspector = new PolyphaseInspector(deps);

		inspector.handleInput(KEYS.enter);
		expect(insertCommand).toHaveBeenCalledWith("/workflow review-pr ");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("enter on a saved workflow with a registered command inserts /<command>", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const insertCommand = vi.fn();
		const close = vi.fn();
		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			getSavedWorkflows: () => [
				{
					name: "review-pr",
					description: "Review a change",
					source: "project",
					valid: true,
					command: "review-pr",
				},
			],
			initial: { view: "runs" },
			insertCommand,
			close,
		});
		const inspector = new PolyphaseInspector(deps);

		inspector.handleInput(KEYS.enter);
		expect(insertCommand).toHaveBeenCalledWith("/review-pr ");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("enter on an invalid saved workflow shows a notice instead of inserting a command", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const insertCommand = vi.fn();
		const close = vi.fn();
		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			getSavedWorkflows: () => [
				{ name: "broken", description: "Has an invalid meta block", source: "project", valid: false },
			],
			initial: { view: "runs" },
			insertCommand,
			close,
		});
		const inspector = new PolyphaseInspector(deps);

		expect(out(inspector)).toContain("invalid");

		inspector.handleInput(KEYS.enter);
		expect(insertCommand).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		expect(out(inspector)).toContain("invalid");
	});
});

describe("split view", () => {
	// SPLIT_LEFT_WIDTH (inspector.ts, not exported): the left pane is padded to exactly this many
	// columns before the "│" separator, so the separator's column inside the outer "│ " border is
	// fixed at SPLIT_LEFT_WIDTH + 2.
	const SPLIT_LEFT_WIDTH = 40;
	const SEPARATOR_COLUMN = SPLIT_LEFT_WIDTH + 2;

	it("renders a two-pane split at width >= 120, with the separator aligned under the right pane's content", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		const rendered = out(inspector, 120);
		expect(rendered).toContain("reviewer#1");
		expect(rendered).toContain("reviewer#2");
		const taskLine = rendered.split("\n").find((line) => line.includes("task"));
		if (!taskLine) throw new Error("expected a task line in the right pane");
		// A vacuous check (sideLine's own borders put "│" on every row) would pass even if the left
		// pane were the wrong width; checking the exact column instead fails if the two panes drift.
		expect(taskLine[SEPARATOR_COLUMN]).toBe("│");
	});

	it("windows the left pane to keep the selected agent visible when there are more agents than rows", () => {
		const sample = largeRun(30);
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		// 30 agents and 22 body rows (rows=24 minus the border and the footer line): without windowing,
		// the left pane would show agent#0..agent#20 and the cursor on the last agent would be off the
		// bottom of the pane.
		for (let i = 0; i < 29; i++) inspector.handleInput(KEYS.down);

		const rendered = out(inspector, 120);
		const leftPane = rendered
			.split("\n")
			.map((line) => line.slice(0, SEPARATOR_COLUMN))
			.join("\n");
		// agent#29 (29 % 3 === 2) is queued, so its glyph is "◌", not a finished or running one.
		expect(leftPane).toContain("› ◌ agent#29");
	});

	it("marks hidden rows above/below the windowed left pane with scroll markers", () => {
		const sample = largeRun(30);
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		const leftPaneLines = () =>
			out(inspector, 120)
				.split("\n")
				.map((line) => line.slice(0, SEPARATOR_COLUMN));
		const selectedLine = (lines: readonly string[]) => lines.find((line) => line.includes("›"));

		// The first running agent (agent#1) starts selected: the 20-row window has nothing hidden
		// above it, and 10 agents hidden below.
		let lines = leftPaneLines();
		expect(selectedLine(lines)).toMatch(/agent#1(?!\d)/);
		expect(lines.join("\n")).not.toContain("↑");
		expect(lines.join("\n")).toContain("↓ 10 more");

		// Move to agent#15 (an interior selection): 5 agents hidden above, 5 hidden below.
		for (let i = 0; i < 14; i++) inspector.handleInput(KEYS.down);
		lines = leftPaneLines();
		expect(selectedLine(lines)).toMatch(/agent#15(?!\d)/);
		expect(lines.join("\n")).toContain("↑ 5 more");
		expect(lines.join("\n")).toContain("↓ 5 more");

		// Move to agent#29 (the last agent): 10 agents hidden above, none hidden below.
		for (let i = 0; i < 14; i++) inspector.handleInput(KEYS.down);
		lines = leftPaneLines();
		expect(selectedLine(lines)).toMatch(/agent#29(?!\d)/);
		expect(lines.join("\n")).toContain("↑ 10 more");
		expect(lines.join("\n")).not.toContain("↓");
	});

	it("routes pageUp to the right pane instead of moving the left selection", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const agent = sample.agents[0];
		if (!agent) throw new Error("expected an agent");
		const ctx = agent.createRunContext();
		const applyStep = (i: number) => {
			const apply = (record: ReturnType<typeof toolStart>) => {
				const change = agent.reducer.apply(record);
				if (change !== "none") ctx.onChange?.(change);
			};
			apply(toolStart(`call-${i}`, "bash", { command: `step ${i}` }));
			apply(toolEnd(`call-${i}`, "bash", `output ${i}`, false));
		};
		for (let i = 0; i < 40; i++) applyStep(i);

		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		// Render once at split width so the inspector knows split view is active.
		out(inspector, 120);

		inspector.handleInput(KEYS.pageUp);
		const rendered = out(inspector, 120);

		expect(rendered).toContain("paused");
		expect(rendered).not.toContain("step 39");
	});
});

describe("alt+a closes from any view", () => {
	it("closes via alt+a from the run view", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const close = vi.fn();
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id }, close });
		const inspector = new PolyphaseInspector(deps);

		inspector.handleInput(KEYS.altA);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes via alt+a from the agent detail view", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const close = vi.fn();
		const deps = buildDeps({
			session: testSession(sample),
			initial: { view: "agent", runId: sample.run.id, agentIndex: 1 },
			close,
		});
		const inspector = new PolyphaseInspector(deps);

		inspector.handleInput(KEYS.altA);
		expect(close).toHaveBeenCalledTimes(1);
	});
});

describe("child- and script-supplied text is sanitized", () => {
	const PAYLOAD = "ESCAPE_PAYLOAD_MARKER";
	const injected = (text: string) => `${text}\x1b]52;c;${PAYLOAD}\x07`;

	it("strips an OSC injection from the run title, workflow name/description, phase titles, agent labels, task and model fields", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const run = store.createRun({
			id: "run-injected",
			kind: "workflow",
			origin: "command",
			title: injected("/release"),
			workflow: {
				name: injected("release"),
				description: injected("Ship a release"),
				source: "project",
				args: injected("v1"),
			},
			phases: [{ title: injected("plan") }],
			budgetTokens: null,
		});
		run.enterPhase(injected("plan"));
		run.addAgent({
			label: injected("planner"),
			agentType: "planner",
			task: injected("plan the release"),
			phase: 0,
			model: { source: "inherited", provider: injected("anthropic"), id: injected("claude"), confirmed: true },
		});

		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			initial: { view: "run", runId: run.id },
		});
		const inspector = new PolyphaseInspector(deps);

		// Checked against the raw render output, not `out()`'s own `stripAnsi()`: a test that stripped
		// ANSI itself would pass even if the inspector never sanitized anything, since OSC sequences
		// disappear under `stripAnsi` either way. The regression is that the *source* strings reaching
		// `fitLine`/`formatModelLabel` must already be clean.
		const raw = inspector.render(120).join("\n");
		expect(raw).not.toContain(PAYLOAD);
		expect(raw).not.toContain("\x1b]52");

		inspector.handleInput(KEYS.enter);
		const detailRaw = inspector.render(120).join("\n");
		expect(detailRaw).not.toContain(PAYLOAD);
		expect(detailRaw).not.toContain("\x1b]52");
	});

	it("strips an OSC injection from a saved workflow's name and description", () => {
		const store = createSampleStore();
		disposables.push(() => store.dispose());
		const deps = buildDeps({
			session: testSession({ store, dispose: () => store.dispose() }),
			getSavedWorkflows: () => [
				{ name: injected("review-pr"), description: injected("Review a change"), source: "project", valid: true },
			],
			initial: { view: "runs" },
		});
		const inspector = new PolyphaseInspector(deps);

		const raw = inspector.render(120).join("\n");
		expect(raw).not.toContain(PAYLOAD);
		expect(raw).not.toContain("\x1b]52");
	});
});

describe("footer hints", () => {
	it("renders the select hint as the arrow glyphs the app's other selectors use, in the runs and run views", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const session = testSession(sample);

		const runsInspector = new PolyphaseInspector(buildDeps({ session, initial: { view: "runs" } }));
		expect(out(runsInspector)).toContain("↑↓ select");
		expect(out(runsInspector)).not.toContain("up/down select");

		const runInspector = new PolyphaseInspector(
			buildDeps({ session, initial: { view: "run", runId: sample.run.id } }),
		);
		expect(out(runInspector)).toContain("↑↓ select");
		expect(out(runInspector)).not.toContain("up/down select");
	});

	it("falls back to the real key names when up/down are rebound away from the defaults", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const globalKeybindings = getKeybindings();
		setKeybindings(new KeybindingsManager(KEYBINDINGS, { "tui.select.up": "k", "tui.select.down": "j" }));
		try {
			const deps = buildDeps({ session: testSession(sample), initial: { view: "runs" } });
			const inspector = new PolyphaseInspector(deps);

			const rendered = out(inspector);
			expect(rendered).toContain("k/j select");
			expect(rendered).not.toContain("↑↓");
		} finally {
			setKeybindings(globalKeybindings);
		}
	});

	it("ellipsises an overflowing footer instead of hard-cutting it mid-word", () => {
		// Measured on a real run view at 60 columns: the footer used to read
		// "...shift+x cance" (the border's own padding truncates with no ellipsis of its own).
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const { tui } = fakeTui(24, 60);
		const deps = buildDeps({
			session: testSession(sample),
			tui,
			initial: { view: "run", runId: sample.run.id },
		});
		const inspector = new PolyphaseInspector(deps);

		const lines = inspector.render(60).map((line) => stripAnsi(line));
		const footer = lines.find((line) => line.includes("select"));
		if (!footer) throw new Error("expected a footer line containing the select hint");
		expect(footer).not.toContain("cance ");
		expect(footer).toContain("…");
	});
});

describe("size safety", () => {
	/** `agentIndex: 1` is reviewer#2: running, with a thinking block and a blocked tool tail, so the
	 * agent and split views are exercised with real multi-line content, not an empty transcript. */
	function viewConfigs(sample: ReturnType<typeof parallelRun>): Array<{ initial: InspectorInitialView }> {
		return [
			{ initial: { view: "runs" } },
			{ initial: { view: "run", runId: sample.run.id } },
			{ initial: { view: "agent", runId: sample.run.id, agentIndex: 1 } },
		];
	}

	it("never renders more lines than the computed height, across runs/run/agent/split views", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const session = testSession(sample);
		const widths = [80, 120];
		for (const rows of [12, 24, 60]) {
			for (const { initial } of viewConfigs(sample)) {
				for (const width of widths) {
					const { tui } = fakeTui(rows, width);
					const deps = buildDeps({ session, tui, initial });
					const inspector = new PolyphaseInspector(deps);
					const lines = inspector.render(width);
					expect(lines.length).toBeLessThanOrEqual(Math.max(8, rows - 2));
				}
			}
		}
	});

	it("never renders a line wider than the requested width, across runs/run/agent/split views", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const session = testSession(sample);
		for (const width of [40, 80, 120]) {
			for (const { initial } of viewConfigs(sample)) {
				const deps = buildDeps({ session, initial });
				const inspector = new PolyphaseInspector(deps);
				const lines = inspector.render(width);
				for (const line of lines) {
					expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("keeps the top border's closing corner even when the title must be truncated", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		for (const width of [40, 50, 60]) {
			const top = inspector.render(width).map((line) => stripAnsi(line))[0];
			if (!top) throw new Error("expected a top border line");
			expect(top.endsWith("┐")).toBe(true);
		}
	});

	it("shows a 'terminal too small' line below 40x10", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const { tui } = fakeTui(8, 30);
		const deps = buildDeps({ session: testSession(sample), tui, initial: { view: "runs" } });
		const inspector = new PolyphaseInspector(deps);

		const lines = inspector.render(30).map((line) => stripAnsi(line));
		expect(lines.join("\n")).toContain("terminal too small");
	});
});

describe("snapshot memoization", () => {
	it("builds the current run's snapshot at most once per render, in both the run view and the agent view", () => {
		const sample = parallelRun();
		disposables.push(sample.dispose);
		const getRun = vi.spyOn(sample.store, "getRun");
		const deps = buildDeps({ session: testSession(sample), initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		getRun.mockClear();
		inspector.render(80);
		// `snapshotFromRun` runs a status-line regex over every agent's output and hashes the whole
		// details object; before the fix, the header and the body each called `currentRunSnapshot()`
		// independently, rebuilding it 3 times for a single render.
		expect(getRun).toHaveBeenCalledTimes(1);

		inspector.handleInput(KEYS.enter);
		getRun.mockClear();
		inspector.render(80);
		// Agent mode also fetches the run once more for the live transcript (`currentAgentTranscriptFor`,
		// unrelated to the snapshot): 2 calls total, not the snapshot-only header/body/agents-list
		// triplication (4 calls) the unfixed code made.
		expect(getRun).toHaveBeenCalledTimes(2);
	});
});

describe("dispose", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("unsubscribes from the store: no requestRender calls arrive after dispose", () => {
		const sample = singleRun();
		disposables.push(sample.dispose);
		const { tui, requestRender } = fakeTui();
		const deps = buildDeps({ session: testSession(sample), tui, initial: { view: "run", runId: sample.run.id } });
		const inspector = new PolyphaseInspector(deps);

		sample.run.appendLog("first");
		vi.advanceTimersByTime(100);
		const callsBeforeDispose = requestRender.mock.calls.length;
		expect(callsBeforeDispose).toBeGreaterThan(0);

		inspector.dispose();
		sample.run.appendLog("after dispose");
		vi.advanceTimersByTime(1000);

		expect(requestRender.mock.calls.length).toBe(callsBeforeDispose);
	});
});
