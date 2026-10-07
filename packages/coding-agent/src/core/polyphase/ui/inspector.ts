/**
 * `PolyphaseInspector`: the `alt+a` popup overlay listing runs and following an agent's live
 * transcript. See DESIGN.md §12.1-12.6, §12.8.
 */

import type { Component, Focusable, KeybindingsManager, TUI } from "@draht/tui";
import { visibleWidth, wrapTextWithAnsi } from "@draht/tui";
import { combinedKeyHint, keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ArchivedRun } from "../details.ts";
import {
	type ColumnCell,
	columns,
	fitLine,
	formatCost,
	formatDuration,
	formatModelLabel,
	formatTokens,
	oneLine,
	padToWidth,
	statusGlyph,
} from "../render/format.ts";
import { sanitizeChildText, sanitizeSnapshot } from "../render/run-block.ts";
import { type AgentSnapshotRow, type RunSnapshot, snapshotFromDetails, snapshotFromRun } from "../render/snapshot.ts";
import type { PolyphaseSession } from "../session.ts";
import type { AgentStatus, TranscriptItem } from "../types.ts";
import type { SavedWorkflowSummary } from "../workflow/saved.ts";
import {
	sanitizeForDisplay,
	TranscriptLineCache,
	type TranscriptLineRange,
	tailWindowOf,
} from "./transcript-layout.ts";

export type InspectorInitialView =
	| { view: "auto" }
	| { view: "runs" }
	| { view: "run"; runId: string }
	| { view: "agent"; runId: string; agentIndex: number };

export interface InspectorDeps {
	session: PolyphaseSession;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	getArchivedRuns(): readonly ArchivedRun[];
	getSavedWorkflows(): readonly SavedWorkflowSummary[];
	initial: InspectorInitialView;
	showThinking: boolean;
	close(): void;
	insertCommand(text: string): void;
}

const PAGE_SIZE = 10;
const SPLIT_MIN_WIDTH = 120;
const SPLIT_LEFT_WIDTH = 40;

type ViewMode = "runs" | "run" | "agent";

interface RunsRow {
	kind: "live" | "earlier" | "saved";
	runId?: string;
	snapshot?: RunSnapshot;
	saved?: SavedWorkflowSummary;
}

interface CancelTarget {
	runId: string;
	agentIndex?: number;
	label: string;
	finished: boolean;
}

function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

/** Slices `lines` to `height` rows centred on `pivot`, replacing the first/last visible row with
 * a muted "N more" marker when the window hides rows above/below. The window is always centred on
 * `pivot` (clamped only at the list's edges), so `pivot` lands on an edge row of the window only
 * when that edge has nothing hidden past it — the marker never overwrites the selected row. */
function windowAround(lines: readonly string[], height: number, pivot: number, theme: Theme): readonly string[] {
	if (lines.length <= height) return lines;
	const start = Math.max(0, Math.min(pivot - Math.floor(height / 2), lines.length - height));
	const end = start + height;
	const windowed = lines.slice(start, end);
	if (height < 2) return windowed;
	const pivotOffset = pivot - start;
	const marked = windowed.slice();
	if (start > 0 && pivotOffset !== 0) {
		marked[0] = theme.fg("muted", `↑ ${start} more`);
	}
	if (end < lines.length && pivotOffset !== marked.length - 1) {
		marked[marked.length - 1] = theme.fg("muted", `↓ ${lines.length - end} more`);
	}
	return marked;
}

function padLines(lines: readonly string[], height: number): string[] {
	if (lines.length >= height) return lines.slice(0, height);
	return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
}

interface PauseAnchor {
	seq: number;
	lineInItem: number;
}

/** Resolves a pause anchor back to an absolute window-end line (exclusive), against the item line
 * ranges from the most recent render. If the anchored item was evicted, clamps to just past the
 * first still-kept item instead of drifting the view forward by the wrong amount. */
function resolvePauseEndLine(anchor: PauseAnchor, ranges: readonly TranscriptLineRange[], totalLines: number): number {
	const range = ranges.find((r) => r.seq === anchor.seq);
	if (range) return clamp(range.start + anchor.lineInItem + 1, 0, totalLines);
	const first = ranges[0];
	return first ? clamp(first.start + 1, 0, totalLines) : 0;
}

/** Converts an absolute window-end line (exclusive) into a pause anchor on whichever item renders
 * that line, so the anchor survives evictions that shift line numbers. */
function anchorAtEndLine(endLine: number, ranges: readonly TranscriptLineRange[]): PauseAnchor | undefined {
	const lastVisibleLine = endLine - 1;
	for (const range of ranges) {
		if (lastVisibleLine >= range.start && lastVisibleLine < range.end) {
			return { seq: range.seq, lineInItem: lastVisibleLine - range.start };
		}
	}
	const last = ranges[ranges.length - 1];
	return last ? { seq: last.seq, lineInItem: Math.max(0, last.end - last.start - 1) } : undefined;
}

/** Truncates the title (never the right segment or the closing corner) so the border always stays
 * closed, instead of handing the whole assembled string to `fitLine` and letting it cut off
 * whichever happens to sit at the end. */
function borderTop(title: string, right: string, width: number): string {
	const inner = Math.max(0, width - 2);
	let rightSeg = right ? ` ${right} ` : "";
	let rightWidth = visibleWidth(rightSeg);
	if (rightWidth > inner) {
		rightSeg = "";
		rightWidth = 0;
	}
	const minDashes = 1;
	const titleBudget = Math.max(0, inner - rightWidth - minDashes);
	const titleSeg = fitLine(` ${title} `, titleBudget);
	const dashes = Math.max(0, inner - visibleWidth(titleSeg) - rightWidth);
	return `┌${titleSeg}${"─".repeat(dashes)}${rightSeg}┐`;
}

function borderBottom(width: number): string {
	return fitLine(`└${"─".repeat(Math.max(0, width - 2))}┘`, width);
}

function sideLine(content: string, width: number): string {
	const inner = Math.max(0, width - 4);
	return fitLine(`│ ${padToWidth(content, inner)} │`, width);
}

function runsRowKey(row: RunsRow): string {
	if (row.kind === "saved") return `saved:${row.saved?.name ?? ""}`;
	return `run:${row.runId ?? ""}`;
}

function groupLabel(kind: RunsRow["kind"]): string {
	switch (kind) {
		case "live":
			return "Live";
		case "earlier":
			return "Earlier in this session";
		case "saved":
			return "Saved workflows";
	}
}

/** Drops a trailing agent-count suffix (e.g. "subagent parallel · 2 agents"): `runSubtitleText`
 * is the single place that shows the count, so the title must not repeat it. */
const TRAILING_AGENT_COUNT = / · \d+ agents?$/;

/** The phase marker is only meaningful while the run is still progressing through phases; a
 * finished or cancelled run has no "current" phase left, so showing one would misread as still
 * running. */
function isCurrentlyPhased(status: RunSnapshot["status"]): boolean {
	return status === "running";
}

function runTitleText(snapshot: RunSnapshot): string {
	if (snapshot.kind === "workflow") return `workflow ${snapshot.workflow?.name ?? snapshot.title}`;
	if (snapshot.kind === "duet") return `duet · ${snapshot.title}`;
	return snapshot.title.replace(TRAILING_AGENT_COUNT, "");
}

function runSubtitleText(snapshot: RunSnapshot): string {
	if (snapshot.kind === "workflow") {
		const phase =
			isCurrentlyPhased(snapshot.status) && snapshot.currentPhase !== undefined
				? snapshot.phases[snapshot.currentPhase]
				: undefined;
		if (phase) return `▸ ${phase.title}`;
		const n = snapshot.phases.length;
		return n > 0 ? `${n} phase${n === 1 ? "" : "s"}` : "";
	}
	const n = snapshot.agents.length;
	return `${n} agent${n === 1 ? "" : "s"}`;
}

/** `› ` (or `  `) + glyph, always a fixed-width cell outside the title's flex cell: the cursor and
 * status glyph must stay visible even when nothing else does. `columns()`'s own 1-column gap
 * supplies the separator space before the title, matching `› ● label` elsewhere in this file. */
const RUNS_ROW_CURSOR_WIDTH = 3;

function savedWorkflowSourceLabel(source: SavedWorkflowSummary["source"]): string {
	return source === "project" ? "proj" : "user";
}

/** Drops or shrinks the runs-view row's optional columns as `width` decreases, in order of least
 * useful first (tokens, then cost, then the subtitle, then counts and duration), so the title (the
 * flex cell) keeps a usable share of the row instead of being squeezed to nothing by fixed columns
 * that no longer fit. */
function runsRowOptionalWidths(width: number): {
	subtitle: number;
	counts: number;
	duration: number;
	tokens: number;
	cost: number;
} {
	return {
		subtitle: width >= 80 ? 16 : width >= 60 ? 10 : 0,
		counts: width >= 56 ? 10 : 0,
		duration: width >= 50 ? 7 : 0,
		tokens: width >= 70 ? 6 : 0,
		cost: width >= 60 ? 7 : 0,
	};
}

/** The agent detail header's right side (§12.2: `◐ thinking  0:41`) shows only the current activity
 * keyword, not `row.now`'s full content: `row.now` for a thinking/writing agent is `"thinking · <the
 * actual text>"`, and showing that verbatim in the border would leak hidden-thinking content past the
 * `app.thinking.toggle` gate that otherwise hides it in the transcript below. */
function headerActivityText(row: AgentSnapshotRow): string {
	const now = row.now ? oneLine(sanitizeForDisplay(row.now)) : undefined;
	if (!now) return row.status;
	const separator = now.indexOf(" · ");
	return separator === -1 ? now : now.slice(0, separator);
}

/** Mirrors `headerActivityText`'s thinking-keyword cut: the run view's agent list and the split
 * view's left pane must not leak hidden thinking content into the "now" column either (§12.2 shows
 * just `thinking` there), even though the same column shows the activity in full once thinking is
 * visible. */
function agentRowRightText(row: AgentSnapshotRow, showThinking: boolean): string {
	if (row.now) {
		const now = oneLine(sanitizeForDisplay(row.now));
		// "thinking" is the only `computeNowLine()` activity word that can be followed by child-written
		// text; checking the prefix (not the full `"thinking · "` separator) also catches the edge case
		// where the thinking block is still empty and `oneLine()` has trimmed the trailing separator.
		if (!showThinking && now.startsWith("thinking")) return "thinking";
		return now;
	}
	if (row.statusLine) return oneLine(sanitizeForDisplay(row.statusLine));
	if (row.error) return oneLine(sanitizeForDisplay(row.error));
	switch (row.status) {
		case "queued":
			return "queued";
		case "pending":
			return row.step !== undefined && row.step > 1 ? `waits for step ${row.step - 1}` : "not run";
		case "skipped":
			return "not run";
		case "cancelled":
			return "cancelled";
		case "done":
			// A finished agent with no `now` and no `STATUS:` line still has output worth showing
			// (§11.3's tool-row fallback does the same): the first line beats a blank column.
			return row.output ? oneLine(sanitizeForDisplay(row.output)) : "";
		default:
			return "";
	}
}

const COUNT_ORDER: readonly AgentStatus[] = ["running", "done", "failed", "cancelled", "queued", "pending", "skipped"];

function formatCounts(theme: Theme, now: number, counts: Record<AgentStatus, number>): string {
	const parts: string[] = [];
	for (const status of COUNT_ORDER) {
		const n = counts[status];
		if (n > 0) parts.push(`${statusGlyph(status, theme, { now, animate: false })}${n}`);
	}
	return parts.join(" ");
}

function isFinishedAgentStatus(status: AgentStatus): boolean {
	return status === "done" || status === "failed" || status === "cancelled" || status === "skipped";
}

/**
 * The `alt+a` popup. `render()` recomputes the live runs-view list, the current run's agent list
 * and the selected agent's transcript window on every call, since those come straight from the
 * live store; nothing here owns a timer. Dirtiness (when to re-render at all) is the caller's job,
 * driven by `session.store`'s flush notifications.
 */
export class PolyphaseInspector implements Component, Focusable {
	focused = false;

	private readonly deps: InspectorDeps;
	private readonly transcriptCache: TranscriptLineCache;
	private readonly unsubscribe: () => void;

	private mode: ViewMode = "runs";
	private currentRunId: string | undefined;
	private currentAgentIndex: number | undefined;
	private runsRows: RunsRow[] = [];
	private runsSelection = 0;
	private runsSelectionKey: string | undefined;
	private runSelection = 0;
	private following = true;
	/** Anchors the paused window to an item (`seq`) and a line within it, not an absolute line index:
	 * the transcript keeps at most `maxItems`, so a paused run that keeps producing output evicts
	 * older items and shifts every absolute line index after them. Resolved back to an absolute line
	 * on each render via `resolvePauseEndLine`. See `renderAgentDetailBody`. */
	private pauseAnchor: PauseAnchor | undefined;
	private lastTranscriptTotalLines: number | undefined;
	private lastTranscriptRanges: readonly TranscriptLineRange[] = [];
	private lastDetailBodyHeight: number | undefined;
	private lastRenderWidth = 0;
	private showThinking: boolean;
	private showToolPreviews = false;
	private armed: { action: "cancelAgent" | "cancelRun"; runId: string; agentIndex?: number } | undefined;
	private footerNotice: string | undefined;

	constructor(deps: InspectorDeps) {
		this.deps = deps;
		this.showThinking = deps.showThinking;
		this.transcriptCache = new TranscriptLineCache(deps.theme);
		this.resolveInitialView();
		this.unsubscribe = deps.session.store.subscribe((change) => {
			if (change.type === "disposed") {
				this.deps.close();
				return;
			}
			this.deps.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.mode === "runs") {
			this.runsRows = this.buildRunsRows();
			this.runsSelection = this.resolveRunsSelectionIndex(this.runsRows);
		}
		const kb = this.deps.keybindings;

		if (kb.matches(data, "app.polyphase.inspector")) {
			this.deps.close();
			return;
		}
		if (kb.matches(data, "app.polyphase.cancelAgent")) {
			this.handleCancelKey("cancelAgent");
			return;
		}
		if (kb.matches(data, "app.polyphase.cancelRun")) {
			this.handleCancelKey("cancelRun");
			return;
		}

		this.armed = undefined;
		this.footerNotice = undefined;

		if (kb.matches(data, "tui.select.cancel")) {
			this.goBack();
		} else if (kb.matches(data, "app.thinking.toggle")) {
			this.showThinking = !this.showThinking;
		} else if (kb.matches(data, "app.tools.expand")) {
			this.showToolPreviews = !this.showToolPreviews;
		} else if (kb.matches(data, "app.polyphase.follow")) {
			this.toggleFollow();
		} else if (kb.matches(data, "app.polyphase.nextAgent")) {
			this.cycleAgent(1);
		} else if (kb.matches(data, "app.polyphase.previousAgent")) {
			this.cycleAgent(-1);
		} else if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.handlePage(-1);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.handlePage(1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirmSelection();
		}
	}

	render(width: number): string[] {
		this.lastRenderWidth = width;
		const terminal = this.deps.tui.terminal;
		if (width < 40 || terminal.rows < 10) {
			return [fitLine("terminal too small for the agent inspector", width)];
		}
		const height = Math.max(8, terminal.rows - 2);
		const bodyHeight = Math.max(1, height - 2);
		const innerWidth = Math.max(1, width - 4);

		let topTitle: string;
		let topRight: string;
		let bodyLines: string[];

		if (this.mode === "runs") {
			this.runsRows = this.buildRunsRows();
			this.runsSelection = this.resolveRunsSelectionIndex(this.runsRows);
			// Tracks the selection by identity from the very first render, not only once the user has
			// pressed an arrow key, so a live run inserted above the selection between renders cannot
			// change what a subsequent `enter` opens.
			if (this.runsSelectionKey === undefined) {
				const row = this.runsRows[this.runsSelection];
				this.runsSelectionKey = row ? runsRowKey(row) : undefined;
			}
			const liveCount = this.runsRows.filter((row) => row.kind === "live").length;
			const earlierCount = this.runsRows.filter((row) => row.kind === "earlier").length;
			const limiter = this.deps.session.limiter.stats();
			topTitle = `polyphase · ${liveCount} live · ${earlierCount} earlier · slots ${limiter.active}/${limiter.capacity}`;
			topRight = keyHint("app.polyphase.inspector", "close");
			bodyLines = this.renderRunsBody(innerWidth, bodyHeight);
		} else if (this.mode === "run") {
			// Built once here and threaded through, instead of each of the header and the body methods
			// calling `currentRunSnapshot()`/`currentRunAgents()` again: `snapshotFromRun` runs a regex
			// over every agent's output and hashes the whole details object, so repeating it several
			// times per render on every pump flush is wasted work.
			const snapshot = this.currentRunSnapshot();
			const rows = this.sortedAgentsOf(snapshot);
			topTitle = snapshot ? this.runTitleForHeader(snapshot) : "run";
			topRight = snapshot ? this.runHeaderRight(snapshot) : "";
			bodyLines =
				width >= SPLIT_MIN_WIDTH
					? this.renderSplitBody(innerWidth, bodyHeight, rows)
					: this.renderRunBody(innerWidth, bodyHeight, snapshot, rows);
		} else {
			const snapshot = this.currentRunSnapshot();
			const rows = this.sortedAgentsOf(snapshot);
			const row = rows.find((r) => r.i === this.currentAgentIndex);
			const phaseTitle = row?.phase !== undefined ? snapshot?.phases[row.phase]?.title : undefined;
			topTitle = row ? `${row.label} · ${row.agentType}${phaseTitle ? ` · ${phaseTitle}` : ""}` : "agent";
			topRight = row
				? `${statusGlyph(row.status, this.deps.theme, { now: this.now(), animate: false })} ${headerActivityText(row)}${
						row.elapsedMs === undefined ? "" : `  ${formatDuration(row.elapsedMs)}`
					}`
				: "";
			bodyLines = this.renderAgentDetailBody(this.currentAgentIndex, innerWidth, bodyHeight, rows);
		}

		const padded = padLines(bodyLines, bodyHeight);
		return [
			borderTop(topTitle, topRight, width),
			...padded.map((line) => sideLine(line, width)),
			borderBottom(width),
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}

	private now(): number {
		return Date.now();
	}

	// ── Navigation ──────────────────────────────────────────────────────────

	private resolveInitialView(): void {
		const initial = this.deps.initial;
		if (initial.view === "runs") {
			this.mode = "runs";
			return;
		}
		if (initial.view === "run") {
			this.mode = "run";
			this.currentRunId = initial.runId;
			this.selectFirstActiveAgentForCurrentRun();
			return;
		}
		if (initial.view === "agent") {
			this.mode = "agent";
			this.currentRunId = initial.runId;
			this.currentAgentIndex = initial.agentIndex;
			return;
		}
		const liveRuns = this.deps.session.store.runs().filter((run) => run.status === "running");
		if (liveRuns.length === 1) {
			this.mode = "run";
			this.currentRunId = liveRuns[0]?.id;
			this.selectFirstActiveAgentForCurrentRun();
		} else {
			this.mode = "runs";
		}
	}

	private selectFirstActiveAgentForCurrentRun(): void {
		const rows = this.currentRunAgents();
		const idx = rows.findIndex((row) => row.status === "running" || row.status === "starting");
		this.runSelection = idx === -1 ? 0 : idx;
	}

	/** Resolves the runs-view selection by the identity of the previously selected row (its runId or
	 * saved-workflow name), not its index, so a live update that reorders rows between a render and the
	 * next key press does not silently select a different run. Falls back to a clamped index when the
	 * previous row is gone (e.g. an archived run was pruned). */
	private resolveRunsSelectionIndex(rows: readonly RunsRow[]): number {
		if (this.runsSelectionKey !== undefined) {
			const idx = rows.findIndex((row) => runsRowKey(row) === this.runsSelectionKey);
			if (idx !== -1) return idx;
		}
		return clamp(this.runsSelection, 0, Math.max(0, rows.length - 1));
	}

	private resetFollowing(): void {
		this.following = true;
		this.pauseAnchor = undefined;
	}

	private isSplitActive(): boolean {
		return this.lastRenderWidth >= SPLIT_MIN_WIDTH;
	}

	private goBack(): void {
		if (this.mode === "agent") {
			const rows = this.currentRunAgents();
			const idx = rows.findIndex((row) => row.i === this.currentAgentIndex);
			if (idx !== -1) this.runSelection = idx;
			this.mode = "run";
			this.resetFollowing();
			return;
		}
		if (this.mode === "run") {
			// Reselects the run the user came from, so the runs view does not fall back to the index it
			// had before drilling in (which may now point at a different row).
			if (this.currentRunId) this.runsSelectionKey = `run:${this.currentRunId}`;
			this.mode = "runs";
			this.currentRunId = undefined;
			return;
		}
		this.deps.close();
	}

	private confirmSelection(): void {
		if (this.mode === "runs") {
			const row = this.runsRows[this.runsSelection];
			if (!row) return;
			if (row.kind === "saved") {
				const saved = row.saved;
				if (!saved) return;
				if (!saved.valid) {
					this.footerNotice = `/${saved.name} is invalid`;
					return;
				}
				const command = saved.command ? `/${saved.command.replace(/^\//, "")} ` : `/workflow ${saved.name} `;
				this.deps.insertCommand(command);
				this.deps.close();
				return;
			}
			if (row.runId) {
				this.currentRunId = row.runId;
				this.mode = "run";
				this.selectFirstActiveAgentForCurrentRun();
			}
			return;
		}
		if (this.mode === "run") {
			const rows = this.currentRunAgents();
			const row = rows[this.runSelection];
			if (!row) return;
			this.currentAgentIndex = row.i;
			this.mode = "agent";
			this.resetFollowing();
		}
	}

	private moveSelection(delta: number): void {
		if (this.mode === "runs") {
			if (this.runsRows.length === 0) return;
			this.runsSelection = clamp(this.runsSelection + delta, 0, this.runsRows.length - 1);
			const row = this.runsRows[this.runsSelection];
			this.runsSelectionKey = row ? runsRowKey(row) : undefined;
			return;
		}
		if (this.mode === "run") {
			const rows = this.currentRunAgents();
			if (rows.length === 0) return;
			const next = clamp(this.runSelection + delta, 0, rows.length - 1);
			if (next !== this.runSelection) {
				this.runSelection = next;
				this.resetFollowing();
			}
			return;
		}
		this.scrollTranscript(delta);
	}

	/** Shared by the agent detail view and, in split view, by page keys on the run view: both drive
	 * the same `following`/`pauseAnchor` pair against whichever agent is currently shown on the
	 * right. */
	private scrollTranscript(delta: number): void {
		const total = this.lastTranscriptTotalLines ?? 0;
		const ranges = this.lastTranscriptRanges;
		const visible = Math.max(1, this.lastDetailBodyHeight ?? 1);
		const currentEnd = this.pauseAnchor ? resolvePauseEndLine(this.pauseAnchor, ranges, total) : total;
		if (delta < 0) {
			if (total <= visible) return;
			const minEnd = Math.min(total, visible);
			this.pauseAnchor = anchorAtEndLine(Math.max(minEnd, currentEnd + delta), ranges);
			this.following = false;
		} else if (delta > 0 && this.pauseAnchor !== undefined) {
			const next = Math.min(total, currentEnd + delta);
			if (next >= total) {
				this.pauseAnchor = undefined;
				this.following = true;
			} else {
				this.pauseAnchor = anchorAtEndLine(next, ranges);
			}
		}
	}

	/** Page keys scroll the right pane in split view (§12.2) instead of moving the left selection by
	 * a page. Up/down always move the left selection; only page keys are redirected. */
	private handlePage(direction: 1 | -1): void {
		if (this.mode === "run" && this.isSplitActive()) {
			this.scrollTranscript(direction * PAGE_SIZE);
			return;
		}
		this.moveSelection(direction * PAGE_SIZE);
	}

	private cycleAgent(direction: 1 | -1): void {
		if (this.mode === "run") {
			const rows = this.currentRunAgents();
			if (rows.length === 0) return;
			this.runSelection = (this.runSelection + direction + rows.length) % rows.length;
			this.resetFollowing();
			return;
		}
		if (this.mode === "agent") {
			const rows = this.currentRunAgents();
			if (rows.length === 0) return;
			const curIdx = rows.findIndex((row) => row.i === this.currentAgentIndex);
			const nextIdx = ((curIdx === -1 ? 0 : curIdx) + direction + rows.length) % rows.length;
			this.currentAgentIndex = rows[nextIdx]?.i;
			this.resetFollowing();
		}
	}

	private toggleFollow(): void {
		if (this.mode !== "agent" && !(this.mode === "run" && this.isSplitActive())) return;
		if (this.following) {
			const anchor = anchorAtEndLine(this.lastTranscriptTotalLines ?? 0, this.lastTranscriptRanges);
			// An empty transcript (no ranges yet, or the archived/retention-dropped summary body, which
			// never sets any ranges) has nothing to anchor a pause to. Pressing `f` must stay a no-op
			// then, not flip into a paused state the view can never escape: `scrollTranscript` only
			// resumes following once `pauseAnchor` advances to the end, which it can never do without an
			// anchor.
			if (anchor === undefined) return;
			this.pauseAnchor = anchor;
			this.following = false;
		} else {
			this.resetFollowing();
		}
	}

	// ── Two-press cancel (§12.4) ────────────────────────────────────────────

	private handleCancelKey(action: "cancelAgent" | "cancelRun"): void {
		const target = this.cancelTarget(action);
		if (!target) {
			this.armed = undefined;
			this.footerNotice = undefined;
			return;
		}
		const sameTarget =
			this.armed?.action === action &&
			this.armed.runId === target.runId &&
			this.armed.agentIndex === target.agentIndex;
		if (sameTarget) {
			this.armed = undefined;
			this.footerNotice = undefined;
			if (action === "cancelAgent" && target.agentIndex !== undefined) {
				this.deps.session.store.cancelAgent(target.runId, target.agentIndex);
			} else {
				this.deps.session.store.cancelRun(target.runId);
			}
			return;
		}
		if (target.finished) {
			this.armed = undefined;
			this.footerNotice = "already finished";
			return;
		}
		this.armed = { action, runId: target.runId, agentIndex: target.agentIndex };
		this.footerNotice =
			action === "cancelAgent" ? `press x again to cancel ${target.label}` : "press X again to cancel the run";
	}

	private cancelTarget(action: "cancelAgent" | "cancelRun"): CancelTarget | undefined {
		if (action === "cancelAgent") {
			if (this.mode === "run") {
				const row = this.currentRunAgents()[this.runSelection];
				if (!row || !this.currentRunId) return undefined;
				return {
					runId: this.currentRunId,
					agentIndex: row.i,
					label: row.label,
					finished: isFinishedAgentStatus(row.status),
				};
			}
			if (this.mode === "agent") {
				const row = this.currentAgentRow();
				if (!row || !this.currentRunId) return undefined;
				return {
					runId: this.currentRunId,
					agentIndex: row.i,
					label: row.label,
					finished: isFinishedAgentStatus(row.status),
				};
			}
			return undefined;
		}
		if (this.mode === "runs") {
			const row = this.runsRows[this.runsSelection];
			if (!row || row.kind === "saved" || !row.runId || !row.snapshot) return undefined;
			return { runId: row.runId, label: row.snapshot.title, finished: row.snapshot.status !== "running" };
		}
		const snapshot = this.currentRunSnapshot();
		if (!snapshot || !this.currentRunId) return undefined;
		return { runId: this.currentRunId, label: snapshot.title, finished: snapshot.status !== "running" };
	}

	// ── Data access ─────────────────────────────────────────────────────────

	private buildRunsRows(): RunsRow[] {
		const store = this.deps.session.store;
		const allRuns = store.runs();
		const liveRuns = allRuns.filter((run) => run.status === "running");
		const finishedLive = allRuns.filter((run) => run.status !== "running");
		const knownIds = new Set([...liveRuns, ...finishedLive].map((run) => run.id));
		const archived = this.deps.getArchivedRuns().filter((entry) => !knownIds.has(entry.runId));

		const rows: RunsRow[] = [];
		for (const run of liveRuns) {
			rows.push({
				kind: "live",
				runId: run.id,
				snapshot: sanitizeSnapshot(
					snapshotFromRun(run, { now: this.now(), tailItems: 0, limiter: this.deps.session.limiter.stats() }),
				),
			});
		}
		for (const run of finishedLive) {
			rows.push({
				kind: "earlier",
				runId: run.id,
				snapshot: sanitizeSnapshot(snapshotFromRun(run, { now: this.now(), tailItems: 0 })),
			});
		}
		for (const entry of archived) {
			rows.push({
				kind: "earlier",
				runId: entry.runId,
				snapshot: sanitizeSnapshot(snapshotFromDetails(entry.details, { now: this.now() })),
			});
		}
		for (const saved of this.deps.getSavedWorkflows()) {
			rows.push({ kind: "saved", saved });
		}
		return rows;
	}

	private currentRunSnapshot(): RunSnapshot | undefined {
		if (!this.currentRunId) return undefined;
		const liveRun = this.deps.session.store.getRun(this.currentRunId);
		if (liveRun) {
			return sanitizeSnapshot(
				snapshotFromRun(liveRun, { now: this.now(), tailItems: 0, limiter: this.deps.session.limiter.stats() }),
			);
		}
		const archived = this.deps.getArchivedRuns().find((entry) => entry.runId === this.currentRunId);
		return archived ? sanitizeSnapshot(snapshotFromDetails(archived.details, { now: this.now() })) : undefined;
	}

	private sortedAgentsOf(snapshot: RunSnapshot | undefined): AgentSnapshotRow[] {
		if (!snapshot) return [];
		return [...snapshot.agents].sort((a, b) => a.i - b.i);
	}

	private currentRunAgents(): AgentSnapshotRow[] {
		return this.sortedAgentsOf(this.currentRunSnapshot());
	}

	private currentAgentRow(): AgentSnapshotRow | undefined {
		if (this.currentAgentIndex === undefined) return undefined;
		return this.currentRunAgents().find((row) => row.i === this.currentAgentIndex);
	}

	private currentAgentTranscriptFor(
		agentIndex: number,
	): { items: readonly TranscriptItem[]; dropped: number } | undefined {
		if (!this.currentRunId) return undefined;
		const run = this.deps.session.store.getRun(this.currentRunId);
		const agent = run?.agents[agentIndex];
		// Retention drops every agent's transcript on a finished run once it falls past
		// `keepTranscriptRuns`; `undefined` here sends the caller to the archived-style summary body
		// (status, output, error, the "only kept while in memory" note) instead of an empty transcript.
		if (!run || !agent || run.transcriptsDropped) return undefined;
		return { items: agent.state.transcript, dropped: agent.state.droppedItems };
	}

	// ── Rendering ───────────────────────────────────────────────────────────

	private formatRunsRow(row: RunsRow, width: number, selected: boolean): string {
		const cursor = selected ? "› " : "  ";
		if (row.kind === "saved" && row.saved) {
			const saved = row.saved;
			// `name`/`description` come from the saved script's own meta block (`workflow/meta.ts`), the
			// same kind of script-supplied text `sanitizeSnapshot` cleans for live/archived runs.
			const nameText = `${cursor}/${sanitizeChildText(saved.name)}`;
			return columns(
				[
					{ text: saved.valid ? nameText : this.deps.theme.fg("error", `${nameText} invalid`), width: 18 },
					{ text: sanitizeChildText(saved.description), width: "flex" },
					{ text: savedWorkflowSourceLabel(saved.source), width: 4, align: "right" },
				],
				width,
			);
		}
		const snapshot = row.snapshot;
		if (!snapshot) return fitLine(`${cursor}?`, width);
		const glyph = statusGlyph(snapshot.status, this.deps.theme, { now: this.now(), animate: false });
		const optional = runsRowOptionalWidths(width);
		// The cursor, glyph and title are fixed/flex cells ahead of every optional column, so they
		// always render, even at widths where every optional column below has been dropped.
		const cells: ColumnCell[] = [
			{ text: `${cursor}${glyph}`, width: RUNS_ROW_CURSOR_WIDTH },
			{ text: runTitleText(snapshot), width: "flex" },
		];
		if (optional.subtitle > 0) cells.push({ text: runSubtitleText(snapshot), width: optional.subtitle });
		if (optional.counts > 0) {
			cells.push({ text: formatCounts(this.deps.theme, this.now(), snapshot.counts), width: optional.counts });
		}
		if (optional.duration > 0) {
			cells.push({ text: formatDuration(snapshot.elapsedMs), width: optional.duration, align: "right" });
		}
		if (optional.tokens > 0) {
			cells.push({
				text: snapshot.tokens > 0 ? formatTokens(snapshot.tokens) : "",
				width: optional.tokens,
				align: "right",
			});
		}
		if (optional.cost > 0) cells.push({ text: formatCost(snapshot.cost), width: optional.cost, align: "right" });
		return columns(cells, width);
	}

	private renderRunsBody(width: number, height: number): string[] {
		const rows = this.runsRows;
		const lines: string[] = [];
		const lineForRow: number[] = [];
		let lastKind: RunsRow["kind"] | undefined;
		rows.forEach((row, idx) => {
			if (row.kind !== lastKind) {
				lines.push(this.deps.theme.bold(groupLabel(row.kind)));
				lastKind = row.kind;
			}
			lineForRow[idx] = lines.length;
			lines.push(this.formatRunsRow(row, width, idx === this.runsSelection));
		});
		if (rows.length === 0) {
			lines.push('No agents yet. Put "polyphase" in a prompt or run /workflow <name>.');
		}
		const pivot = lineForRow[this.runsSelection] ?? 0;
		const contentHeight = Math.max(1, height - 1);
		const windowed = padLines(windowAround(lines, contentHeight, pivot, this.deps.theme), contentHeight);
		return [...windowed, this.footerLine(this.runsHintLine(), width)];
	}

	private formatAgentRow(row: AgentSnapshotRow, width: number, selected: boolean): string {
		const cursor = selected ? "› " : "  ";
		const glyph = statusGlyph(row.status, this.deps.theme, { now: this.now(), animate: false });
		const model = formatModelLabel(row, { withProvider: false });
		const cells: ColumnCell[] = [
			{ text: `${cursor}${glyph} ${row.label}`, width: 18 },
			{ text: model, width: 20 },
		];
		// Dropped below 60 columns, the same threshold `layoutRun` uses for its elapsed column: at
		// the 40-column split-pane width there is no room for a 5th fixed cell ahead of the flex one.
		if (width >= 60) {
			cells.push({
				text: row.elapsedMs === undefined ? "" : formatDuration(row.elapsedMs),
				width: 5,
				align: "right",
			});
		}
		cells.push({ text: agentRowRightText(row, this.showThinking), width: "flex" });
		return columns(cells, width);
	}

	private runTitleForHeader(snapshot: RunSnapshot): string {
		const base = runTitleText(snapshot);
		if (snapshot.kind === "workflow" && isCurrentlyPhased(snapshot.status) && snapshot.currentPhase !== undefined) {
			const phase = snapshot.phases[snapshot.currentPhase];
			if (phase) return `${base} ▸ ${phase.title}`;
		}
		return base;
	}

	private runHeaderRight(snapshot: RunSnapshot): string {
		const parts = [formatCounts(this.deps.theme, this.now(), snapshot.counts), formatDuration(snapshot.elapsedMs)];
		if (snapshot.tokens > 0) parts.push(formatTokens(snapshot.tokens));
		const cost = formatCost(snapshot.cost);
		if (cost) parts.push(cost);
		return parts.filter((part) => part.length > 0).join("  ");
	}

	private renderRunBody(
		width: number,
		height: number,
		snapshot: RunSnapshot | undefined,
		rows: AgentSnapshotRow[],
	): string[] {
		if (!snapshot) return [this.deps.theme.fg("muted", "run not found")];
		this.runSelection = clamp(this.runSelection, 0, Math.max(0, rows.length - 1));

		const lines: string[] = [];
		const lineForAgent: number[] = [];
		if (snapshot.phases.length > 0) {
			// Agents spawned before any phase()/agent({phase}) call (§13.3) carry no phase index; they
			// are still selectable, so they get an ungrouped block ahead of the phase list instead of
			// being silently dropped from the view.
			rows.forEach((row, idx) => {
				if (row.phase !== undefined) return;
				lineForAgent[idx] = lines.length;
				lines.push(this.formatAgentRow(row, width, idx === this.runSelection));
			});
			for (const phase of snapshot.phases) {
				lines.push(
					columns(
						[
							{
								text: `${statusGlyph(phase.status, this.deps.theme, { now: this.now(), animate: false })} ${phase.index + 1} ${phase.title}`,
								width: "flex",
							},
							{ text: `${phase.done}/${phase.total}`, width: 7, align: "right" },
							{
								text: phase.elapsedMs === undefined ? "" : formatDuration(phase.elapsedMs),
								width: 7,
								align: "right",
							},
						],
						width,
					),
				);
				rows.forEach((row, idx) => {
					if (row.phase !== phase.index) return;
					lineForAgent[idx] = lines.length;
					lines.push(`    ${this.formatAgentRow(row, Math.max(1, width - 4), idx === this.runSelection)}`);
				});
			}
		} else {
			rows.forEach((row, idx) => {
				lineForAgent[idx] = lines.length;
				const prefix = row.step !== undefined ? `${row.step} ` : "";
				lines.push(
					`${prefix}${this.formatAgentRow(row, Math.max(1, width - prefix.length), idx === this.runSelection)}`,
				);
			});
		}
		if (snapshot.log.length > 0) {
			lines.push(`» ${oneLine(sanitizeForDisplay(snapshot.log[snapshot.log.length - 1] ?? ""))}`);
		} else if (snapshot.resultPreview && snapshot.status !== "running") {
			lines.push(`→ ${oneLine(sanitizeForDisplay(snapshot.resultPreview))}`);
		}

		const pivot = lineForAgent[this.runSelection] ?? 0;
		const contentHeight = Math.max(1, height - 1);
		const windowed = padLines(windowAround(lines, contentHeight, pivot, this.deps.theme), contentHeight);
		return [...windowed, this.footerLine(this.runHintLine(), width)];
	}

	private renderSplitBody(width: number, height: number, rows: AgentSnapshotRow[]): string[] {
		const rightWidth = Math.max(1, width - SPLIT_LEFT_WIDTH - 1);
		this.runSelection = clamp(this.runSelection, 0, Math.max(0, rows.length - 1));
		const leftLines = rows.map((row, idx) =>
			fitLine(this.formatAgentRow(row, SPLIT_LEFT_WIDTH, idx === this.runSelection), SPLIT_LEFT_WIDTH),
		);
		const selectedAgentIndex = rows[this.runSelection]?.i;
		const rightLines = this.renderAgentDetailBody(selectedAgentIndex, rightWidth, height, rows);
		// Windowed the same way `renderRunBody` windows the flat agent list, so a run with more agents
		// than the pane has rows keeps the `›` cursor on screen instead of scrolling it off the top.
		const paddedLeft = padLines(windowAround(leftLines, height, this.runSelection, this.deps.theme), height);
		const paddedRight = padLines(rightLines, height);
		return paddedLeft.map((line, idx) => `${padToWidth(line, SPLIT_LEFT_WIDTH)}│${paddedRight[idx] ?? ""}`);
	}

	private renderAgentDetailBody(
		agentIndex: number | undefined,
		width: number,
		height: number,
		rows: AgentSnapshotRow[],
	): string[] {
		const footerFallback = this.agentHintLine();
		const contentHeight = Math.max(1, height - 1);
		if (agentIndex === undefined) {
			return [
				...padLines([this.deps.theme.fg("muted", "no agent selected")], contentHeight),
				this.footerLine(footerFallback, width),
			];
		}
		const row = rows.find((r) => r.i === agentIndex);
		if (!row) {
			return [
				...padLines([this.deps.theme.fg("muted", "agent not found")], contentHeight),
				this.footerLine(footerFallback, width),
			];
		}

		const header: string[] = [];
		const modelLabel = formatModelLabel(row, { withProvider: true, withSource: true });
		const confirmText = row.modelConfirmed ? "confirmed" : "unconfirmed";
		const tokensText = row.tokens > 0 ? ` · ${formatTokens(row.tokens)} tok` : "";
		const costText = row.cost > 0 ? ` · ${formatCost(row.cost)}` : "";
		const turnsText = `${row.turns} turn${row.turns === 1 ? "" : "s"}`;
		const toolsText = `${row.toolCalls} tool${row.toolCalls === 1 ? "" : "s"}`;
		header.push(oneLine(`${modelLabel} · ${confirmText} · ${turnsText} · ${toolsText}${tokensText}${costText}`));
		header.push(`task  ${oneLine(row.task)}`);
		header.push("─".repeat(Math.max(0, width)));

		const footer = this.footerLine(this.agentHintLine(row.status), width);
		const transcript = this.currentAgentTranscriptFor(agentIndex);
		if (!transcript) {
			const OUTPUT_PREVIEW_MAX_LINES = 8;
			let statusLines = row.statusLine ? 1 : 0;
			let errorLines = row.error ? 1 : 0;
			const noteLines = 1;
			// The note explains why the transcript is gone, so it must survive trimming even at the
			// smallest supported height: reserve header + note first, then drop error, then status,
			// before giving any remaining budget to the output preview. `padLines` below only pads or
			// truncates from the end, so whatever we build here must already fit `contentHeight`.
			if (header.length + statusLines + errorLines + noteLines > contentHeight && errorLines > 0) {
				errorLines = 0;
			}
			if (header.length + statusLines + errorLines + noteLines > contentHeight && statusLines > 0) {
				statusLines = 0;
			}
			const outputBudget = row.output
				? Math.max(0, contentHeight - header.length - statusLines - errorLines - noteLines - 1)
				: 0;
			const body = [...header];
			if (statusLines > 0 && row.statusLine) {
				body.push(fitLine(`status  ${oneLine(sanitizeForDisplay(row.statusLine))}`, width));
			}
			if (row.output && outputBudget > 0) {
				body.push("output");
				body.push(
					...wrapTextWithAnsi(sanitizeForDisplay(row.output), Math.max(1, width - 2))
						.slice(0, Math.min(OUTPUT_PREVIEW_MAX_LINES, outputBudget))
						.map((line) => fitLine(`  ${line}`, width)),
				);
			}
			if (errorLines > 0 && row.error) body.push(fitLine(`error  ${oneLine(sanitizeForDisplay(row.error))}`, width));
			body.push(this.deps.theme.fg("muted", "Live transcript is only kept while the run is in memory."));
			this.lastTranscriptTotalLines = undefined;
			this.lastTranscriptRanges = [];
			this.lastDetailBodyHeight = undefined;
			return [...padLines(body, contentHeight), footer];
		}

		const owner = `${this.currentRunId}:${agentIndex}`;
		const transcriptLines = this.transcriptCache.linesFor(owner, transcript.items, transcript.dropped, {
			width,
			showThinking: this.showThinking,
			showToolPreviews: this.showToolPreviews,
			now: this.now(),
		});
		const tail = tailWindowOf(transcriptLines);
		this.lastTranscriptTotalLines = tail.totalLines;
		this.lastTranscriptRanges = this.transcriptCache.lineRanges();
		// A finished or cancelled agent has nothing left to follow or pause: the indicator row only
		// makes sense while the agent could still produce more output.
		const showFollowLine = !isFinishedAgentStatus(row.status);
		const transcriptRows = Math.max(1, contentHeight - header.length - (showFollowLine ? 1 : 0));
		this.lastDetailBodyHeight = transcriptRows;
		const pinnedEndLine = this.pauseAnchor
			? resolvePauseEndLine(this.pauseAnchor, this.lastTranscriptRanges, tail.totalLines)
			: undefined;
		const offsetFromEnd = this.following ? 0 : Math.max(0, tail.totalLines - (pinnedEndLine ?? tail.totalLines));
		const windowLines = padLines(tail.window(transcriptRows, offsetFromEnd), transcriptRows);
		const followLine = showFollowLine
			? [fitLine(this.following ? "◆ following" : "‖ paused · f to follow", width)]
			: [];
		const body = [...header, ...windowLines, ...followLine];
		return [...padLines(body, contentHeight), footer];
	}

	/** `width` is the same inner width the caller laid its body out to, so a hint line that does not
	 * fit is ellipsised like every other row instead of being hard-cut by `sideLine`'s padding,
	 * which carries no ellipsis of its own. */
	private footerLine(hint: string, width: number): string {
		return fitLine(this.footerNotice ? this.deps.theme.fg("warning", this.footerNotice) : hint, width);
	}

	private runsHintLine(): string {
		return [
			combinedKeyHint(["tui.select.up", "tui.select.down"], "select"),
			keyHint("tui.select.confirm", "open"),
			keyHint("app.polyphase.cancelRun", "cancel run"),
			keyHint("tui.select.cancel", "close"),
		].join("  ");
	}

	private runHintLine(): string {
		return [
			combinedKeyHint(["tui.select.up", "tui.select.down"], "select"),
			keyHint("tui.select.confirm", "follow"),
			keyHint("app.polyphase.cancelAgent", "cancel agent"),
			keyHint("app.polyphase.cancelRun", "cancel run"),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}

	private agentHintLine(status?: AgentStatus): string {
		const finished = status !== undefined && isFinishedAgentStatus(status);
		return [
			keyHint("app.polyphase.nextAgent", "next agent"),
			...(finished ? [] : [keyHint("app.polyphase.follow", "follow")]),
			keyHint("app.thinking.toggle", "thinking"),
			...(finished ? [] : [keyHint("app.polyphase.cancelAgent", "cancel")]),
			keyHint("tui.select.cancel", "back"),
		].join("  ");
	}
}
