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

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
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

		this.titleText = new Text(theme.fg("accent", theme.bold(this.baseTitle)), 1, 0);
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
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
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
