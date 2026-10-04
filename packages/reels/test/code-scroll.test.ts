import { describe, expect, test } from "bun:test";
import {
	CODE_LINE_HEIGHT_PX,
	charsPerRow,
	layoutRows,
	normalizeFocusLines,
	rowsForLine,
	scrollTargetPx,
} from "../src/remotion/scenes/code-scroll.ts";

describe("rowsForLine / layoutRows", () => {
	test("a short line is one row", () => {
		expect(rowsForLine("+short", 40)).toBe(1);
	});

	test("a line longer than charsPerRow wraps into multiple rows", () => {
		// 80 code characters at 40 chars/row -> 2 rows.
		const line = `+${"x".repeat(80)}`;
		expect(rowsForLine(line, 40)).toBe(2);
	});

	test("layoutRows accumulates wrapped rows into each line's start row", () => {
		const lines = ["+short", `+${"x".repeat(80)}`, "+short again"];
		const layout = layoutRows(lines, 40);
		expect(layout.startRow).toEqual([0, 1, 3]); // line 0: 1 row, line 1: 2 rows, line 2 starts at row 3
		expect(layout.totalRows).toBe(4);
	});
});

describe("normalizeFocusLines", () => {
	test("passes through an already-sorted, in-range range", () => {
		expect(normalizeFocusLines([2, 5], 10)).toEqual([2, 5]);
	});

	// Regression: an author-reversed range must read the same as the sorted one.
	test("normalises a reversed [max, min] range to [min, max]", () => {
		expect(normalizeFocusLines([5, 2], 10)).toEqual([2, 5]);
	});

	test("clamps to 1..totalLines", () => {
		expect(normalizeFocusLines([-3, 50], 10)).toEqual([1, 10]);
	});

	test("ignores (returns undefined for) a range that clamps away to nothing", () => {
		expect(normalizeFocusLines([20, 30], 10)).toBeUndefined();
	});

	test("undefined input stays undefined", () => {
		expect(normalizeFocusLines(undefined, 10)).toBeUndefined();
	});
});

describe("scrollTargetPx", () => {
	// Many short lines so the content is taller than the viewport and scrolling kicks in.
	const lines = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
	const layout = layoutRows(lines, 40);
	const visibleHeightPx = 400;

	test("no focus keeps the top of the block in view (offset 0)", () => {
		expect(scrollTargetPx(undefined, layout, visibleHeightPx)).toBe(0);
	});

	test("content shorter than the viewport never scrolls", () => {
		const shortLayout = layoutRows(["+a", "+b", "+c"], 40);
		expect(scrollTargetPx([1, 2], shortLayout, visibleHeightPx)).toBe(0);
	});

	test("centers a focused range near the middle of the block", () => {
		const offset = scrollTargetPx([19, 21], layout, visibleHeightPx);
		expect(offset).toBeGreaterThan(0);
		const maxOffset = layout.totalRows * CODE_LINE_HEIGHT_PX + 32 * 2 - visibleHeightPx;
		expect(offset).toBeLessThan(maxOffset);
	});

	test("clamps so focusing the first lines never scrolls past the top", () => {
		expect(scrollTargetPx([1, 2], layout, visibleHeightPx)).toBe(0);
	});

	test("clamps so focusing the last lines never scrolls past the bottom", () => {
		const maxOffset = layout.totalRows * CODE_LINE_HEIGHT_PX + 32 * 2 - visibleHeightPx;
		expect(scrollTargetPx([39, 40], layout, visibleHeightPx)).toBe(maxOffset);
	});

	// Regression: a focused range further down a tall hunk whose earlier lines
	// wrapped must still be centered on its *visual* row position, not its logical line
	// number — otherwise the target undershoots and the focused text sits off-screen.
	test("accounts for earlier wrapped lines when centering a range further down the hunk", () => {
		const wrappingLines = [
			`+${"x".repeat(120)}`, // wraps into 3 rows at 40 chars/row
			`+${"x".repeat(120)}`, // wraps into 3 rows
			"+short",
			"+short",
			"+short",
		];
		const wrappingLayout = layoutRows(wrappingLines, 40);
		// Logical line 5 ("short") actually starts at visual row 6+ (3+3) + offsets, well past
		// where a naive "line 5 = row 5" calculation would place it.
		expect(wrappingLayout.startRow[4]).toBeGreaterThan(4);
		const offsetByRow = scrollTargetPx([5, 5], wrappingLayout, visibleHeightPx);
		const flatLayout = layoutRows(["+a", "+b", "+c", "+d", "+e"], 40);
		const offsetByLineNumberOnly = scrollTargetPx([5, 5], flatLayout, visibleHeightPx);
		expect(offsetByRow).not.toBe(offsetByLineNumberOnly);
	});
});

describe("charsPerRow", () => {
	test("is derived from the box width, not hardcoded", () => {
		expect(charsPerRow(884)).toBeGreaterThan(0);
		expect(charsPerRow(1768)).toBeGreaterThan(charsPerRow(884));
	});
});
