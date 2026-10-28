/**
 * `PolyphaseDock`: the one-line summary widget shown above the editor while any run is active
 * (`ctx.ui.setWidget("polyphase", ..., { placement: "aboveEditor" })`). See DESIGN.md §12.6.
 * Owns no timers: it reads the store at render time and asks the TUI to re-render on every flush.
 */

import type { Component, TUI } from "@draht/tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { fitLine, formatCost, spinnerFrame } from "../render/format.ts";
import { layoutRun } from "../render/run-block.ts";
import { snapshotFromRun } from "../render/snapshot.ts";
import type { PolyphaseSession } from "../session.ts";
import type { RunView } from "../types.ts";

const DOCK_MAX_LINES = 10;
const COMMAND_RUN_MAX_LINES = 8;

export interface PolyphaseDockDeps {
	session: PolyphaseSession;
	tui: TUI;
	theme: Theme;
	now?: () => number;
}

interface DockSummary {
	runs: number;
	active: number;
	queued: number;
	done: number;
	failed: number;
	cancelled: number;
	cost: number;
}

/** Live counts only: running runs, and the done/failed/cancelled/queued/active/cost of those
 * runs' own agents (§12.6's "2 runs · 3 running · 1 queued · 6 done" reads as running runs plus an
 * agent-level breakdown within them) — never `store.totals()`'s session-wide retained totals,
 * which include every finished run still kept for `/workflows list` and the inspector. */
function liveSummary(runs: readonly RunView[]): DockSummary {
	const summary: DockSummary = { runs: 0, active: 0, queued: 0, done: 0, failed: 0, cancelled: 0, cost: 0 };
	for (const run of runs) {
		if (run.status !== "running") continue;
		summary.runs++;
		for (const agent of run.agents) {
			if (agent.status === "queued") summary.queued++;
			if (agent.status === "starting" || agent.status === "running") summary.active++;
			if (agent.status === "done") summary.done++;
			if (agent.status === "failed") summary.failed++;
			if (agent.status === "cancelled") summary.cancelled++;
			summary.cost += agent.state.usage?.cost.total ?? 0;
			summary.cost += agent.state.liveUsage?.cost.total ?? 0;
		}
	}
	return summary;
}

function summaryLine(summary: DockSummary, theme: Theme, now: number): string {
	const parts = ["polyphase", `${summary.runs} run${summary.runs === 1 ? "" : "s"}`];
	if (summary.active > 0) parts.push(`${summary.active} running`);
	if (summary.queued > 0) parts.push(`${summary.queued} queued`);
	if (summary.done > 0) parts.push(`${summary.done} done`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
	const cost = formatCost(summary.cost);
	if (cost) parts.push(cost);
	parts.push(keyHint("app.polyphase.inspector", "inspect"));
	return `${theme.fg("accent", spinnerFrame(now))} ${parts.join(" · ")}`;
}

/** `Component` for `ctx.ui.setWidget`'s `(tui, theme) => Component & { dispose?(): void }` factory. */
export class PolyphaseDock implements Component {
	private readonly deps: PolyphaseDockDeps;
	private readonly unsubscribe: () => void;
	private cacheKey: string | undefined;
	private cachedLines: string[] = [];

	constructor(deps: PolyphaseDockDeps) {
		this.deps = deps;
		this.unsubscribe = deps.session.store.subscribe(() => {
			deps.tui.requestRender();
		});
	}

	render(width: number): string[] {
		const now = this.now();
		const store = this.deps.session.store;
		const runs = store.runs();
		// Recomputing `totals()` plus a `snapshotFromRun`/`layoutRun` pass per running command
		// workflow on every render (including every editor keystroke, since the TUI redraws the
		// whole screen on each one) would walk every retained run's agents and up to 200 log lines
		// each time. Every input that can change what this widget shows bumps some run's `version`,
		// so a signature of (width, spinner frame, run versions) is enough to skip that work when
		// nothing has actually changed since the last render.
		const spinner = spinnerFrame(now);
		// A second-granularity term alongside the spinner frame: the frame alone cycles every second
		// (4 frames at 250ms each), so a render exactly N seconds after the last one would otherwise
		// hit the cache and show a stale elapsed time from `layoutRun`'s live duration.
		const key = `${width}|${spinner}|${Math.floor(now / 1000)}|${runs.map((run) => `${run.id}:${run.version}`).join(",")}`;
		if (key === this.cacheKey) return this.cachedLines;
		this.cacheKey = key;

		const lines: string[] = [fitLine(summaryLine(liveSummary(runs), this.deps.theme, now), width)];
		for (const run of runs) {
			if (lines.length >= DOCK_MAX_LINES) break;
			if (run.status !== "running" || run.kind !== "workflow" || run.origin !== "command") continue;
			const snapshot = snapshotFromRun(run, { now, tailItems: 0 });
			const body = layoutRun(snapshot, width, this.deps.theme, {
				expanded: false,
				partial: true,
				focus: true,
				maxLines: COMMAND_RUN_MAX_LINES,
				hints: false,
				now,
			});
			for (const line of body) {
				if (lines.length >= DOCK_MAX_LINES) break;
				lines.push(fitLine(line, width));
			}
		}
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cacheKey = undefined;
	}

	dispose(): void {
		this.unsubscribe();
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}
}
