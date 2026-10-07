/**
 * Wrapped-line cache and tail-window math for one agent's live transcript, shared by the agent
 * detail view (`ui/inspector.ts`). See DESIGN.md §12.5.
 */

import { visibleWidth, wrapTextWithAnsi } from "@draht/tui";
import { keyText } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../../utils/shell.ts";
import { replaceTabs } from "../../tools/render-utils.ts";
import { columns, fitLine, formatDuration, oneLine } from "../render/format.ts";
import type { TranscriptItem } from "../types.ts";

/** Only the last 16 KiB of an open (not-yet-done) item's text is re-wrapped on every delta, so
 * rendering cost stays bounded while the item streams in. */
const STREAM_TAIL_CHARS = 16 * 1024;
const TOOL_PREVIEW_MAX_LINES = 6;

export interface TranscriptRenderOptions {
	width: number;
	showThinking: boolean;
	showToolPreviews: boolean;
	now: number;
}

export interface TranscriptTailWindow {
	readonly totalLines: number;
	/** `[totalLines - height - offsetFromEnd, totalLines - offsetFromEnd)`, clamped. */
	window(height: number, offsetFromEnd: number): string[];
}

export function tailWindowOf(lines: readonly string[]): TranscriptTailWindow {
	return {
		get totalLines(): number {
			return lines.length;
		},
		window(height: number, offsetFromEnd: number): string[] {
			const total = lines.length;
			const h = Math.max(0, Math.floor(height));
			const offset = Math.min(total, Math.max(0, Math.floor(offsetFromEnd)));
			const end = total - offset;
			const start = Math.max(0, end - h);
			return lines.slice(start, end);
		},
	};
}

function isOpenItem(item: TranscriptItem): boolean {
	return (item.kind === "thinking" || item.kind === "text") && !item.done;
}

/** Child-sourced text (thinking/text content, tool summaries, result previews, blocked reasons,
 * notice text) may contain cursor/erase CSI sequences, OSC title sequences, tabs and bare CRs.
 * Stripped (or, for CR, normalised to a newline) before wrapping, so the parent terminal never
 * executes them and a progress-style `\r` can never move the cursor back to column 0 and overwrite
 * already-drawn output. `wrapTextWithAnsi` already splits on `\r` like a newline, so normalising it
 * here does not change multi-line rendering. Exported for `ui/inspector.ts`, which draws other
 * child-sourced fields (status lines, output previews, errors) outside the transcript; those
 * single-line call sites must also run the result through `oneLine()` so the newline this
 * introduces does not split one logical row into two terminal lines. */
export function sanitizeForDisplay(text: string): string {
	return replaceTabs(sanitizeBinaryOutput(stripAnsi(text))).replace(/\r\n?/g, "\n");
}

/** A 16 KiB tail cut can land inside a UTF-16 surrogate pair, leaving an orphan low surrogate at
 * the start; `String.prototype.slice` does not know about pairs. Dropped before sanitizing so it
 * never reaches the terminal as a replacement-character glyph. */
function trimLeadingLoneSurrogate(text: string): string {
	const code = text.charCodeAt(0);
	return code >= 0xdc00 && code <= 0xdfff ? text.slice(1) : text;
}

function appendCursor(lines: string[]): string[] {
	if (lines.length === 0) return ["▌"];
	const last = lines[lines.length - 1] ?? "";
	return [...lines.slice(0, -1), `${last}▌`];
}

function renderTextLikeItem(
	theme: Theme,
	kind: "thinking" | "text",
	text: string,
	done: boolean,
	redacted: boolean,
	options: TranscriptRenderOptions,
	open: boolean,
): string[] {
	const header = theme.fg("muted", `▸ ${kind}`);
	if (kind === "thinking" && !options.showThinking) {
		const hidden = redacted
			? "▸ thinking (redacted, hidden)"
			: `▸ thinking (hidden — ${keyText("app.thinking.toggle")} to show)`;
		return [fitLine(theme.fg("muted", hidden), options.width)];
	}
	const indent = "  ";
	const bodyWidth = Math.max(1, options.width - indent.length - (done ? 0 : 1));
	// Sliced before sanitizing, not after: sanitizing the open item's full text on every delta would
	// cost up to `maxItemChars` instead of the intended 16 KiB bound. A partial escape sequence left
	// at the cut point becomes harmless literal text once `stripAnsi` sees it.
	const source = sanitizeForDisplay(open ? trimLeadingLoneSurrogate(text.slice(-STREAM_TAIL_CHARS)) : text);
	const wrapped = wrapTextWithAnsi(source, bodyWidth);
	const withCursor = done ? wrapped : appendCursor(wrapped);
	return [fitLine(header, options.width), ...withCursor.map((line) => fitLine(`${indent}${line}`, options.width))];
}

function formatToolElapsed(ms: number): string {
	if (ms < 1000) return `${Math.max(0, ms / 1000).toFixed(1)}s`;
	return formatDuration(ms);
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

function toolStatusRight(item: ToolItem, theme: Theme, now: number): string {
	switch (item.status) {
		case "ok": {
			const elapsed = item.startedAt === undefined ? undefined : (item.endedAt ?? now) - item.startedAt;
			return `${theme.fg("success", "✓")}${elapsed === undefined ? "" : ` ${formatToolElapsed(elapsed)}`}`;
		}
		case "error": {
			const elapsed = item.startedAt === undefined ? undefined : (item.endedAt ?? now) - item.startedAt;
			return `${theme.fg("error", "✗")}${elapsed === undefined ? "" : ` ${formatToolElapsed(elapsed)}`}`;
		}
		case "blocked":
			return `${theme.fg("warning", "⚠")} blocked: needs approval`;
		case "running": {
			// A static glyph, not an animated spinner: only the focused row animates (§20.4), and this
			// item may be rendered outside the cache on every flush, so an animated frame here would
			// just be redundant churn.
			const elapsed = item.startedAt === undefined ? undefined : now - item.startedAt;
			return `${theme.fg("accent", "◐")}${elapsed === undefined ? "" : ` ${formatToolElapsed(elapsed)}`}`;
		}
		case "pending":
			return theme.fg("dim", "·");
	}
}

function renderToolItem(theme: Theme, item: ToolItem, options: TranscriptRenderOptions): string[] {
	const summary = sanitizeForDisplay(item.summary);
	const left = oneLine(`● ${item.name} ${summary}`.trim());
	const right = toolStatusRight(item, theme, options.now);
	const line = columns(
		[
			{ text: left, width: "flex" },
			{ text: right, width: visibleWidth(right) },
		],
		options.width,
		1,
	);
	const lines = [fitLine(line, options.width)];
	if (item.status === "blocked" && item.blockedReason) {
		const indent = "  ";
		const reason = sanitizeForDisplay(item.blockedReason);
		lines.push(
			...wrapTextWithAnsi(reason, Math.max(1, options.width - indent.length)).map((l) =>
				fitLine(`${indent}${l}`, options.width),
			),
		);
	}
	if (options.showToolPreviews && item.resultPreview) {
		const indent = "  │ ";
		const preview = sanitizeForDisplay(item.resultPreview);
		const previewWidth = Math.max(1, options.width - indent.length);
		lines.push(
			...wrapTextWithAnsi(preview, previewWidth)
				.slice(0, TOOL_PREVIEW_MAX_LINES)
				.map((l) => fitLine(`${indent}${l}`, options.width)),
		);
	}
	return lines;
}

function renderNoticeItem(theme: Theme, item: Extract<TranscriptItem, { kind: "notice" }>, width: number): string[] {
	const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
	const text = sanitizeForDisplay(item.text);
	return wrapTextWithAnsi(theme.fg(color, `! ${text}`), width).map((line) => fitLine(line, width));
}

/** A running tool item's status column (elapsed time) must keep advancing on every render, but
 * `rev` only changes on mutation, so it is never cached. */
function isLiveTimed(item: TranscriptItem): boolean {
	return item.kind === "tool" && item.status === "running";
}

interface CacheEntry {
	key: string;
	lines: readonly string[];
}

/** The line span `[start, end)` one transcript item occupies in the last `linesFor()` result, so a
 * caller can re-locate an item (e.g. a pinned pause anchor) after the surrounding lines shift. */
export interface TranscriptLineRange {
	seq: number;
	start: number;
	end: number;
}

/**
 * Caches one transcript item's wrapped lines by `(seq, rev, width, showThinking, showToolPreviews,
 * open)`, so an unchanged item is not re-wrapped on every render. The last item is re-wrapped from
 * its last 16 KiB only while it is still open (streaming), so a growing thinking/text block does not
 * make every render O(item length). Entries are scoped to one `owner` (one agent's transcript):
 * `seq` is a per-agent counter that restarts at 0 for every agent, so entries from a previously
 * shown agent are discarded whenever the owner changes, instead of being served to the next one.
 */
export class TranscriptLineCache {
	private readonly theme: Theme;
	private owner: string | undefined;
	private entries = new Map<number, CacheEntry>();
	private ranges: readonly TranscriptLineRange[] = [];

	constructor(theme: Theme) {
		this.theme = theme;
	}

	linesFor(
		owner: string,
		items: readonly TranscriptItem[],
		droppedItems: number,
		options: TranscriptRenderOptions,
	): string[] {
		if (owner !== this.owner) {
			this.entries.clear();
			this.owner = owner;
		}
		const lines: string[] = [];
		const ranges: TranscriptLineRange[] = [];
		if (droppedItems > 0) {
			lines.push(fitLine(this.theme.fg("muted", `… ${droppedItems} earlier items not kept`), options.width));
		}
		const lastIndex = items.length - 1;
		const liveSeqs = new Set<number>();
		for (let i = 0; i <= lastIndex; i++) {
			const item = items[i];
			if (!item) continue;
			liveSeqs.add(item.seq);
			const open = i === lastIndex && isOpenItem(item);
			const start = lines.length;
			if (isLiveTimed(item)) {
				lines.push(...this.renderItem(item, options, open));
			} else {
				const key = `${item.rev}|${options.width}|${options.showThinking}|${options.showToolPreviews}|${open}`;
				const cached = this.entries.get(item.seq);
				const itemLines = cached && cached.key === key ? cached.lines : this.renderItem(item, options, open);
				if (!cached || cached.key !== key) this.entries.set(item.seq, { key, lines: itemLines });
				lines.push(...itemLines);
			}
			ranges.push({ seq: item.seq, start, end: lines.length });
		}
		for (const seq of this.entries.keys()) {
			if (!liveSeqs.has(seq)) this.entries.delete(seq);
		}
		this.ranges = ranges;
		return lines;
	}

	/** The item line ranges computed by the most recent `linesFor()` call. */
	lineRanges(): readonly TranscriptLineRange[] {
		return this.ranges;
	}

	private renderItem(item: TranscriptItem, options: TranscriptRenderOptions, open: boolean): readonly string[] {
		switch (item.kind) {
			case "thinking":
				return renderTextLikeItem(this.theme, "thinking", item.text, item.done, item.redacted, options, open);
			case "text":
				return renderTextLikeItem(this.theme, "text", item.text, item.done, false, options, open);
			case "tool":
				return renderToolItem(this.theme, item, options);
			case "notice":
				return renderNoticeItem(this.theme, item, options.width);
		}
	}
}
