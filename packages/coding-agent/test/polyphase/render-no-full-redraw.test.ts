import { KeybindingsManager, setKeybindings, type Terminal, Text, type TUI, TuiMainScreen } from "@draht/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { createSubagentRenderers, type PolyphaseRenderDeps } from "../../src/core/polyphase/render/renderers.ts";
import { PolyphaseStore } from "../../src/core/polyphase/store.ts";
import { createUpdatePump } from "../../src/core/polyphase/update-pump.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import {
	agentStart,
	assistantEnd,
	assistantStart,
	sessionHeader,
	thinkingDelta,
	thinkingStart,
} from "./helpers/wire.ts";

/**
 * Mirrors `test/edit-tool-no-full-redraw.test.ts`: live polyphase rows must repaint in place, never
 * triggering a full screen clear, as long as the agent/line count stays stable (§11.2.4, §11.2.2).
 */

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** `requestRender()` throttles to one frame per `TuiBase.MIN_RENDER_INTERVAL_MS` (16ms): a bare
 * `setTimeout(0)` can resolve before that frame's own timer fires, leaving `doRender()` unrun and
 * `tui.fullRedraws` frozen regardless of what changed. Tests with only one mutation to check must
 * wait past the throttle for real, not race it. */
async function waitForRealRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}

function createFakeTui(): { terminal: FakeTerminal; tui: TUI } {
	const terminal = new FakeTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	return { terminal, tui: tui as unknown as TUI };
}

interface LiveRow {
	store: PolyphaseStore;
	runId: string;
	/** Applies a thinking-delta wire record and flushes the pump synchronously, so the resulting
	 * `RunSnapshot.version` bump is observable without waiting on the pump's real timer. */
	applyFineChange(delta: string): void;
	dispose(): void;
}

function makeRunningRow(runId: string, now: () => number): LiveRow {
	const pump = createUpdatePump({ intervalMs: 250 });
	const store = new PolyphaseStore({ pump, retainRuns: 20, now });
	const run = store.createRun({
		id: runId,
		kind: "subagent",
		origin: "tool",
		mode: "single",
		title: "subagent reviewer",
		budgetTokens: null,
	});
	const agent = run.addAgent({
		label: "reviewer",
		agentType: "reviewer",
		task: "review the diff",
		model: { source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: true },
	});
	const ctx = agent.createRunContext();
	ctx.onStart?.({ pid: 123, argv: ["draht"] });
	for (const record of [
		sessionHeader(),
		agentStart(),
		assistantStart("anthropic", "claude-sonnet-5"),
		thinkingStart(0),
	]) {
		const change = agent.reducer.apply(record);
		if (change !== "none") ctx.onChange?.(change);
	}
	pump.flushNow();
	return {
		store,
		runId,
		applyFineChange(delta) {
			const change = agent.reducer.apply(thinkingDelta(0, delta));
			if (change !== "none") ctx.onChange?.(change);
			pump.flushNow();
		},
		dispose() {
			store.dispose();
		},
	};
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager(KEYBINDINGS));
});

describe("polyphase tool rows avoid full redraws on live updates", () => {
	const disposers: Array<() => void> = [];

	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
	});

	it("a focused row's spinner and elapsed ticks never trigger a full redraw", async () => {
		let nowValue = 1_700_000_000_000;
		const row = makeRunningRow("tool-call-focus", () => nowValue);
		disposers.push(row.dispose);

		const deps: PolyphaseRenderDeps = { getStore: () => row.store, viewportRows: () => 24, now: () => nowValue };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const { terminal, tui } = createFakeTui();

		const component = new ToolExecutionComponent(
			"subagent",
			row.runId,
			{ agent: "reviewer", task: "review the diff" },
			{},
			{ renderCall, renderResult },
			tui,
			process.cwd(),
		);
		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		component.updateResult({ content: [], details: {}, isError: false }, true);
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		// Guard against a swallowed render exception: `ToolExecutionComponent` falls back to an
		// empty result on a throwing renderer, which would also report zero full redraws.
		expect(row.store.focusRunId()).toBe(row.runId);
		const initialText = stripAnsi(component.render(78).join("\n"));
		expect(initialText).toContain("reviewer");

		const redrawsBefore = tui.fullRedraws;
		const clearsBefore = terminal.fullClearCount;
		const writesBefore = terminal.writes.length;

		let lastText = initialText;
		for (let i = 0; i < 60; i++) {
			nowValue += 250;
			row.applyFineChange(` more-${i}`);
			component.updateResult({ content: [], details: {}, isError: false }, true);
			tui.requestRender();
			await waitForRealRender();
			lastText = stripAnsi(component.render(78).join("\n"));
		}

		// The zero-redraw result above only means something if the row actually kept repainting
		// (spinner frame, elapsed, live thinking text), not if nothing ever changed.
		expect(lastText).not.toBe(initialText);
		// ... and only means something if the terminal actually received writes during the window,
		// not if the throttle swallowed every `requestRender()` before a frame could fire.
		expect(terminal.writes.length).toBeGreaterThan(writesBefore);
		expect(tui.fullRedraws).toBe(redrawsBefore);
		expect(terminal.fullClearCount).toBe(clearsBefore);
	});

	it("a non-focus row scrolled above the viewport stays unchanged through fine-only updates", async () => {
		let nowValue = 1_700_000_000_000;
		const row = makeRunningRow("tool-call-background", () => nowValue);
		disposers.push(row.dispose);

		// A second, newer running tool run becomes the focus; `row` is left static.
		const focusRun = row.store.createRun({
			id: "tool-call-newer",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent other",
			budgetTokens: null,
		});
		expect(row.store.focusRunId()).toBe(focusRun.id);

		const deps: PolyphaseRenderDeps = { getStore: () => row.store, viewportRows: () => 24, now: () => nowValue };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const { terminal, tui } = createFakeTui();

		const component = new ToolExecutionComponent(
			"subagent",
			row.runId,
			{ agent: "reviewer", task: "review the diff" },
			{},
			{ renderCall, renderResult },
			tui,
			process.cwd(),
		);

		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		component.updateResult({ content: [], details: {}, isError: false }, true);
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		// Push the row above the viewport the way new chat messages would: append filler content
		// *after* it settled, so the terminal's active render window scrolls past it.
		for (let i = 0; i < 40; i++) {
			tui.addChild(new Text(`filler ${i}`, 0, 0));
		}
		tui.requestRender();
		await waitForRender();

		const redrawsBefore = tui.fullRedraws;
		const clearsBefore = terminal.fullClearCount;
		const writesBefore = terminal.writes.length;

		for (let i = 0; i < 20; i++) {
			nowValue += 250;
			row.applyFineChange(` more-${i}`);
			component.updateResult({ content: [], details: {}, isError: false }, true);
			tui.requestRender();
			await waitForRealRender();
		}

		expect(terminal.writes.length).toBeGreaterThan(writesBefore);
		expect(tui.fullRedraws).toBe(redrawsBefore);
		expect(terminal.fullClearCount).toBe(clearsBefore);
	});

	it("a non-focus row's model confirmation does not trigger a full redraw", async () => {
		let nowValue = 1_700_000_000_000;
		const pump = createUpdatePump({ intervalMs: 250 });
		const store = new PolyphaseStore({ pump, retainRuns: 20, now: () => nowValue });
		const run = store.createRun({
			id: "tool-call-unconfirmed",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent reviewer",
			budgetTokens: null,
		});
		const agent = run.addAgent({
			label: "reviewer",
			agentType: "reviewer",
			task: "review the diff",
			model: { source: "inherited", requested: "claude-sonnet-5", confirmed: false },
		});
		const ctx = agent.createRunContext();
		ctx.onStart?.({ pid: 123, argv: ["draht"] });
		pump.flushNow();
		disposers.push(() => store.dispose());

		// A second, newer running tool run becomes the focus; `run` is left static.
		const focusRun = store.createRun({
			id: "tool-call-unconfirmed-newer",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent other",
			budgetTokens: null,
		});
		expect(store.focusRunId()).toBe(focusRun.id);

		const deps: PolyphaseRenderDeps = { getStore: () => store, viewportRows: () => 24, now: () => nowValue };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const { terminal, tui } = createFakeTui();

		const component = new ToolExecutionComponent(
			"subagent",
			run.id,
			{ agent: "reviewer", task: "review the diff" },
			{},
			{ renderCall, renderResult },
			tui,
			process.cwd(),
		);

		tui.addChild(component);
		tui.start();
		await waitForRender();

		component.setArgsComplete();
		component.updateResult({ content: [], details: {}, isError: false }, true);
		tui.requestRender();
		await waitForRender();
		await waitForRender();

		for (let i = 0; i < 40; i++) tui.addChild(new Text(`filler ${i}`, 0, 0));
		tui.requestRender();
		await waitForRender();

		const redrawsBefore = tui.fullRedraws;
		const clearsBefore = terminal.fullClearCount;
		const textBefore = stripAnsi(component.render(80).join("\n"));
		expect(textBefore).toContain("reviewer");

		// The child confirms its model and thinking level (message_start, then message_end):
		// coarse changes, but not an agent status transition.
		for (const record of [assistantStart("anthropic", "claude-sonnet-5"), assistantEnd({ thinkingLevel: "high" })]) {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		}
		pump.flushNow();
		nowValue += 250;
		component.updateResult({ content: [], details: {}, isError: false }, true);
		tui.requestRender();
		await waitForRealRender();

		// The static row's text must not change on model confirmation: it is not a status
		// transition, so re-rendering it must be a no-op (§11.2.2), checked directly first since
		// `tui.fullRedraws` only moves once the throttled render timer actually fires.
		expect(stripAnsi(component.render(80).join("\n"))).toBe(textBefore);
		expect(tui.fullRedraws).toBe(redrawsBefore);
		expect(terminal.fullClearCount).toBe(clearsBefore);
	});
});
