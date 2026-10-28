import { visibleWidth } from "@draht/tui";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../../src/core/polyphase/types.ts";
import {
	sanitizeForDisplay,
	TranscriptLineCache,
	tailWindowOf,
} from "../../src/core/polyphase/ui/transcript-layout.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

initTheme("dark");

function thinkingItem(overrides: Partial<Extract<TranscriptItem, { kind: "thinking" }>> = {}): TranscriptItem {
	return {
		kind: "thinking",
		seq: 1,
		rev: 1,
		text: "thinking about it",
		droppedChars: 0,
		done: false,
		redacted: false,
		...overrides,
	};
}

function toPlainLines(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(line));
}

const BASE_OPTIONS = { width: 60, showThinking: true, showToolPreviews: false, now: 1_000 };
const OWNER = "run-1:0";

function toolItem(overrides: Partial<Extract<TranscriptItem, { kind: "tool" }>> = {}): TranscriptItem {
	return {
		kind: "tool",
		seq: 1,
		rev: 1,
		toolCallId: "call-1",
		name: "bash",
		summary: "npm test",
		status: "ok",
		...overrides,
	};
}

describe("TranscriptLineCache", () => {
	it("returns stale lines for an unchanged rev (cache hit)", () => {
		const cache = new TranscriptLineCache(theme);
		const item = thinkingItem({ text: "first text", done: true });
		const first = cache.linesFor(OWNER, [item], 0, BASE_OPTIONS);

		// Mutate the text in place without bumping `rev`: a real cache hit must keep serving the
		// previously rendered lines, since `rev` is the only signal that the item changed.
		(item as { text: string }).text = "mutated text that should not appear";
		const second = cache.linesFor(OWNER, [item], 0, BASE_OPTIONS);

		expect(second).toEqual(first);
		expect(toPlainLines(second).join("\n")).not.toContain("mutated text");
	});

	it("re-wraps when rev changes", () => {
		const cache = new TranscriptLineCache(theme);
		const item = thinkingItem({ text: "version one", done: true });
		const first = cache.linesFor(OWNER, [item], 0, BASE_OPTIONS);

		const bumped: TranscriptItem = { ...item, rev: 2, text: "version two" } as TranscriptItem;
		const second = cache.linesFor(OWNER, [bumped], 0, BASE_OPTIONS);

		expect(second).not.toEqual(first);
		expect(toPlainLines(second).join("\n")).toContain("version two");
		expect(toPlainLines(first).join("\n")).toContain("version one");
	});

	it("re-wraps when width changes", () => {
		const cache = new TranscriptLineCache(theme);
		const text = Array.from({ length: 10 }, (_, i) => `word${i}`).join(" ");
		const item = thinkingItem({ text, done: true });
		const narrow = cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, width: 20 });
		const wide = cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, width: 120 });

		expect(narrow).not.toEqual(wide);
		expect(narrow.length).toBeGreaterThan(wide.length);
	});

	it("bounds the open streaming item's wrap input to its last 16 KiB", () => {
		const cache = new TranscriptLineCache(theme);
		const filler = "x".repeat(20_000);
		const item = thinkingItem({ text: `HEADMARKER${filler}TAILMARKER`, done: false });

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 0, BASE_OPTIONS)).join("\n");

		expect(lines).not.toContain("HEADMARKER");
		expect(lines).toContain("TAILMARKER");
	});

	it("still sanitizes control characters within the retained 16 KiB tail of an open item", () => {
		// Regression: sanitizing used to run over the full open-item text before slicing to the tail,
		// costing up to `maxItemChars` on every delta instead of the intended 16 KiB bound. Slicing
		// first only pays off if sanitizing the slice still works.
		const cache = new TranscriptLineCache(theme);
		const filler = "x".repeat(20_000);
		const item = thinkingItem({ text: `${filler}\tTAB_AFTER\x1b[2JESC_AFTER`, done: false });

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 0, BASE_OPTIONS)).join("\n");

		expect(lines).not.toContain("\t");
		expect(lines).not.toContain("\x1b");
		expect(lines).toContain("TAB_AFTER");
		expect(lines).toContain("ESC_AFTER");
	});

	it("wraps the full text once the item is done, with no 16 KiB bound", () => {
		const cache = new TranscriptLineCache(theme);
		const filler = "x".repeat(20_000);
		const item = thinkingItem({ text: `HEADMARKER${filler}TAILMARKER`, done: true });

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 0, BASE_OPTIONS)).join("\n");

		expect(lines).toContain("HEADMARKER");
		expect(lines).toContain("TAILMARKER");
	});

	it("hides thinking text when showThinking is false, in a single line", () => {
		const cache = new TranscriptLineCache(theme);
		const item = thinkingItem({ text: "secret reasoning", done: true });

		const lines = cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, showThinking: false });

		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).not.toContain("secret reasoning");
	});

	it("prefixes a dropped-items notice", () => {
		const cache = new TranscriptLineCache(theme);
		const item = thinkingItem({ text: "visible", done: true });

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 3, BASE_OPTIONS));

		expect(lines[0]).toContain("3 earlier items not kept");
	});

	it("renders a tool item with a right-aligned status and duration", () => {
		const cache = new TranscriptLineCache(theme);
		const item: TranscriptItem = {
			kind: "tool",
			seq: 1,
			rev: 1,
			toolCallId: "call-1",
			name: "bash",
			summary: "npm test",
			status: "ok",
			startedAt: 0,
			endedAt: 120,
		};

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 0, BASE_OPTIONS));

		expect(lines[0]).toContain("bash");
		expect(lines[0]).toContain("npm test");
		expect(lines[0]).toContain("0.1s");
	});

	it("shows a blocked explanation line for a blocked tool call", () => {
		const cache = new TranscriptLineCache(theme);
		const item: TranscriptItem = {
			kind: "tool",
			seq: 1,
			rev: 1,
			toolCallId: "call-1",
			name: "bash",
			summary: "npm test -- auth",
			status: "blocked",
			blockedReason: "subagents cannot ask for approval",
		};

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 0, BASE_OPTIONS));

		expect(lines.join("\n")).toContain("blocked: needs approval");
		expect(lines.join("\n")).toContain("subagents cannot ask for approval");
	});

	it("shows result preview lines only when showToolPreviews is on, capped at 6", () => {
		const cache = new TranscriptLineCache(theme);
		const preview = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const item: TranscriptItem = {
			kind: "tool",
			seq: 1,
			rev: 1,
			toolCallId: "call-1",
			name: "read",
			summary: "src/foo.ts",
			status: "ok",
			resultPreview: preview,
		};

		const hidden = cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, showToolPreviews: false });
		expect(hidden).toHaveLength(1);

		const shown = cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, showToolPreviews: true });
		expect(shown.length).toBeLessThanOrEqual(1 + 6);
		expect(shown.length).toBeGreaterThan(1);
	});

	it("colours a notice line by level", () => {
		const warning: TranscriptItem = { kind: "notice", seq: 1, rev: 1, level: "warning", text: "budget low", at: 0 };
		const error: TranscriptItem = { kind: "notice", seq: 1, rev: 1, level: "error", text: "budget low", at: 0 };

		const warningLines = new TranscriptLineCache(theme).linesFor(OWNER, [warning], 0, BASE_OPTIONS).join("\n");
		const errorLines = new TranscriptLineCache(theme).linesFor(OWNER, [error], 0, BASE_OPTIONS).join("\n");

		expect(stripAnsi(warningLines)).toContain("! budget low");
		expect(stripAnsi(errorLines)).toContain("! budget low");
		// Stripping ANSI first (as every other assertion here does) would hide the one thing this test
		// is meant to check: the raw, colour-coded output must actually differ between levels.
		expect(warningLines).not.toEqual(errorLines);
		expect(warningLines).toContain(theme.fg("warning", "! budget low"));
		expect(errorLines).toContain(theme.fg("error", "! budget low"));
	});

	it("every rendered line fits within width", () => {
		const cache = new TranscriptLineCache(theme);
		const items: TranscriptItem[] = [
			thinkingItem({ seq: 1, rev: 1, text: "x".repeat(500), done: true }),
			{
				kind: "tool",
				seq: 2,
				rev: 1,
				toolCallId: "call-1",
				name: "bash",
				summary: "a very long command line that keeps going and going and going",
				status: "ok",
				startedAt: 0,
				endedAt: 1234,
			},
		];
		for (const width of [20, 40, 78]) {
			const lines = cache.linesFor(OWNER, items, 0, { ...BASE_OPTIONS, width });
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("does not serve another agent's cached lines for the same seq/rev shape", () => {
		const cache = new TranscriptLineCache(theme);
		const a = toolItem({ seq: 1, rev: 1, name: "bash", summary: "AAA_ONLY" });
		const b = toolItem({ seq: 1, rev: 1, name: "bash", summary: "BBB_ONLY" });

		const linesA = toPlainLines(cache.linesFor("run-1:a", [a], 0, BASE_OPTIONS)).join("\n");
		expect(linesA).toContain("AAA_ONLY");

		const linesB = toPlainLines(cache.linesFor("run-1:b", [b], 0, BASE_OPTIONS)).join("\n");
		expect(linesB).toContain("BBB_ONLY");
		expect(linesB).not.toContain("AAA_ONLY");

		// Switching back to the first owner must not have been clobbered by the second owner's entries.
		const linesAAgain = toPlainLines(cache.linesFor("run-1:a", [a], 0, BASE_OPTIONS)).join("\n");
		expect(linesAAgain).toContain("AAA_ONLY");
	});

	it("keeps a running tool item's elapsed time live instead of freezing it at first render", () => {
		const cache = new TranscriptLineCache(theme);
		const item = toolItem({ status: "running", startedAt: 0, resultPreview: undefined });

		const early = toPlainLines(cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, now: 1_000 })).join("\n");
		const late = toPlainLines(cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, now: 65_000 })).join("\n");

		expect(early).not.toEqual(late);
		expect(early).toContain("0:01");
		expect(late).toContain("1:05");
	});

	it("sanitizes escape sequences and tabs from child-sourced text before wrapping", () => {
		const cache = new TranscriptLineCache(theme);
		const dangerous = "a\tb\tc\rOVER\x1b[2J\x1b]0;title\x07end";
		const item = toolItem({ resultPreview: dangerous });

		const lines = toPlainLines(cache.linesFor(OWNER, [item], 0, { ...BASE_OPTIONS, showToolPreviews: true })).join(
			"\n",
		);

		expect(lines).not.toContain("\x1b");
		expect(lines).not.toContain("\t");
		expect(lines).not.toContain("\r");
	});

	it("reports each item's line range from the most recent linesFor() call", () => {
		const cache = new TranscriptLineCache(theme);
		const items: TranscriptItem[] = [
			toolItem({ seq: 1, rev: 1, summary: "first" }),
			thinkingItem({ seq: 2, rev: 1, text: Array.from({ length: 10 }, (_, i) => `word${i}`).join(" "), done: true }),
		];

		const lines = cache.linesFor(OWNER, items, 0, { ...BASE_OPTIONS, width: 20 });
		const ranges = cache.lineRanges();

		expect(ranges).toHaveLength(2);
		expect(ranges[0]).toEqual({ seq: 1, start: 0, end: 1 });
		expect(ranges[1]?.seq).toBe(2);
		expect(ranges[1]?.start).toBe(1);
		expect(ranges[1]?.end).toBe(lines.length);
	});

	it("offsets every item's range by one when a dropped-items notice is shown", () => {
		const cache = new TranscriptLineCache(theme);
		const item = toolItem({ seq: 5, rev: 1 });

		cache.linesFor(OWNER, [item], 3, BASE_OPTIONS);

		expect(cache.lineRanges()).toEqual([{ seq: 5, start: 1, end: 2 }]);
	});
});

describe("tailWindowOf", () => {
	const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);

	it("reports the total line count", () => {
		expect(tailWindowOf(lines).totalLines).toBe(10);
	});

	it("shows the last `height` lines when offset is 0", () => {
		expect(tailWindowOf(lines).window(3, 0)).toEqual(["l7", "l8", "l9"]);
	});

	it("shifts the window back by offsetFromEnd", () => {
		expect(tailWindowOf(lines).window(3, 4)).toEqual(["l3", "l4", "l5"]);
	});

	it("clamps height and offset at the edges", () => {
		expect(tailWindowOf(lines).window(100, 0)).toEqual(lines);
		expect(tailWindowOf(lines).window(3, 100)).toEqual([]);
		expect(tailWindowOf(lines).window(0, 0)).toEqual([]);
	});

	it("handles an empty transcript", () => {
		const empty = tailWindowOf([]);
		expect(empty.totalLines).toBe(0);
		expect(empty.window(5, 0)).toEqual([]);
	});
});

describe("sanitizeForDisplay", () => {
	it("normalises a bare CR to a newline instead of leaving it to move the cursor back to column 0", () => {
		// A progress-style `\r` left as-is would make the parent terminal overwrite whatever was drawn
		// before it; multi-line contexts already split on CR like a newline (`wrapTextWithAnsi`), so
		// normalising it here is safe there and fixes the single-line call sites that do not wrap.
		expect(sanitizeForDisplay("abc\rOVERWRITE")).toBe("abc\nOVERWRITE");
		expect(sanitizeForDisplay("abc\r\nnext")).toBe("abc\nnext");
	});

	it("still strips ANSI, tabs and disallowed control characters alongside the CR normalisation", () => {
		const dangerous = "a\tb\x1b[2J\rOVER";
		expect(sanitizeForDisplay(dangerous)).toBe("a   b\nOVER");
	});
});
