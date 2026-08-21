/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@draht/tui";
import { boundedSafeText } from "../../../core/socket-server/safe-text.js";
import { theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

/**
 * Hard ceiling on how many rows of title + detail this component will ever draw.
 *
 * The option list is the only part of this dialog a human can act on, so it must never be pushed
 * off screen by the ask itself. A 5000-character command used to render 76 rows with the genuine
 * `Yes` row at index 70 — invisible on any normal terminal, which is a fabricated-consent hazard,
 * not a cosmetic one. Everything past this budget collapses into a single `… +N more` row.
 */
export const MAX_DETAIL_ROWS = 12;

/** Left/right margin of a detail row, matching the `paddingX: 1` the title and options use. */
const DETAIL_ROW_PADDING_X = 1;

/** Left/right margin of a title row. Same as {@link DETAIL_ROW_PADDING_X}; named separately for clarity. */
const TITLE_PADDING_X = 1;

/** Floor on a header row's usable width, so a very narrow terminal cannot produce a useless budget. */
const MIN_HEADER_ROW_WIDTH = 16;

/**
 * Neutralize and bound free-form dialog prose to a ROW BUDGET — one row per wrapped line.
 *
 * The predecessor of this function bounded the WHOLE message to a SINGLE row's width while
 * {@link capHeaderRows} was allowing up to {@link MAX_DETAIL_ROWS} of them, so about ten rows of
 * legitimate capacity were thrown away. Measured on the `/rewind --fork` consent dialog
 * (src/core/builtins/checkpoints.ts:112, 273 characters): 215 characters elided at 80 columns and
 * 175 at 120, taking the checkpoint timestamp, the file count and the warning that the forked
 * session cannot `/rewind` back with them. An operator cannot consent to a destructive action they
 * are not shown.
 *
 * The rule that fixes that without giving the row cap back:
 *
 *  1. SPLIT on "\n" first. A newline the caller wrote is a ROW BREAK — `formatMissingSessionCwdPrompt`
 *     is deliberately five lines, and neutralizing those newlines into U+240A collapsed all five
 *     into one middle-elided row that no longer said WHICH session cwd was missing.
 *  2. NEUTRALIZE and bound each line on its own, so an escape or a bidi override INSIDE a line still
 *     dies, and no line can overflow its row. A line longer than the whole budget could ever show is
 *     middle-elided by `boundedSafeText`, which keeps the decisive tail.
 *  3. CAP the number of rows, with an explicit `… +N more lines` notice whenever any are dropped.
 *     This — not flattening newlines — is what keeps the option list on screen, and it is the same
 *     quantity {@link capHeaderRows} already counts.
 *
 * Every line that is shown gets AT LEAST one row, and a line too long for the rows it was given is
 * middle-elided by `boundedSafeText` — which announces itself and keeps the decisive tail — rather
 * than having its tail quietly cut off by the row cap. Only whole lines are ever dropped, and only
 * with the notice.
 *
 * Callers must budget for their own remaining header rows: the result is joined with "\n" and every
 * one of those newlines costs a row.
 */
export function boundDialogText(text: string, columns: number, maxRows: number): string {
	const width = Math.max(MIN_HEADER_ROW_WIDTH, columns - TITLE_PADDING_X * 2);
	const budget = Math.max(1, Math.floor(maxRows));
	const lines = text.split("\n");

	// Reserve the last row for the notice up front when the line count alone cannot fit, so the
	// reservation never costs a line its row halfway through the loop.
	const contentBudget = lines.length > budget ? budget - 1 : budget;
	const shown = Math.min(lines.length, contentBudget);
	const rows: string[] = [];

	for (let i = 0; i < shown; i++) {
		// Rows left, minus the one still owed to each line after this one.
		const allowed = Math.max(1, contentBudget - rows.length - (shown - 1 - i));
		rows.push(...wrapLineToRows(lines[i], width, allowed));
	}

	const dropped = lines.length - shown;
	return dropped === 0 ? rows.join("\n") : [...rows, `… +${dropped} more lines`].join("\n");
}

/**
 * Neutralize one line and lay it out as AT MOST `allowed` rows of `width` columns.
 *
 * `width * allowed` graphemes is the theoretical capacity but not the achievable one — word wrapping
 * leaves the tail of a row unused whenever the next word does not fit — so the grapheme budget is
 * retried downwards until the wrap actually fits. Shrinking the budget is what keeps the decisive
 * TAIL: `boundedSafeText` elides the MIDDLE, whereas discarding surplus rows would cut the end off.
 */
function wrapLineToRows(line: string, width: number, allowed: number): string[] {
	// Neutralize FIRST, measure second: `visibleWidth` reports zero for bidi controls and DEL, so
	// width math over un-neutralized text is meaningless and a clip would still carry the escape.
	let graphemeBudget = width * allowed;
	for (let round = 0; round < 8; round++) {
		const rows = wrapTextWithAnsi(boundedSafeText(line, graphemeBudget).value, width);
		if (rows.length <= allowed) return rows;
		const shrunk = Math.max(width, graphemeBudget - (rows.length - allowed) * width);
		if (shrunk === graphemeBudget) break;
		graphemeBudget = shrunk;
	}
	// A single row that still will not fit (wide characters cost two columns each): clip it.
	return wrapTextWithAnsi(boundedSafeText(line, graphemeBudget).value, width).slice(0, allowed);
}

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	/**
	 * Pre-rendered detail rows drawn between the title and the option list.
	 *
	 * Each entry is ONE row: it is neutralized and clipped to the render width here, so a newline,
	 * an `ESC[2J` or a bidi override inside it can neither fabricate extra rows that impersonate
	 * options nor escape the row it was given. Callers must not embed newlines to get more rows.
	 */
	detailRows?: readonly string[];
	onToggleToolsExpanded?: () => void;
}

/**
 * Renders a fixed number of single-line rows, each neutralized and clipped to the render width.
 *
 * This is deliberately NOT a `Text`: `Text` word-wraps, so one long attacker-influenced string
 * becomes an unbounded number of rows. Here every row costs exactly one line, always.
 */
class DetailRowsComponent implements Component {
	private readonly rows: readonly string[];

	constructor(rows: readonly string[]) {
		this.rows = rows;
	}

	invalidate(): void {
		// Rendering is a pure function of the rows and the width; nothing is cached.
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - DETAIL_ROW_PADDING_X * 2);
		const margin = " ".repeat(DETAIL_ROW_PADDING_X);
		return this.rows.map((row) => {
			// Neutralize FIRST, measure second. `visibleWidth` strips ANSI for measurement only and
			// reports zero for bidi controls and DEL, so width math over un-neutralized text is
			// meaningless — and the clipped result would still carry the escape.
			const safe = boundedSafeText(row, contentWidth).value;
			const clipped = truncateToWidth(safe, contentWidth, "…");
			const line = margin + theme.fg("muted", clipped) + margin;
			return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		});
	}
}

/**
 * Renders the dialog title as EXACTLY ONE row per logical line, neutralized and clipped to width.
 *
 * This is deliberately NOT a `Text`, for the same reason {@link DetailRowsComponent} is not: `Text`
 * word-wraps, so {@link capHeaderRows} — which counts the title's LOGICAL lines — was bounding a
 * number that had nothing to do with the rows actually drawn. A 2000-character single-line title
 * counted as 1 against the budget and rendered 20+ rows, pushing `Yes` to index 29 at width 100 and
 * off the bottom of a short terminal. Here the count and the rows are the same number, always.
 *
 * Neutralization is per line and happens here so that EVERY caller of this component — including
 * `ui.select`, which does not go through `showExtensionConfirm` — gets an ESC-free, bidi-free title.
 * The split on "\n" is a deliberate row-per-line contract for the legacy `${title}\n${message}`
 * shape: a caller decides how many rows it is asking for by how many newlines it hands over, and
 * must therefore keep that number inside the header budget itself. `showExtensionConfirm` does —
 * it neutralizes the TITLE's newlines outright (a title is one row) and runs the MESSAGE through
 * {@link boundDialogText}, which caps the rows the message's own newlines can buy.
 */
class TitleRowsComponent implements Component {
	private lines: string[];

	constructor(text: string) {
		this.lines = TitleRowsComponent.split(text);
	}

	private static split(text: string): string[] {
		// Mirror `Text`: an empty or blank title occupies no rows at all.
		return !text || text.trim() === "" ? [] : text.split("\n");
	}

	setText(text: string): void {
		this.lines = TitleRowsComponent.split(text);
	}

	invalidate(): void {
		// Rendering is a pure function of the lines and the width; nothing is cached.
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - TITLE_PADDING_X * 2);
		const margin = " ".repeat(TITLE_PADDING_X);
		return this.lines.map((raw) => {
			// Neutralize FIRST, measure second — `visibleWidth` reports zero for bidi controls, so
			// width math over un-neutralized text is meaningless and the clip would keep the escape.
			const safe = boundedSafeText(raw, contentWidth).value;
			const clipped = truncateToWidth(safe, contentWidth, "…");
			const line = margin + theme.fg("accent", theme.bold(clipped)) + margin;
			return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		});
	}
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: TitleRowsComponent;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;

		// The title may itself be multi-line (legacy callers concatenate `${title}\n${message}`), so
		// both it and the detail rows are counted against ONE budget. Otherwise a caller could push
		// the options off screen through the title instead of through the rows.
		const { titleLines, detailRows, overflow } = capHeaderRows(title, opts?.detailRows ?? []);
		this.baseTitle = titleLines.join("\n");

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new TitleRowsComponent(this.baseTitle);
		this.addChild(this.titleText);
		if (detailRows.length > 0 || overflow > 0) {
			this.addChild(new DetailRowsComponent(overflow > 0 ? [...detailRows, `… +${overflow} more`] : detailRows));
			// No spacer here: the row budget is only a guarantee if every line between the border and
			// the option list is counted, and the muted detail block already separates itself visually.
		} else {
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				// Raw text: `TitleRowsComponent` applies the accent/bold styling after neutralizing.
				(s) => this.titleText.setText(`${this.baseTitle} (${s}s)`),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}

/**
 * Split `title` into rows and append `rows`, clipping the pair to {@link MAX_DETAIL_ROWS}.
 *
 * The last slot is reserved for the `… +N more` notice whenever anything is dropped, so the human
 * always sees that the dialog is showing less than it was handed.
 *
 * This counts LOGICAL lines, which is only a real bound because both {@link TitleRowsComponent} and
 * {@link DetailRowsComponent} draw exactly one row per logical line at any width. Rendering either
 * of them with a wrapping `Text` silently turns this budget back into a fiction.
 */
function capHeaderRows(
	title: string,
	rows: readonly string[],
): { titleLines: string[]; detailRows: readonly string[]; overflow: number } {
	const titleLines = title.split("\n");
	const total = titleLines.length + rows.length;
	if (total <= MAX_DETAIL_ROWS) {
		return { titleLines, detailRows: rows, overflow: 0 };
	}

	const budget = MAX_DETAIL_ROWS - 1; // one slot reserved for the `… +N more` notice
	const shownTitleLines = titleLines.slice(0, budget);
	const shownRows = rows.slice(0, Math.max(0, budget - shownTitleLines.length));
	return {
		titleLines: shownTitleLines,
		detailRows: shownRows,
		overflow: total - (shownTitleLines.length + shownRows.length),
	};
}
