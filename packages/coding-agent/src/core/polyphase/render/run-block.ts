/**
 * Layout for one polyphase run's tool-row content (§11.3-11.4): `layoutRun` turns a `RunSnapshot`
 * into fitted lines, and `PolyphaseRunBlock` is the `Component` `render/renderers.ts` reuses across
 * re-renders of the same tool call. Every line goes through `fitLine` as the last step (§0 width
 * safety); no timers live here (§11.2.5) — the animated frame comes from `options.now`.
 */

import { type Component, visibleWidth } from "@draht/tui";
import { keyHint, keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { normalizeDisplayText, replaceTabs } from "../../tools/render-utils.ts";
import type { AgentStatus, CancelReason, TranscriptItem } from "../types.ts";
import {
	type ColumnCell,
	columns,
	fitLine,
	formatCost,
	formatDuration,
	formatModelLabel,
	formatTokens,
	oneLine,
	spinnerFrame,
	statusGlyph,
} from "./format.ts";
import type { AgentSnapshotRow, PhaseSnapshot, RunSnapshot } from "./snapshot.ts";

export interface RunLayoutOptions {
	expanded: boolean;
	partial: boolean;
	/** Only the focused row animates and shows live elapsed/now/tokens (§11.2.2). */
	focus: boolean;
	/** Row budget for agent/phase content, excluding the summary and hint lines (§11.2.3). */
	maxLines: number;
	hints: boolean;
	now: number;
}

const COUNT_ORDER: readonly AgentStatus[] = ["running", "done", "failed", "cancelled", "queued", "pending", "skipped"];

const STATUS_WORDS: Record<AgentStatus, string> = {
	pending: "pending",
	queued: "queued",
	starting: "starting",
	running: "running",
	done: "done",
	failed: "failed",
	cancelled: "cancelled",
	skipped: "skipped",
};

const FINISHED_STATUSES: readonly AgentStatus[] = ["done", "failed", "cancelled", "skipped"];

function isFinished(status: AgentStatus): boolean {
	return FINISHED_STATUSES.includes(status);
}

function firstLine(text: string): string {
	const idx = text.indexOf("\n");
	return idx === -1 ? text : text.slice(0, idx);
}

/** Whether this row/run may show animated or live-only content: elapsed, live tokens/cost, the
 * now column and the transcript tail (§11.2.2). False only for a non-focused partial row, which
 * must render static content that changes only on an agent's status transition. */
function isLive(options: RunLayoutOptions): boolean {
	return options.focus || !options.partial;
}

function staticHintText(): string {
	return `live view on the newest run · ${keyText("app.polyphase.inspector")}`;
}

/** Packs `left` and `right` onto one line with at least a two-space gap; falls back to a plain
 * concatenation (later clipped by `fitLine`) when both together would not fit. */
function joinLeftRight(left: string, right: string, width: number): string {
	if (!right) return left;
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const minGap = 2;
	if (leftWidth + minGap + rightWidth >= width) return `${left} ${right}`;
	return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

function slotsBusySuffix(limiter: RunSnapshot["limiter"], queued: number): string {
	if (!limiter || queued <= 0 || limiter.active < limiter.capacity) return "";
	return ` (${limiter.active}/${limiter.capacity} slots busy)`;
}

function rightSummaryParts(snapshot: RunSnapshot): string[] {
	const parts: string[] = [formatDuration(snapshot.elapsedMs)];
	if (snapshot.budget) {
		parts.push(`${formatTokens(snapshot.budget.spentTokens)}/${formatTokens(snapshot.budget.totalTokens)} tok`);
	} else if (snapshot.tokens > 0) {
		parts.push(`${formatTokens(snapshot.tokens)} tok`);
	}
	const cost = formatCost(snapshot.cost);
	if (cost) parts.push(cost);
	return parts;
}

/** Joins `left` and as many of `rightParts` (in order) as fit at `width`, dropping whole parts from
 * the end rather than cutting one mid-token (§11.3's "drop parts from the right when space runs
 * out"). */
function joinLeftRightParts(left: string, rightParts: readonly string[], width: number): string {
	for (let count = rightParts.length; count > 0; count--) {
		const candidate = joinLeftRight(left, rightParts.slice(0, count).join(" · "), width);
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return left;
}

function liveCountsLeft(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions): string {
	const merged: Record<AgentStatus, number> = {
		...snapshot.counts,
		running: snapshot.counts.running + snapshot.counts.starting,
	};
	const pieces: string[] = [];
	for (const status of COUNT_ORDER) {
		const n = merged[status];
		if (n <= 0) continue;
		const animate = options.focus && options.partial && status === "running";
		pieces.push(`${statusGlyph(status, theme, { now: options.now, animate })} ${n} ${STATUS_WORDS[status]}`);
	}
	const left =
		pieces.length > 0
			? pieces.join(" · ")
			: `${statusGlyph("running", theme, { now: options.now, animate: options.focus && options.partial })} 0 running`;
	// The limiter reflects every run's slots, not just this one's, so the suffix must stay off
	// static rows (§11.2.2): it can otherwise change a row with no status transition of its own.
	return isLive(options) ? left + slotsBusySuffix(snapshot.limiter, merged.queued) : left;
}

/** "cancelled by you" only when every cancelled agent was cancelled by the user; otherwise the
 * generic word, since a budget/parent/shutdown cancel was not the user's doing. */
function cancelledByText(agents: readonly AgentSnapshotRow[]): string {
	const cancelled = agents.filter((a) => a.status === "cancelled");
	const byUser =
		cancelled.length > 0 && cancelled.every((a) => a.cancelReason === "user" || a.cancelReason === undefined);
	return byUser ? "cancelled by you" : "cancelled";
}

/** A single agent's cancel wording: `cancelled by you` for the user, else `cancelled by <reason>`
 * (budget/run/parent/shutdown), matching §11.4's mockup wording for the user case. */
function cancelReasonText(reason: CancelReason | undefined): string {
	if (!reason) return "cancelled";
	return reason === "user" ? "cancelled by you" : `cancelled by ${reason}`;
}

/** Child-sourced text (output, error, status/now lines, task, tool summaries, labels, log lines,
 * result previews) may carry ANSI/OSC sequences, raw tabs or a trailing CR. Stripped and normalized
 * before any width math runs, so `visibleWidth`/`fitLine` see exactly what the terminal will draw
 * (§0 width safety): a bare tab would otherwise jump to the terminal's own 8-column stop regardless
 * of the 3-column width this file assumes, and a CR would move the cursor back to column 0. */
export function sanitizeChildText(text: string): string {
	return normalizeDisplayText(replaceTabs(sanitizeBinaryOutput(stripAnsi(text))));
}

function sanitizeRow(row: AgentSnapshotRow): AgentSnapshotRow {
	return {
		...row,
		label: sanitizeChildText(row.label),
		task: sanitizeChildText(row.task),
		now: row.now !== undefined ? sanitizeChildText(row.now) : row.now,
		statusLine: row.statusLine !== undefined ? sanitizeChildText(row.statusLine) : row.statusLine,
		output: row.output !== undefined ? sanitizeChildText(row.output) : row.output,
		error: row.error !== undefined ? sanitizeChildText(row.error) : row.error,
		blockedSample: row.blockedSample !== undefined ? sanitizeChildText(row.blockedSample) : row.blockedSample,
		// The child reports `provider`/`id` in its own `message_start` event, and `modelText` falls
		// back to the raw requested pattern before confirmation: both reach `formatModelLabel`
		// unsanitized otherwise (§security, formatModelLabel probe).
		provider: row.provider !== undefined ? sanitizeChildText(row.provider) : row.provider,
		modelId: row.modelId !== undefined ? sanitizeChildText(row.modelId) : row.modelId,
		modelText: row.modelText !== undefined ? sanitizeChildText(row.modelText) : row.modelText,
	};
}

/** Applied once at the top of `layoutRun` (§0), so every downstream layout function works on
 * already-clean text instead of each sanitizing its own slice of it. */
function sanitizePhase(phase: PhaseSnapshot): PhaseSnapshot {
	return {
		...phase,
		title: sanitizeChildText(phase.title),
		detail: phase.detail !== undefined ? sanitizeChildText(phase.detail) : undefined,
	};
}

/** A workflow script controls its own `name`/`description`/`args` (`workflow/meta.ts`), so these
 * are script-supplied strings exactly like phase titles. */
function sanitizeWorkflow(workflow: RunSnapshot["workflow"]): RunSnapshot["workflow"] {
	if (!workflow) return workflow;
	return {
		...workflow,
		name: sanitizeChildText(workflow.name),
		description: sanitizeChildText(workflow.description),
		args: workflow.args !== undefined ? sanitizeChildText(workflow.args) : undefined,
	};
}

/** Every child- or script-supplied string a `RunSnapshot` carries, sanitized once so every renderer
 * that consumes the snapshot (this file's `layoutRun`, `ui/inspector.ts`) works on already-clean
 * text instead of each re-implementing the same stripping. */
export function sanitizeSnapshot(snapshot: RunSnapshot): RunSnapshot {
	return {
		...snapshot,
		title: sanitizeChildText(snapshot.title),
		log: snapshot.log.map(sanitizeChildText),
		resultPreview: snapshot.resultPreview !== undefined ? sanitizeChildText(snapshot.resultPreview) : undefined,
		agents: snapshot.agents.map(sanitizeRow),
		phases: snapshot.phases.map(sanitizePhase),
		workflow: sanitizeWorkflow(snapshot.workflow),
		error: snapshot.error !== undefined ? sanitizeChildText(snapshot.error) : undefined,
	};
}

/** The fixed §11.4 mockup wording: a blocked tool's real gate reason (child-events.ts keeps it in
 * full, `NO_UI_APPROVAL_SUFFIX` included) is never shown on the tool row, only in the inspector's
 * expanded detail, so a long or sensitive rule description can never widen or leak onto this line. */
const BLOCKED_TOOL_TEXT = "blocked: needs approval (subagents cannot ask)";

/** The run's true agent count, including any dropped before this snapshot was built (a degraded
 * archived/final `details` with `agentsOmitted` set). `snapshot.counts` already covers every agent
 * (it is copied from `details.totals.byStatus`), so only `agents.length` on its own undercounts. */
function agentTotal(snapshot: RunSnapshot): number {
	return snapshot.agents.length + (snapshot.agentsOmitted?.count ?? 0);
}

/** Appended to a final/archived summary so a degraded snapshot never silently claims to be the
 * whole run. Empty for a live or non-degraded snapshot. */
function agentsOmittedNote(snapshot: RunSnapshot): string {
	const omitted = snapshot.agentsOmitted?.count ?? 0;
	return omitted > 0 ? ` (${omitted} agent${omitted === 1 ? "" : "s"} omitted)` : "";
}

function finalSummaryLeft(snapshot: RunSnapshot, theme: Theme): string {
	const total = agentTotal(snapshot);
	const { done, failed, cancelled } = snapshot.counts;
	const note = agentsOmittedNote(snapshot);
	if (snapshot.status === "cancelled" && failed === 0) {
		return `${statusGlyph("cancelled", theme, { now: 0, animate: false })} ${cancelledByText(snapshot.agents)} after ${total} agent${total === 1 ? "" : "s"}${note}`;
	}
	if (done === total) {
		return `${statusGlyph("done", theme, { now: 0, animate: false })} ${done}/${total} succeeded${note}`;
	}
	const parts = [`${done} of ${total} succeeded`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (cancelled > 0) parts.push(`${cancelled} cancelled`);
	const glyph =
		failed > 0
			? statusGlyph("failed", theme, { now: 0, animate: false })
			: statusGlyph("cancelled", theme, { now: 0, animate: false });
	return `${glyph} ${parts.join(" · ")}${note}`;
}

function buildMultiSummaryLine(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string {
	const left =
		snapshot.status === "running" ? liveCountsLeft(snapshot, theme, options) : finalSummaryLeft(snapshot, theme);
	if (!isLive(options)) return joinLeftRight(left, theme.fg("muted", staticHintText()), width);
	return joinLeftRightParts(left, rightSummaryParts(snapshot), width);
}

/** §11.3's `nowLine`-driven flex cell: the status word for a static row, else the live activity,
 * final status line/error, or chain-specific "waits for step N" / "not run". */
function flexText(row: AgentSnapshotRow, options: RunLayoutOptions, waitsForStep: number | undefined): string {
	if (!isLive(options)) return STATUS_WORDS[row.status];
	switch (row.status) {
		case "done":
			return row.statusLine || (row.output ? firstLine(row.output) : "") || "done";
		case "failed":
			return row.error ? row.error : "failed";
		case "cancelled":
			return cancelReasonText(row.cancelReason);
		case "queued":
			return "queued";
		case "pending":
			return waitsForStep !== undefined ? `waits for step ${waitsForStep}` : "pending";
		case "skipped":
			return "not run";
		default:
			return row.now || "running";
	}
}

interface RowExtra {
	stepLabel?: string;
	waitsForStep?: number;
	labelWidth?: number;
}

/** label width = `clamp(longest label, 6, 16)`, taken across every row in the group being laid out
 * (§11.3), so the model/elapsed columns line up across rows instead of each row sizing itself. */
function computeLabelWidth(agents: readonly AgentSnapshotRow[]): number {
	const longest = agents.reduce((max, agent) => Math.max(max, visibleWidth(agent.label)), 0);
	return Math.min(16, Math.max(6, longest));
}

/** `formatModelLabel`, but a static row never shows `thinking`: it is set only once the child's
 * `message_end` confirms it (child-events.ts §6.3), which is not a status transition, so a static
 * row must not change shape when it lands (§11.2.2). */
function modelLabelFor(
	row: AgentSnapshotRow,
	options: RunLayoutOptions,
	formatOptions: { withProvider: boolean; withSource?: boolean },
): string {
	if (isLive(options)) return formatModelLabel(row, formatOptions);
	return formatModelLabel({ ...row, thinking: undefined }, formatOptions);
}

function agentCollapsedLine(
	row: AgentSnapshotRow,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	extra?: RowExtra,
): string {
	const animate = options.focus && options.partial && (row.status === "running" || row.status === "starting");
	const glyph = statusGlyph(row.status, theme, { now: options.now, animate });
	const labelWidth = extra?.labelWidth ?? computeLabelWidth([row]);
	const cells: ColumnCell[] = [
		extra?.stepLabel ? { text: `${glyph} ${extra.stepLabel}`, width: 4 } : { text: glyph, width: 2 },
		{ text: row.label, width: labelWidth },
	];
	if (width >= 60) cells.push({ text: modelLabelFor(row, options, { withProvider: false }), width: 22 });
	if (width >= 40) {
		const elapsedText = isLive(options) && row.elapsedMs !== undefined ? formatDuration(row.elapsedMs) : "";
		cells.push({ text: elapsedText, width: 5, align: "right" });
	}
	cells.push({ text: flexText(row, options, extra?.waitsForStep), width: "flex" });
	return columns(cells, width, 1);
}

function toolsSummary(tools: Record<string, number> | undefined): string {
	if (!tools) return "";
	return Object.entries(tools)
		.map(([name, count]) => `${name} ×${count}`)
		.join(" · ");
}

/** `tools read ×6 · grep ×3[ · ⚠ k blocked (<sample>)]` (§11.3). The blocked annotation is shown
 * whenever `row.blocked > 0`, even if the agent has no tool-call counts yet. */
function toolsLineText(row: AgentSnapshotRow): string {
	const parts: string[] = [];
	const toolsText = toolsSummary(row.tools);
	if (toolsText) parts.push(toolsText);
	if (row.blocked > 0) parts.push(`⚠ ${row.blocked} blocked${row.blockedSample ? ` (${row.blockedSample})` : ""}`);
	return parts.join(" · ");
}

/** Up to 10 lines with a `│ ` gutter; beyond that, the first 3, an omission marker, and the last 6
 * (§11.3's final-output rule). */
function outputBlockLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length <= 10) return lines.map((line) => `    │ ${line}`);
	const first = lines.slice(0, 3).map((line) => `    │ ${line}`);
	const last = lines.slice(-6).map((line) => `    │ ${line}`);
	return [...first, `    … ${lines.length - 9} lines omitted …`, ...last];
}

function tailItemLines(items: readonly TranscriptItem[], width: number): string[] {
	const lines: string[] = [];
	for (const item of items) {
		if (item.kind === "thinking" || item.kind === "text") {
			const label = item.kind === "thinking" ? "thinking" : "writing";
			const cursor = item.done ? "" : "▌";
			lines.push(`    ▸ ${label}  ${oneLine(sanitizeChildText(item.text))}${cursor}`);
		} else if (item.kind === "tool") {
			const name = sanitizeChildText(item.name);
			const summary = sanitizeChildText(item.summary);
			if (item.status === "blocked") {
				lines.push(`    ⚠ ${name} ${summary}   ${BLOCKED_TOOL_TEXT}`);
			} else {
				const glyphChar = item.status === "ok" ? "✓" : item.status === "error" ? "✗" : "◐";
				const duration =
					item.startedAt !== undefined && item.endedAt !== undefined
						? `${((item.endedAt - item.startedAt) / 1000).toFixed(1)}s`
						: "";
				lines.push(joinLeftRight(`    ${glyphChar} ${name} ${summary}`.trimEnd(), duration, width));
			}
		} else if (item.kind === "notice") {
			lines.push(`    ! ${sanitizeChildText(item.text)}`);
		}
	}
	return lines;
}

function agentExpandedBlock(
	row: AgentSnapshotRow,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	extra?: RowExtra,
): string[] {
	const lines: string[] = [];
	const animate = options.focus && options.partial && (row.status === "running" || row.status === "starting");
	const glyph = statusGlyph(row.status, theme, { now: options.now, animate });
	const headerParts = [row.label, modelLabelFor(row, options, { withProvider: true, withSource: true })];
	const live = isLive(options);
	if (live && row.elapsedMs !== undefined) headerParts.push(formatDuration(row.elapsedMs));
	if (live && row.turns > 0) headerParts.push(`${row.turns} turn${row.turns === 1 ? "" : "s"}`);
	if (live) {
		const costText = formatCost(row.cost);
		if (costText) headerParts.push(costText);
	}
	if (live && row.status === "queued") headerParts.push(STATUS_WORDS.queued);
	const prefix = extra?.stepLabel ? `${extra.stepLabel} ` : "";
	lines.push(`${glyph} ${prefix}${headerParts.filter(Boolean).join(" · ")}`);

	if (row.status === "pending") {
		lines.push(`    ${flexText(row, options, extra?.waitsForStep)}`);
		return lines;
	}

	lines.push(`    task  ${oneLine(row.task)}`);
	const toolsLine = toolsLineText(row);
	if (live && toolsLine) lines.push(`    tools ${toolsLine}`);
	if (isFinished(row.status)) {
		if (row.output) {
			// A finished agent inside a still-running row shows one line (§11.4's "Parallel, partial,
			// expanded" mockup); the full `│`-gutter output block is reserved for final rows, so a
			// long-output agent cannot crowd out every other agent's row within the live budget.
			if (options.partial) {
				const text = row.statusLine || firstLine(row.output);
				if (text) lines.push(`    out   ${oneLine(text)}`);
			} else {
				lines.push(...outputBlockLines(row.output));
			}
		}
		if (row.error) lines.push(`    error ${firstLine(row.error)}`);
	} else if (live && row.tail && row.tail.length > 0) {
		lines.push(...tailItemLines(row.tail.slice(-4), width));
	}
	return lines;
}

function overflowLine(remaining: number, done: number, queued: number): string {
	const parts = [`${done} done`];
	if (queued > 0) parts.push(`${queued} queued`);
	return `… +${remaining} more (${parts.join(", ")}) · ${keyText("app.polyphase.inspector")} inspect`;
}

/** Folds `agentsOmitted` (agents dropped before the row even reached this layout, e.g. a degraded
 * archived snapshot) into the agents omitted by the line budget, so the overflow count and its
 * done/queued breakdown always reflect every agent the run actually has. */
function overflowLineFor(
	omitted: readonly AgentSnapshotRow[],
	agentsOmitted: RunSnapshot["agentsOmitted"],
): string | undefined {
	const remaining = omitted.length + (agentsOmitted?.count ?? 0);
	if (remaining <= 0) return undefined;
	const done = omitted.filter((a) => a.status === "done").length + (agentsOmitted?.byStatus.done ?? 0);
	const queued = omitted.filter((a) => a.status === "queued").length + (agentsOmitted?.byStatus.queued ?? 0);
	return overflowLine(remaining, done, queued);
}

function hintLine(options: RunLayoutOptions): string {
	if (!isLive(options)) return keyHint("app.polyphase.inspector", "inspect agents");
	const inspectHint = keyHint("app.polyphase.inspector", "inspect agents");
	const expandHint = keyHint("app.tools.expand", options.expanded ? "collapse" : "expand");
	return options.partial ? `${inspectHint} · ${expandHint}` : `${expandHint} · ${inspectHint}`;
}

/** Adds agent blocks/lines to `lines` while `lines.length` stays within `maxLines`, reserving one
 * line for an overflow marker unless the last agent fits without it (§11.2.3, §20.4: expanded blocks
 * must not grow the row past the viewport-derived cap). A block that cannot fit in the remaining
 * budget is clipped (header first) rather than dropped outright, so the row never shows zero agents
 * when the very first one is too big; every later agent that does not fit is left fully omitted.
 * Returns the agents that did not fit (in full). */
function layoutAgentsBounded(
	agents: readonly AgentSnapshotRow[],
	maxLines: number,
	renderRow: (row: AgentSnapshotRow) => string[],
): { lines: string[]; omitted: readonly AgentSnapshotRow[] } {
	const budget = Math.max(1, maxLines);
	const lines: string[] = [];
	let shown = 0;
	for (const row of agents) {
		const block = renderRow(row);
		const isLastAgent = shown + 1 === agents.length;
		const cap = isLastAgent ? budget : budget - 1;
		const remaining = cap - lines.length;
		if (remaining <= 0) {
			// No room left, not even for the reserved overflow line: if nothing has shown yet, use
			// whatever budget remains for a clipped first block rather than show nothing at all.
			if (shown === 0 && budget - lines.length > 0) {
				lines.push(...block.slice(0, budget - lines.length));
				shown++;
			}
			break;
		}
		if (block.length <= remaining) {
			lines.push(...block);
			shown++;
			continue;
		}
		if (shown === 0) {
			lines.push(...block.slice(0, remaining));
			shown++;
		}
		break;
	}
	return { lines, omitted: agents.slice(shown) };
}

function layoutParallel(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string[] {
	const lines = [buildMultiSummaryLine(snapshot, theme, options, width)];
	const labelWidth = computeLabelWidth(snapshot.agents);
	const { lines: agentLines, omitted } = layoutAgentsBounded(snapshot.agents, options.maxLines, (row) =>
		options.expanded
			? agentExpandedBlock(row, theme, options, width, { labelWidth })
			: [agentCollapsedLine(row, theme, options, width, { labelWidth })],
	);
	lines.push(...agentLines);
	const overflow = overflowLineFor(omitted, snapshot.agentsOmitted);
	if (overflow) lines.push(overflow);
	return lines;
}

/** The chain's current step: the first agent still doing something (running/starting/queued), else
 * the first agent waiting to start (pending). A queued or momentarily-pending current step must
 * still count as "the" step, not fall through to `step N of N` (§11.3). */
function findRunningStep(snapshot: RunSnapshot): number | undefined {
	const active = snapshot.agents.find(
		(a) => a.status === "running" || a.status === "starting" || a.status === "queued",
	);
	if (active) return active.step ?? active.i + 1;
	const pending = snapshot.agents.find((a) => a.status === "pending");
	return pending ? (pending.step ?? pending.i + 1) : undefined;
}

function chainSummaryLine(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string {
	const total = agentTotal(snapshot);
	const note = agentsOmittedNote(snapshot);
	if (snapshot.status !== "running") {
		const broken = snapshot.agents.find((a) => a.status === "failed" || a.status === "cancelled");
		const left = broken
			? `${statusGlyph(broken.status, theme, { now: 0, animate: false })} ${broken.status === "cancelled" ? "cancelled" : "failed"} at step ${broken.step ?? broken.i + 1} of ${total} (${broken.label})${note}`
			: `${statusGlyph("done", theme, { now: 0, animate: false })} done · ${total} steps${note}`;
		return joinLeftRightParts(left, rightSummaryParts(snapshot), width);
	}
	const runningStep = findRunningStep(snapshot) ?? total;
	const animate = options.focus && options.partial;
	const pieces = [`${statusGlyph("running", theme, { now: options.now, animate })} step ${runningStep} of ${total}`];
	for (const status of COUNT_ORDER) {
		if (status === "running") continue;
		const n = snapshot.counts[status];
		if (n <= 0) continue;
		pieces.push(`${statusGlyph(status, theme, { now: options.now, animate: false })} ${n} ${STATUS_WORDS[status]}`);
	}
	const left = pieces.join(" · ");
	if (!isLive(options)) return joinLeftRight(left, theme.fg("muted", staticHintText()), width);
	return joinLeftRightParts(left, rightSummaryParts(snapshot), width);
}

function layoutChain(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string[] {
	const lines = [chainSummaryLine(snapshot, theme, options, width)];
	const waitsForStep = findRunningStep(snapshot);
	const labelWidth = computeLabelWidth(snapshot.agents);
	const { lines: agentLines, omitted } = layoutAgentsBounded(snapshot.agents, options.maxLines, (row) => {
		const extra: RowExtra = { stepLabel: String(row.step ?? row.i + 1), waitsForStep, labelWidth };
		return options.expanded
			? agentExpandedBlock(row, theme, options, width, extra)
			: [agentCollapsedLine(row, theme, options, width, extra)];
	});
	lines.push(...agentLines);
	const overflow = overflowLineFor(omitted, snapshot.agentsOmitted);
	if (overflow) lines.push(overflow);
	return lines;
}

function layoutSingle(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string[] {
	const row = snapshot.agents[0];
	if (!row) return [snapshot.title];

	const live = isLive(options);
	const animate = options.focus && options.partial && (row.status === "running" || row.status === "starting");
	const leftParts = [
		STATUS_WORDS[row.status],
		modelLabelFor(row, options, { withProvider: options.expanded, withSource: options.expanded }),
	];
	if (live && (options.expanded || isFinished(row.status)) && row.turns > 0) {
		leftParts.push(`${row.turns} turn${row.turns === 1 ? "" : "s"}`);
	}
	const left = `${statusGlyph(row.status, theme, { now: options.now, animate })} ${leftParts.filter(Boolean).join(" · ")}`;

	const rightParts: string[] = [];
	if (live) {
		if (row.elapsedMs !== undefined) rightParts.push(formatDuration(row.elapsedMs));
		if (row.tokens > 0) rightParts.push(`${formatTokens(row.tokens)} tok`);
		const costText = formatCost(row.cost);
		if (costText) rightParts.push(costText);
	}

	const lines = [joinLeftRightParts(left, rightParts, width)];

	if (options.expanded) {
		lines.push(`    task  ${oneLine(row.task)}`);
		const toolsLine = toolsLineText(row);
		if (live && toolsLine) lines.push(`    tools ${toolsLine}`);
		if (isFinished(row.status)) {
			if (row.output) lines.push(...outputBlockLines(row.output));
			if (row.error) lines.push(`    error ${firstLine(row.error)}`);
		} else if (live && row.tail && row.tail.length > 0) {
			// §11.2.3: single mode's row budget covers this header too, so the tail must shrink on a
			// short terminal instead of growing the row past `options.maxLines` unconditionally.
			const tailBudget = Math.max(0, Math.min(8, options.maxLines - lines.length - 1));
			if (tailBudget > 0) lines.push(...tailItemLines(row.tail.slice(-tailBudget), width));
		}
	} else if (isFinished(row.status)) {
		const text = row.statusLine ?? (row.output ? firstLine(row.output) : undefined);
		if (text) lines.push(`    ${text}`);
		if (row.error) lines.push(`    error ${firstLine(row.error)}`);
	} else {
		lines.push(`    task  ${oneLine(row.task)}`);
		if (live && row.now) lines.push(`    now   ${row.now}`);
	}
	return lines;
}

function phaseAgentStatus(status: PhaseSnapshot["status"]): AgentStatus {
	return status;
}

/** §11.4's alternative final-summary lines, chosen by `snapshot.status`/`snapshot.budget` rather
 * than by agent counts alone, so a script-error `failed` run and a user `cancelled` run never show
 * the `done` glyph. */
function workflowFinalSummaryLeft(snapshot: RunSnapshot, theme: Theme): string {
	const total = agentTotal(snapshot);
	const { done, failed, cancelled } = snapshot.counts;
	const note = agentsOmittedNote(snapshot);
	if (snapshot.budget?.exhausted) {
		return `${theme.fg("warning", "⚠")} budget of ${formatTokens(snapshot.budget.totalTokens)} tokens reached · ${cancelled} agent${cancelled === 1 ? "" : "s"} cancelled${note}`;
	}
	if (snapshot.status === "cancelled") {
		return `${statusGlyph("cancelled", theme, { now: 0, animate: false })} ${cancelledByText(snapshot.agents)} after ${total} agent${total === 1 ? "" : "s"}${note}`;
	}
	if (snapshot.status === "failed") {
		const detail = snapshot.error ? oneLine(snapshot.error) : `${done} of ${total} succeeded · ${failed} failed`;
		return `${statusGlyph("failed", theme, { now: 0, animate: false })} ${detail}${note}`;
	}
	return `${statusGlyph("done", theme, { now: 0, animate: false })} done · ${total} agents · ${done} ok${cancelled > 0 ? ` · ${cancelled} cancelled` : ""}${note}`;
}

function workflowSummaryLine(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string {
	if (snapshot.status !== "running") {
		return joinLeftRightParts(workflowFinalSummaryLeft(snapshot, theme), rightSummaryParts(snapshot), width);
	}
	const currentPhase = snapshot.currentPhase !== undefined ? snapshot.phases[snapshot.currentPhase] : undefined;
	const animate = options.focus && options.partial;
	// §11.4's mockup is the phase's position among every phase (`(2/3)`), not its own agent tally
	// (which the phase line below already shows as `done/total`).
	const phaseText = currentPhase
		? `${currentPhase.title} (${currentPhase.index + 1}/${snapshot.phases.length})`
		: snapshot.title;
	const pieces = [`${statusGlyph("running", theme, { now: options.now, animate })} ${phaseText}`];
	const running = snapshot.counts.running + snapshot.counts.starting;
	if (running > 0) pieces.push(`${statusGlyph("running", theme, { now: options.now, animate: false })} ${running}`);
	for (const status of COUNT_ORDER) {
		if (status === "running") continue;
		const n = snapshot.counts[status];
		if (n <= 0) continue;
		pieces.push(`${statusGlyph(status, theme, { now: options.now, animate: false })} ${n}`);
	}
	const left = pieces.join(" · ");
	if (!isLive(options)) return joinLeftRight(left, theme.fg("muted", staticHintText()), width);
	return joinLeftRightParts(left, rightSummaryParts(snapshot), width);
}

/** Final phase tally: `done/total ok[ · c cancelled (<labels>[, by you])]` (§11.4). Running phases
 * keep the plain `done/total` form from the live counts. */
function phaseTotalsText(
	snapshot: RunSnapshot,
	phase: PhaseSnapshot,
	phaseAgents: readonly AgentSnapshotRow[],
): string {
	if (snapshot.status === "running") return `${phase.done}/${phase.total}`;
	// `phase.done`/`phase.total` are computed only from the agents a degraded archived snapshot
	// kept (snapshot.ts), so a partial tally must not read as the phase's complete result.
	if (phase.incomplete) return `${phase.done}/${phase.total}+`;
	const cancelled = phaseAgents.filter((agent) => agent.status === "cancelled");
	if (cancelled.length === 0) return `${phase.done}/${phase.total} ok`;
	const labels = cancelled.map((agent) => agent.label).join(", ");
	const byYou = cancelled.every((agent) => agent.cancelReason === "user");
	return `${phase.done}/${phase.total} ok · ${cancelled.length} cancelled (${labels}${byYou ? ", by you" : ""})`;
}

const COLLAPSED_ACTIVE_PHASE_AGENT_CAP = 6;

function phaseAgentsOf(snapshot: RunSnapshot, phase: PhaseSnapshot): AgentSnapshotRow[] {
	return snapshot.agents.filter((agent) => agent.phase === phase.index);
}

function isActivePhase(snapshot: RunSnapshot, phase: PhaseSnapshot): boolean {
	return phase.status === "running" && snapshot.currentPhase === phase.index;
}

function phaseHeaderLine(
	snapshot: RunSnapshot,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	phase: PhaseSnapshot,
	phaseAgents: readonly AgentSnapshotRow[],
): string {
	const glyph = statusGlyph(phaseAgentStatus(phase.status), theme, {
		now: options.now,
		animate: options.focus && options.partial && phase.status === "running",
	});
	const left = `${glyph} ${phase.index + 1} ${phase.title}  ${phaseTotalsText(snapshot, phase, phaseAgents)}`;
	const elapsed = isLive(options) && phase.elapsedMs !== undefined ? formatDuration(phase.elapsedMs) : "";
	return joinLeftRight(left, elapsed, width);
}

/** One phase's full block within `budget` lines total (header included): its header line, plus its
 * agents (up to 6 collapsed, §11.3) when `showAgents` is true, with an overflow marker for whatever
 * does not fit. Agents left out get folded exactly like `layoutAgentsBounded` elsewhere, so a single
 * phase can never consume more than its share of the tree's budget. */
function phaseBlock(
	snapshot: RunSnapshot,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	phase: PhaseSnapshot,
	phaseAgents: readonly AgentSnapshotRow[],
	showAgents: boolean,
	budget: number,
): string[] {
	if (budget <= 0) return [];
	const header = phaseHeaderLine(snapshot, theme, options, width, phase, phaseAgents);
	if (!showAgents || phaseAgents.length === 0) return [header];
	const capped = options.expanded ? phaseAgents : phaseAgents.slice(0, COLLAPSED_ACTIVE_PHASE_AGENT_CAP);
	const cappedOverflow = options.expanded ? [] : phaseAgents.slice(COLLAPSED_ACTIVE_PHASE_AGENT_CAP);
	const labelWidth = computeLabelWidth(capped);
	const reserve = cappedOverflow.length > 0 ? 1 : 0;
	const agentBudget = budget - 1 - reserve;
	if (agentBudget <= 0) {
		// No room for an agent line within budget: a forced minimum line here would push the block
		// past budget (the overrun this guards against). Prefer the overflow marker over a clipped
		// agent line whenever there is room for it; otherwise the header alone.
		if (budget - 1 > 0) {
			const overflow = overflowLineFor(phaseAgents, undefined);
			if (overflow) return [header, `    ${overflow}`];
		}
		return [header];
	}
	const { lines: agentLines, omitted } = layoutAgentsBounded(capped, agentBudget, (row) =>
		(options.expanded
			? agentExpandedBlock(row, theme, options, Math.max(1, width - 4), { labelWidth })
			: [agentCollapsedLine(row, theme, options, Math.max(1, width - 4), { labelWidth })]
		).map((line) => `    ${line}`),
	);
	const lines = [header, ...agentLines];
	const overflow = overflowLineFor([...omitted, ...cappedOverflow], undefined);
	if (overflow && lines.length < budget) lines.push(`    ${overflow}`);
	return lines;
}

/** The plain top-to-bottom layout: every phase in order, each a `phaseBlock`, until `budget` runs
 * out. `shownIndexes` lets the caller tell whether this covered the run's active phase;
 * `lineCountByIndex` lets the caller tell whether that phase's block was clipped by the room left
 * over from earlier phases rather than laid out at its full share. */
function layoutPhasesSequential(
	snapshot: RunSnapshot,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	budget: number,
): { lines: string[]; shownIndexes: Set<number>; lineCountByIndex: Map<number, number> } {
	const lines: string[] = [];
	const shownIndexes = new Set<number>();
	const lineCountByIndex = new Map<number, number>();
	for (const phase of snapshot.phases) {
		if (lines.length >= budget) break;
		const phaseAgents = phaseAgentsOf(snapshot, phase);
		const showAgents = options.expanded || isActivePhase(snapshot, phase);
		const block = phaseBlock(snapshot, theme, options, width, phase, phaseAgents, showAgents, budget - lines.length);
		lines.push(...block);
		shownIndexes.add(phase.index);
		lineCountByIndex.set(phase.index, block.length);
	}
	return { lines, shownIndexes, lineCountByIndex };
}

/** Fallback for when the plain sequential layout would run out of budget before reaching the
 * active phase (e.g. many phases, a late current phase): the active phase and its running agents
 * are laid out first, so they are never silently dropped, and every other phase is folded into a
 * single `+N phases` header-only marker once there is no more room (§11.3). */
function layoutPhasesActiveFirst(
	snapshot: RunSnapshot,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	budget: number,
	activeIndex: number,
): string[] {
	const phases = snapshot.phases;
	const activePhase = phases[activeIndex];
	const activeBlock = phaseBlock(
		snapshot,
		theme,
		options,
		width,
		activePhase,
		phaseAgentsOf(snapshot, activePhase),
		true,
		budget,
	);
	const lines = [...activeBlock];
	const otherIndexes = phases.map((_, index) => index).filter((index) => index !== activeIndex);
	const remaining = Math.max(0, budget - lines.length);
	const showCount = otherIndexes.length <= remaining ? otherIndexes.length : Math.max(0, remaining - 1);
	for (let k = 0; k < showCount; k++) {
		const phase = phases[otherIndexes[k]];
		lines.push(phaseHeaderLine(snapshot, theme, options, width, phase, phaseAgentsOf(snapshot, phase)));
	}
	const omitted = otherIndexes.length - showCount;
	if (omitted > 0) lines.push(`… +${omitted} phase${omitted === 1 ? "" : "s"}`);
	return lines;
}

/** Collapsed: only the active phase, up to 6 agents (§11.3). Expanded: every phase's every agent,
 * bounded by `budget` (§11.4's "every phase with every agent row"). Either way, agents left out by
 * the 6-agent cap or by the line budget get an overflow marker (§11.3's "when agents exceed the line
 * cap" rule), indented under their phase, so live agents never silently disappear from the tree.
 * When the plain top-to-bottom layout would run out of room before the active phase, it switches to
 * `layoutPhasesActiveFirst` instead of letting that phase vanish. */
function workflowPhaseLines(
	snapshot: RunSnapshot,
	theme: Theme,
	options: RunLayoutOptions,
	width: number,
	budget: number,
): string[] {
	if (budget <= 0 || snapshot.phases.length === 0) return [];
	const sequential = layoutPhasesSequential(snapshot, theme, options, width, budget);
	const activeIndex = snapshot.phases.findIndex((phase) => isActivePhase(snapshot, phase));
	if (activeIndex === -1) return sequential.lines;
	const activePhase = snapshot.phases[activeIndex];
	if (!sequential.shownIndexes.has(activePhase.index)) {
		return layoutPhasesActiveFirst(snapshot, theme, options, width, budget, activeIndex);
	}
	// The sequential pass reached the active phase, but may have handed it only whatever budget
	// earlier phases left over, clipping its header/agents/overflow marker below what it would get
	// at its full share. Compare against that full-share block (computed with the whole budget, as
	// `layoutPhasesActiveFirst` would give it) to tell "reached" apart from "fit".
	const fullActiveBlock = phaseBlock(
		snapshot,
		theme,
		options,
		width,
		activePhase,
		phaseAgentsOf(snapshot, activePhase),
		true,
		budget,
	);
	const renderedActiveLines = sequential.lineCountByIndex.get(activePhase.index) ?? 0;
	if (renderedActiveLines < fullActiveBlock.length) {
		return layoutPhasesActiveFirst(snapshot, theme, options, width, budget, activeIndex);
	}
	return sequential.lines;
}

/** Agents started before the script's first `phase()` call (`run.resolvePhase(undefined)` leaves
 * `agent.phase` unset), or whose recorded phase index fell out of `snapshot.phases` (a degraded
 * archived snapshot), belong to no phase row and would otherwise never be shown. */
function unphasedAgents(snapshot: RunSnapshot): AgentSnapshotRow[] {
	const validIndexes = new Set(snapshot.phases.map((phase) => phase.index));
	return snapshot.agents.filter((agent) => agent.phase === undefined || !validIndexes.has(agent.phase));
}

function layoutWorkflow(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions, width: number): string[] {
	const budget = Math.max(1, options.maxLines);
	const lines: string[] = [];
	const unphased = unphasedAgents(snapshot);
	if (unphased.length > 0) {
		const capped = options.expanded ? unphased : unphased.slice(0, COLLAPSED_ACTIVE_PHASE_AGENT_CAP);
		const cappedOverflow = options.expanded ? [] : unphased.slice(COLLAPSED_ACTIVE_PHASE_AGENT_CAP);
		const labelWidth = computeLabelWidth(capped);
		const reserve = cappedOverflow.length > 0 ? 1 : 0;
		const { lines: unphasedLines, omitted } = layoutAgentsBounded(capped, Math.max(1, budget - reserve), (row) =>
			options.expanded
				? agentExpandedBlock(row, theme, options, width, { labelWidth })
				: [agentCollapsedLine(row, theme, options, width, { labelWidth })],
		);
		lines.push(...unphasedLines);
		const overflow = overflowLineFor([...omitted, ...cappedOverflow], undefined);
		if (overflow && lines.length < budget) lines.push(overflow);
	}
	lines.push(...workflowPhaseLines(snapshot, theme, options, width, Math.max(0, budget - lines.length)));
	if (options.partial && isLive(options) && lines.length < budget) {
		if (options.expanded) {
			const logLines = snapshot.log.slice(-5);
			if (logLines.length > 0) {
				lines.push(theme.fg("muted", "log"));
				for (const line of logLines) {
					if (lines.length >= budget) break;
					lines.push(`${theme.fg("muted", "»")} ${oneLine(line)}`);
				}
			}
		} else {
			const lastLog = snapshot.log[snapshot.log.length - 1];
			if (lastLog) lines.push(`${theme.fg("muted", "»")} ${oneLine(lastLog)}`);
		}
	} else if (!options.partial && snapshot.resultPreview && lines.length < budget) {
		lines.push(`${theme.fg("accent", "→")} ${oneLine(snapshot.resultPreview)}`);
	}
	return [workflowSummaryLine(snapshot, theme, options, width), ...lines];
}

/** Everything after `renderCall`'s title line (§11.4): the summary, the agent rows or workflow
 * phase tree, and the hint line, each fitted to `width`. */
export function layoutRun(snapshot: RunSnapshot, width: number, theme: Theme, options: RunLayoutOptions): string[] {
	const sanitized = sanitizeSnapshot(snapshot);
	const body =
		sanitized.kind === "workflow"
			? layoutWorkflow(sanitized, theme, options, width)
			: sanitized.mode === "single"
				? layoutSingle(sanitized, theme, options, width)
				: sanitized.mode === "chain"
					? layoutChain(sanitized, theme, options, width)
					: layoutParallel(sanitized, theme, options, width);
	const lines = options.hints ? [...body, hintLine(options)] : body;
	return lines.map((line) => fitLine(line, width));
}

function layoutOptionsKey(options: RunLayoutOptions): string {
	return `${options.expanded}|${options.partial}|${options.focus}|${options.maxLines}|${options.hints}`;
}

/** Reused across re-renders of the same tool call (`context.lastComponent`). Caches its lines by
 * `(snapshot.version, width, options, spinner frame when focus && partial)` (§11.2.6). */
export class PolyphaseRunBlock implements Component {
	private snapshot: RunSnapshot | undefined;
	private theme: Theme | undefined;
	private options: RunLayoutOptions | undefined;
	private cacheKey: string | undefined;
	private cachedLines: string[] = [];

	update(snapshot: RunSnapshot, theme: Theme, options: RunLayoutOptions): void {
		this.snapshot = snapshot;
		this.theme = theme;
		this.options = options;
	}

	render(width: number): string[] {
		if (!this.snapshot || !this.theme || !this.options) return [];
		const snapshot = this.snapshot;
		const theme = this.theme;
		const options = this.options;
		const spinner = options.focus && options.partial ? spinnerFrame(options.now) : "";
		const key = `${snapshot.version}|${width}|${layoutOptionsKey(options)}|${spinner}`;
		if (key !== this.cacheKey) {
			this.cacheKey = key;
			this.cachedLines = layoutRun(snapshot, width, theme, options);
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cacheKey = undefined;
	}
}
