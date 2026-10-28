import { visibleWidth } from "@draht/tui";
import { describe, expect, it } from "vitest";
import {
	columns,
	fitLine,
	formatCost,
	formatDuration,
	formatModelLabel,
	formatTokens,
	oneLine,
	padToWidth,
	SPINNER_FRAMES,
	spinnerFrame,
	statusColor,
	statusGlyph,
} from "../../src/core/polyphase/render/format.ts";
import type { AgentStatus } from "../../src/core/polyphase/types.ts";
import type { ThemeColor } from "../../src/modes/interactive/theme/theme.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

initTheme("dark");

const STATUSES: readonly AgentStatus[] = [
	"pending",
	"queued",
	"starting",
	"running",
	"done",
	"failed",
	"cancelled",
	"skipped",
];

describe("formatDuration", () => {
	it.each([
		[0, "0:00"],
		[7_000, "0:07"],
		[291_000, "4:51"],
		[3_723_000, "1:02:03"],
	])("formats %dms as %s", (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});
});

describe("formatTokens", () => {
	it.each([
		[950, "950"],
		[12_345, "12.3k"],
		[1_234_567, "1.2M"],
	])("formats %d as %s", (n, expected) => {
		expect(formatTokens(n)).toBe(expected);
	});
});

describe("formatCost", () => {
	it.each([
		[0, ""],
		[0.004, "<$0.01"],
		[0.08, "$0.08"],
		[12.4, "$12.40"],
	])("formats %d as %s", (usd, expected) => {
		expect(formatCost(usd)).toBe(expected);
	});
});

describe("formatModelLabel", () => {
	it("collapsed form shows id and thinking without provider or source", () => {
		const label = formatModelLabel(
			{ provider: "anthropic", modelId: "claude-sonnet-5", thinking: "high", modelSource: "inherited" },
			{ withProvider: false },
		);
		expect(label).toBe("claude-sonnet-5 high");
	});

	it("expanded form shows provider/id and source for inherited models", () => {
		const label = formatModelLabel(
			{ provider: "anthropic", modelId: "claude-sonnet-5", thinking: "high", modelSource: "inherited" },
			{ withProvider: true, withSource: true },
		);
		expect(label).toBe("anthropic/claude-sonnet-5 high (inherited)");
	});

	it("does not show source for override or phase models", () => {
		const label = formatModelLabel(
			{ provider: "anthropic", modelId: "claude-sonnet-5", modelSource: "override" },
			{ withProvider: true, withSource: true },
		);
		expect(label).toBe("anthropic/claude-sonnet-5");
	});

	it("falls back to the requested pattern before confirmation", () => {
		const label = formatModelLabel(
			{ modelText: "claude-opus-5-5", thinking: "high", modelSource: "inherited" },
			{ withProvider: false },
		);
		expect(label).toBe("claude-opus-5-5 high");
	});

	it("shows 'default model' for an unconfirmed child-default model", () => {
		const label = formatModelLabel(
			{ modelText: "default model", modelSource: "child-default" },
			{ withProvider: false },
		);
		expect(label).toBe("default model");
	});

	it("never returns a leading space when the id and thinking are both empty (fix round 3)", () => {
		const label = formatModelLabel({ modelSource: "inherited" }, { withProvider: true, withSource: true });
		expect(label).toBe("(inherited)");
		expect(label.startsWith(" ")).toBe(false);
	});
});

describe("spinnerFrame", () => {
	it("cycles through SPINNER_FRAMES every 250ms", () => {
		expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
		expect(spinnerFrame(249)).toBe(SPINNER_FRAMES[0]);
		expect(spinnerFrame(250)).toBe(SPINNER_FRAMES[1]);
		expect(spinnerFrame(500)).toBe(SPINNER_FRAMES[2]);
		expect(spinnerFrame(750)).toBe(SPINNER_FRAMES[3]);
		expect(spinnerFrame(1000)).toBe(SPINNER_FRAMES[0]);
	});
});

const EXPECTED_GLYPHS: Record<AgentStatus, string> = {
	pending: "·",
	queued: "◌",
	starting: "●",
	running: "●",
	done: "✓",
	failed: "✗",
	cancelled: "⊘",
	skipped: "–",
};

const EXPECTED_COLORS: Record<AgentStatus, ThemeColor> = {
	pending: "dim",
	queued: "dim",
	starting: "accent",
	running: "accent",
	done: "success",
	failed: "error",
	cancelled: "warning",
	skipped: "muted",
};

describe("statusGlyph / statusColor", () => {
	it("returns the exact themed glyph for every status (§11.3)", () => {
		for (const status of STATUSES) {
			const glyph = statusGlyph(status, theme, { now: 0, animate: false });
			expect(stripAnsi(glyph)).toBe(EXPECTED_GLYPHS[status]);
			expect(statusColor(status)).toBe(EXPECTED_COLORS[status]);
		}
	});

	it("animates running/starting with the spinner, otherwise shows a static dot", () => {
		expect(stripAnsi(statusGlyph("running", theme, { now: 0, animate: true }))).toBe(SPINNER_FRAMES[0]);
		expect(stripAnsi(statusGlyph("running", theme, { now: 0, animate: false }))).toBe("●");
	});
});

describe("oneLine", () => {
	it("collapses whitespace and newlines", () => {
		expect(oneLine("a\n\n  b\tc  ")).toBe("a b c");
	});
});

const WIDTHS = [10, 20, 40, 78];
const SAMPLES = [
	"plain ascii text that is fairly long for testing truncation",
	"日本語のテキストです。幅を確認するためのサンプル文字列です。",
	"emoji test 🎉🚀🔥 with 🧪 mixed content and more 🎯 padding text",
	theme.fg("accent", "a coloured line of text that is long enough to truncate at any width"),
];

describe("fitLine", () => {
	for (const width of WIDTHS) {
		for (const sample of SAMPLES) {
			it(`never exceeds width ${width} for ${JSON.stringify(stripAnsi(sample).slice(0, 12))}…`, () => {
				const line = fitLine(sample, width);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			});
		}
	}
});

describe("padToWidth", () => {
	it("pads short text with trailing spaces", () => {
		const padded = padToWidth("hi", 5);
		expect(padded).toBe("hi   ");
		expect(visibleWidth(padded)).toBe(5);
	});

	it("truncates long text without an ellipsis", () => {
		const padded = padToWidth("hello world", 5);
		expect(visibleWidth(padded)).toBe(5);
		expect(padded).not.toContain("…");
	});
});

describe("columns", () => {
	for (const width of WIDTHS) {
		it(`never exceeds width ${width} with CJK, emoji and ANSI-coloured cells`, () => {
			const line = columns(
				[
					{ text: "◐", width: 2 },
					{ text: theme.fg("accent", "日本語ラベル"), width: 10, align: "left" },
					{ text: theme.fg("success", "emoji 🎉🚀"), width: "flex" },
					{ text: "0:12", width: 5, align: "right" },
				],
				width,
			);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});
	}

	it("right-aligns a fixed-width cell", () => {
		const line = columns(
			[
				{ text: "flex", width: "flex" },
				{ text: "0:12", width: 6, align: "right" },
			],
			20,
		);
		expect(line.endsWith("  0:12")).toBe(true);
	});

	it("distributes remaining width evenly across multiple flex cells", () => {
		const line = columns(
			[
				{ text: "a", width: "flex" },
				{ text: "b", width: "flex" },
			],
			21,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(21);
		expect(line.length).toBe(21);
		expect(line[11]).toBe("b");
	});
});
