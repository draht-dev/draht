import { KeybindingsManager, setKeybindings, type TUI, visibleWidth } from "@draht/tui";
import { describe, expect, it, vi } from "vitest";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { AgentLimiter } from "../../src/core/polyphase/limiter.ts";
import type { PolyphaseSession } from "../../src/core/polyphase/session.ts";
import { resolvePolyphaseSettings } from "../../src/core/polyphase/settings.ts";
import { PolyphaseStore } from "../../src/core/polyphase/store.ts";
import type { AgentModelInfo } from "../../src/core/polyphase/types.ts";
import { PolyphaseDock } from "../../src/core/polyphase/ui/dock.ts";
import { createUpdatePump, type UpdatePump } from "../../src/core/polyphase/update-pump.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { parallelRun } from "./helpers/sample-runs.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(KEYBINDINGS));

const NOW = 1_700_000_000_000;

function pendingModel(): AgentModelInfo {
	return { source: "inherited", requested: "claude-sonnet-5", confirmed: false };
}

function testSession(store: PolyphaseStore, dock = true): PolyphaseSession {
	return {
		store,
		limiter: new AgentLimiter(4),
		settings: () => resolvePolyphaseSettings(dock ? undefined : { dock: false }),
		refreshSettings: () => {},
		permissionMode: () => "default",
		setPermissionModeProvider: () => {},
		onParentPrompt: () => () => {},
		notifyParentPrompt: () => {},
		setInspectorOpen: () => {},
		disposed: false,
		dispose: () => store.dispose(),
	};
}

function fakeTui(): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	const tui = { terminal: { rows: 24, columns: 80 }, requestRender } as unknown as TUI;
	return { tui, requestRender };
}

function out(dock: PolyphaseDock, width = 80): string[] {
	return dock.render(width).map((line) => stripAnsi(line));
}

/** A store with its own `pump` reference, so tests can force a synchronous flush without fake timers. */
function storeWithPump(): { store: PolyphaseStore; pump: UpdatePump } {
	const pump = createUpdatePump({ intervalMs: 250 });
	return { store: new PolyphaseStore({ pump, retainRuns: 20, now: () => NOW }), pump };
}

describe("PolyphaseDock", () => {
	it("renders the store totals as the summary line", () => {
		const sample = parallelRun();
		const { tui } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(sample.store), tui, theme, now: () => NOW });
		const [summary] = out(dock);
		expect(summary).toContain("polyphase");
		expect(summary).toContain("1 run");
		expect(summary).not.toContain("1 runs");
		expect(summary).toContain("1 running");
		expect(summary).toContain("1 queued");
		expect(summary).toContain("alt+a");
		expect(summary).toContain("inspect");
		sample.dispose();
	});

	it("shows a phase tree for a running command-origin workflow, not for a tool-origin one", () => {
		const { store } = storeWithPump();
		const commandRun = store.createRun({
			id: "run-command",
			kind: "workflow",
			origin: "command",
			title: "/release v1.2.3",
			phases: [{ title: "plan" }],
			budgetTokens: null,
		});
		commandRun.enterPhase("plan");
		commandRun.addAgent({
			label: "planner",
			agentType: "planner",
			task: "plan the release",
			phase: 0,
			model: pendingModel(),
		});

		const toolRun = store.createRun({
			id: "run-tool",
			kind: "workflow",
			origin: "tool",
			title: "workflow from a model call",
			phases: [{ title: "scan" }],
			budgetTokens: null,
		});
		toolRun.enterPhase("scan");
		toolRun.addAgent({
			label: "scanner",
			agentType: "scanner",
			task: "scan the repo",
			phase: 0,
			model: pendingModel(),
		});

		const { tui } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(store), tui, theme, now: () => NOW });
		const lines = out(dock).join("\n");
		expect(lines).toContain("plan");
		expect(lines).not.toContain("scan");

		store.dispose();
	});

	it("caps the total line count at 10", () => {
		const { store } = storeWithPump();
		for (let i = 0; i < 5; i++) {
			const run = store.createRun({
				id: `run-${i}`,
				kind: "workflow",
				origin: "command",
				title: `/w${i}`,
				phases: [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }],
				budgetTokens: null,
			});
			run.enterPhase("a");
			run.addAgent({ label: `agent-${i}`, agentType: "worker", task: "work", phase: 0, model: pendingModel() });
		}

		const { tui } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(store), tui, theme, now: () => NOW });
		const lines = dock.render(80);
		expect(lines.length).toBeLessThanOrEqual(10);

		store.dispose();
	});

	it.each([30, 80, 120])("fits every line within width %i", (width) => {
		const sample = parallelRun();
		const commandRun = sample.store.createRun({
			id: "run-command-width",
			kind: "workflow",
			origin: "command",
			title: "/release v1.2.3",
			phases: [{ title: "plan" }, { title: "ship" }],
			budgetTokens: null,
		});
		commandRun.enterPhase("plan");
		commandRun.addAgent({
			label: "planner",
			agentType: "planner",
			task: "plan the release",
			phase: 0,
			model: pendingModel(),
		});

		const { tui } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(sample.store), tui, theme, now: () => NOW });
		const lines = dock.render(width);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		sample.dispose();
	});

	it("derives the summary from running runs only, not every retained run", () => {
		const { store } = storeWithPump();
		const finished = store.createRun({
			id: "run-finished",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "earlier call",
			budgetTokens: null,
		});
		finished.addAgent({
			label: "earlier",
			agentType: "worker",
			task: "earlier work",
			model: pendingModel(),
		});
		finished.finish("done");

		const running = store.createRun({
			id: "run-running",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "current call",
			budgetTokens: null,
		});
		running.addAgent({ label: "current", agentType: "worker", task: "current work", model: pendingModel() });

		const { tui } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(store), tui, theme, now: () => NOW });
		const [summary] = out(dock);
		expect(summary).toContain("1 run");
		expect(summary).not.toContain("2 run");
		expect(summary).not.toContain("1 done");

		store.dispose();
	});

	it("does not show a stale elapsed time when a render lands on a repeated spinner frame a second later", () => {
		const { store } = storeWithPump();
		const commandRun = store.createRun({
			id: "run-stale-elapsed",
			kind: "workflow",
			origin: "command",
			title: "/release v1.2.3",
			phases: [{ title: "plan" }],
			budgetTokens: null,
		});
		commandRun.enterPhase("plan");
		commandRun.addAgent({
			label: "planner",
			agentType: "planner",
			task: "plan the release",
			phase: 0,
			model: pendingModel(),
		});

		let now = NOW;
		const { tui } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(store), tui, theme, now: () => now });

		const first = out(dock).join("\n");
		expect(first).toContain("0:00");

		// Exactly 1000ms later: `spinnerFrame` (250ms per frame, 4 frames) lands back on the same
		// frame, so the cache key must not be a false hit on the frame alone.
		now = NOW + 1000;
		const second = out(dock).join("\n");
		expect(second).toContain("0:01");
		expect(second).not.toContain("0:00");

		store.dispose();
	});

	it("requests a render on every store flush", () => {
		const { store, pump } = storeWithPump();
		const { tui, requestRender } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(store), tui, theme, now: () => NOW });
		expect(requestRender).not.toHaveBeenCalled();

		const run = store.createRun({
			id: "run-flush",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "do a thing",
			budgetTokens: null,
		});
		run.addAgent({ label: "worker", agentType: "worker", task: "do the thing", model: pendingModel() });
		pump.flushNow();

		expect(requestRender).toHaveBeenCalled();
		dock.dispose();
		store.dispose();
	});

	it("stops requesting renders after dispose", () => {
		const { store, pump } = storeWithPump();
		const { tui, requestRender } = fakeTui();
		const dock = new PolyphaseDock({ session: testSession(store), tui, theme, now: () => NOW });
		dock.dispose();

		const run = store.createRun({
			id: "run-after-dispose",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "do a thing",
			budgetTokens: null,
		});
		run.addAgent({ label: "worker", agentType: "worker", task: "do the thing", model: pendingModel() });
		pump.flushNow();

		expect(requestRender).not.toHaveBeenCalled();
		store.dispose();
	});
});
