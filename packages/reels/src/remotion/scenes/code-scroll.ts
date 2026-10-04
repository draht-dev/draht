/**
 * Deterministic scroll math for CodeScene. A diff line can wrap into several
 * visual rows (the code box renders with `white-space: pre-wrap` so long
 * lines wrap instead of overflowing); scrolling by logical line count alone
 * can park a focused line half off screen once anything has wrapped. Row
 * counts come from the code box's own content width and Geist Mono's advance
 * width, not hand-measured pixel constants.
 */

export const CODE_FONT_SIZE = 34;
export const CODE_LINE_HEIGHT = 1.5;
export const CODE_LINE_HEIGHT_PX = CODE_FONT_SIZE * CODE_LINE_HEIGHT;
export const CODE_PADDING_PX = 32;
/** Width of the leading `+`/`-`/` ` marker column, in `ch` units (matches the `1.5ch` reserved for it in CodeScene.tsx). */
export const MARKER_COLUMN_CH = 1.5;
/** Geist Mono's glyph advance width, as a fraction of its font size (monospace, so every glyph is the same width). */
export const CODE_FONT_ADVANCE_EM = 0.6;

const CHAR_WIDTH_PX = CODE_FONT_SIZE * CODE_FONT_ADVANCE_EM;

/** How many monospace characters fit on one row of the code content column (box width minus padding and the marker column). */
export function charsPerRow(codeBoxWidthPx: number): number {
	const contentWidthPx = codeBoxWidthPx - CODE_PADDING_PX * 2 - MARKER_COLUMN_CH * CHAR_WIDTH_PX;
	return Math.max(1, Math.floor(contentWidthPx / CHAR_WIDTH_PX));
}

/** Visual rows one diff line wraps into. The line's own leading marker character isn't part of the wrapped code span, so it is excluded from the length. */
export function rowsForLine(line: string, charsPerRowCount: number): number {
	const codeLength = Math.max(0, line.length - 1);
	return Math.max(1, Math.ceil(codeLength / charsPerRowCount));
}

export interface RowLayout {
	/** Row index (0-based) each logical line (by array index) starts at. */
	startRow: number[];
	/** Total visual rows across every line. */
	totalRows: number;
}

/** Row index each logical line starts at, and the running total — the basis for both the content height and the scroll target below. */
export function layoutRows(lines: string[], charsPerRowCount: number): RowLayout {
	const startRow: number[] = [];
	let rows = 0;
	for (const line of lines) {
		startRow.push(rows);
		rows += rowsForLine(line, charsPerRowCount);
	}
	return { startRow, totalRows: rows };
}

/**
 * Normalises a beat's 1-based focus line range: order-independent (`[5,2]`
 * reads the same as `[2,5]`), clamped to `1..totalLines`, and `undefined`
 * (treated as "no focus") once clamping leaves nothing left to show.
 */
export function normalizeFocusLines(
	focusLines: [number, number] | undefined,
	totalLines: number,
): [number, number] | undefined {
	if (!focusLines || totalLines <= 0) return undefined;
	const min = Math.max(1, Math.min(focusLines[0], focusLines[1]));
	const max = Math.min(totalLines, Math.max(focusLines[0], focusLines[1]));
	return min <= max ? [min, max] : undefined;
}

/**
 * Pixel offset to scroll the code block by so the (already normalised)
 * 1-based inclusive line range `focusLines` is centered in a
 * `visibleHeightPx`-tall viewport, clamped so the block never scrolls past
 * its start or end. `undefined` (no focus — including a beat whose range
 * normalised away) keeps the top of the block in view, offset 0; that is
 * also the correct "previous" offset to ease *from* for a beat that had no
 * focus, so callers never need a separate fallback for that case.
 */
export function scrollTargetPx(
	focusLines: [number, number] | undefined,
	layout: RowLayout,
	visibleHeightPx: number,
): number {
	const contentHeightPx = layout.totalRows * CODE_LINE_HEIGHT_PX + CODE_PADDING_PX * 2;
	const maxOffset = Math.max(0, contentHeightPx - visibleHeightPx);
	if (!focusLines || maxOffset === 0) return 0;

	const startIndex = focusLines[0] - 1;
	const endIndex = Math.min(layout.startRow.length - 1, focusLines[1] - 1);
	if (startIndex > endIndex || startIndex < 0) return 0;

	const startRow = layout.startRow[startIndex];
	const endRow = endIndex + 1 < layout.startRow.length ? layout.startRow[endIndex + 1] - 1 : layout.totalRows - 1;
	const centerRow = (startRow + endRow + 1) / 2; // +1: endRow is inclusive
	const target = centerRow * CODE_LINE_HEIGHT_PX - visibleHeightPx / 2;
	return Math.min(Math.max(target, 0), maxOffset);
}
