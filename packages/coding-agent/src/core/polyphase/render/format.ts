/**
 * Glyphs, colours, and width-safe text formatting shared by the tool-row renderer (render/run-block.ts,
 * P9) and the inspector (ui/inspector.ts, P10). Every exported formatter is pure: no timers, no I/O.
 */

import type { ThinkingLevel } from "@draht/agent-core";
import { truncateToWidth, visibleWidth } from "@draht/tui";
import type { Theme, ThemeColor } from "../../../modes/interactive/theme/theme.ts";
import type { AgentStatus, ModelSource } from "../types.ts";

export const SPINNER_FRAMES: readonly string[] = ["◐", "◓", "◑", "◒"];

export function spinnerFrame(now: number): string {
	const index = Math.floor(now / 250) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0] ?? "";
}

export function statusColor(status: AgentStatus): ThemeColor {
	switch (status) {
		case "pending":
			return "dim";
		case "queued":
			return "dim";
		case "starting":
		case "running":
			return "accent";
		case "done":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "skipped":
			return "muted";
	}
}

function statusGlyphChar(status: AgentStatus, options: { now: number; animate: boolean }): string {
	switch (status) {
		case "pending":
			return "·";
		case "queued":
			return "◌";
		case "starting":
		case "running":
			return options.animate ? spinnerFrame(options.now) : "●";
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
		case "skipped":
			return "–";
	}
}

export function statusGlyph(status: AgentStatus, theme: Theme, options: { now: number; animate: boolean }): string {
	return theme.fg(statusColor(status), statusGlyphChar(status, options));
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** `0:07`, `4:51`, `1:02:03`. */
export function formatDuration(ms: number): string {
	const safeMs = Number.isFinite(ms) ? ms : 0;
	const totalSeconds = Math.max(0, Math.floor(safeMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
	return `${minutes}:${pad2(seconds)}`;
}

/** `950`, `12.3k`, `1.2M`. Rounds first, then picks the unit, so values never round up into the next
 * unit's territory (e.g. 999_600 is `1.0M`, not `1000k`). */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const sign = n < 0 ? "-" : "";
	const abs = Math.abs(n);
	if (abs < 1000) return `${sign}${Math.round(abs)}`;
	if (abs < 1_000_000) {
		const oneDecimalK = Math.round(abs / 100) / 10;
		if (oneDecimalK < 100) return `${sign}${oneDecimalK.toFixed(1)}k`;
		const wholeK = Math.round(abs / 1000);
		if (wholeK < 1000) return `${sign}${wholeK}k`;
	}
	const oneDecimalM = Math.round(abs / 100_000) / 10;
	if (oneDecimalM < 10) return `${sign}${oneDecimalM.toFixed(1)}M`;
	return `${sign}${Math.round(abs / 1_000_000)}M`;
}

/** `""` for 0, `<$0.01`, `$0.08`, `$12.40`. */
export function formatCost(usd: number): string {
	const safeUsd = Number.isFinite(usd) ? usd : 0;
	if (safeUsd === 0) return "";
	if (safeUsd < 0.01) return "<$0.01";
	return `$${safeUsd.toFixed(2)}`;
}

/**
 * Collapsed: `id thinking`. Expanded (`withProvider`): `provider/id thinking (source)`, source shown
 * only for `inherited` and `child-default`. Before confirmation (no provider/modelId), falls back to
 * `modelText`, the requested pattern or `"default model"` for an unconfirmed child-default model.
 */
export function formatModelLabel(
	row: {
		provider?: string;
		modelId?: string;
		modelText?: string;
		thinking?: ThinkingLevel;
		modelSource?: ModelSource;
	},
	options: { withProvider: boolean; withSource?: boolean },
): string {
	const idPart =
		row.provider && row.modelId
			? options.withProvider
				? `${row.provider}/${row.modelId}`
				: row.modelId
			: (row.modelText ?? row.modelId ?? row.provider ?? "");
	const parts = [idPart];
	if (row.thinking) parts.push(row.thinking);
	const label = parts.filter((part) => part.length > 0).join(" ");
	const withSource = options.withSource ?? false;
	const sourceSuffix =
		withSource && (row.modelSource === "inherited" || row.modelSource === "child-default")
			? `(${row.modelSource})`
			: "";
	return [label, sourceSuffix].filter((part) => part.length > 0).join(" ");
}

/** Collapses whitespace runs (including newlines) to single spaces and trims. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `truncateToWidth(text, width, "…")`: never exceeds `width`, never pads. */
export function fitLine(text: string, width: number): string {
	return truncateToWidth(text, width, "…");
}

/** Truncates (no ellipsis) and pads with spaces to exactly `width` visible columns. */
export function padToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "", true);
}

function alignToWidth(text: string, width: number, align: "left" | "right"): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(text, width, "", false);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return align === "right" ? padding + truncated : truncated + padding;
}

export interface ColumnCell {
	text: string;
	width: number | "flex";
	align?: "left" | "right";
}

/** Lays out `cells` within `width` columns separated by `gap` spaces (default 1). Fixed-width cells are
 * truncated/padded to their width; `"flex"` cells share the remaining space evenly. The result's visible
 * width never exceeds `width`, even with CJK or emoji content. */
export function columns(cells: readonly ColumnCell[], width: number, gap = 1): string {
	if (cells.length === 0 || width <= 0) return "";
	const gapStr = " ".repeat(Math.max(0, gap));
	const gapTotal = gapStr.length * Math.max(0, cells.length - 1);
	const fixedTotal = cells.reduce(
		(sum, cell) => sum + (typeof cell.width === "number" ? Math.max(0, cell.width) : 0),
		0,
	);
	const flexCells = cells.filter((cell) => cell.width === "flex");
	const remaining = Math.max(0, width - gapTotal - fixedTotal);
	const flexWidths: number[] = [];
	if (flexCells.length > 0) {
		const base = Math.floor(remaining / flexCells.length);
		let used = 0;
		for (let i = 0; i < flexCells.length; i++) {
			const isLast = i === flexCells.length - 1;
			const flexWidth = isLast ? remaining - used : base;
			flexWidths.push(Math.max(0, flexWidth));
			used += flexWidth;
		}
	}
	let flexIndex = 0;
	const parts = cells.map((cell) => {
		const cellWidth = cell.width === "flex" ? (flexWidths[flexIndex++] ?? 0) : Math.max(0, cell.width);
		return alignToWidth(cell.text, cellWidth, cell.align ?? "left");
	});
	const joined = parts.join(gapStr);
	return truncateToWidth(joined, width, "", false);
}
