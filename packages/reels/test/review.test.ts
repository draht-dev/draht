import { describe, expect, test } from "bun:test";
import type { OutroScene, ReelEntry, ReelScript, TitleScene } from "../src/contract.ts";
import type { DraftMeta, DraftScriptSnapshot, DraftSourceSnapshot } from "../src/review.ts";
import { excerptAroundQuote, renderReviewMd } from "../src/review.ts";
import type { BeatNote, SceneNotes } from "../src/story-validate.ts";

const BASE_META: DraftMeta = {
	title: "Some draft",
	origin: "commit",
	writer: "template",
	repaired: false,
	costUsd: 0,
	createdAt: "2026-10-05T00:00:00.000Z",
};

function entry(overrides: Partial<ReelEntry> = {}): ReelEntry {
	return {
		id: "entry-1",
		commits: [],
		title: "Some draft",
		authors: [],
		date: "2026-10-05T00:00:00.000Z",
		durationMs: 0,
		scenes: [],
		transcript: [],
		stats: { files: 0, additions: 0, deletions: 0 },
		...overrides,
	};
}

function titleScene(narration: string): TitleScene {
	return { kind: "title", title: "Title", subtitle: "Subtitle", narration };
}

function outroWithBeat(text: string, cites: string[]): OutroScene {
	return {
		kind: "outro",
		narration: text,
		beats: [{ text, cites }],
	};
}

function source(overrides: Partial<DraftSourceSnapshot> = {}): DraftSourceSnapshot {
	return {
		id: "src-1",
		kind: "commit",
		label: "a commit",
		text: "the full source text",
		included: true,
		...overrides,
	};
}

describe("renderReviewMd", () => {
	test("story draft: beat with cite and quote renders excerpt, not full source text", () => {
		const longText = `lead-in words before the quote. ${"filler ".repeat(100)}the important quoted phrase here${" more filler".repeat(100)}`;
		const script: ReelScript = {
			changeSetId: "c1",
			writer: "template",
			scenes: [outroWithBeat("because of the important quoted phrase here", ["src-1"])],
		};
		const notes: SceneNotes[] = [
			{ beats: [{ claim: "why", quote: "the important quoted phrase here" } satisfies BeatNote] },
		];
		const snapshot: DraftScriptSnapshot = {
			script,
			notes,
			sources: [source({ text: longText })],
			meta: BASE_META,
		};

		const md = renderReviewMd(entry({ kind: "story" }), snapshot);

		expect(md).toContain('quote: "the important quoted phrase here"');
		expect(md).toContain("excerpt:");
		expect(md).not.toContain("source: lead-in words before the quote.");
		expect(md).not.toContain(`source: ${longText}`);
	});

	test("release artifact: beat with cite but no quote renders the full cited source text, bounded", () => {
		const sourceText = `commit message body. ${"x".repeat(1000)}`;
		const script: ReelScript = {
			changeSetId: "release-1",
			writer: "template",
			scenes: [outroWithBeat("ships the new feature", ["src-1"])],
		};
		const snapshot: DraftScriptSnapshot = {
			script,
			sources: [source({ id: "src-1", label: "feat: new feature", text: sourceText })],
			meta: BASE_META,
		};

		const md = renderReviewMd(entry({ kind: "release" }), snapshot);

		expect(md).toContain("source: commit message body.");
		expect(md).toContain("…");
		const sourceLine = md.split("\n").find((l) => l.trim().startsWith("source:"));
		expect(sourceLine).toBeDefined();
		expect(sourceLine!.length).toBeLessThan(sourceText.length);
		expect(md).not.toContain("quote:");
	});

	test("recap artifact: beat with cite but no quote renders the full cited source text", () => {
		const script: ReelScript = {
			changeSetId: "recap-1",
			writer: "llm",
			scenes: [outroWithBeat("pulled in upstream fixes", ["upstream-1"])],
		};
		const snapshot: DraftScriptSnapshot = {
			script,
			sources: [
				source({ id: "upstream-1", kind: "changelog", label: "CHANGELOG.md", text: "fixed a crash on startup" }),
			],
			meta: BASE_META,
		};

		const md = renderReviewMd(entry({ kind: "recap" }), snapshot);

		expect(md).toContain("source: fixed a crash on startup");
	});

	test("release artifact: cite not found in registry still reports as missing, not full text", () => {
		const script: ReelScript = {
			changeSetId: "release-2",
			writer: "template",
			scenes: [outroWithBeat("ships the new feature", ["missing-id"])],
		};
		const snapshot: DraftScriptSnapshot = {
			script,
			sources: [],
			meta: BASE_META,
		};

		const md = renderReviewMd(entry({ kind: "release" }), snapshot);

		expect(md).toContain("(source not found in this draft's registry)");
	});

	test("change (kind absent) artifact: beat with cite but no quote shows nothing extra, same as before", () => {
		const script: ReelScript = {
			changeSetId: "c2",
			writer: "template",
			scenes: [outroWithBeat("plain commit change", ["src-1"])],
		};
		const snapshot: DraftScriptSnapshot = {
			script,
			sources: [source({ text: "this text must not leak for plain change entries" })],
			meta: BASE_META,
		};

		const md = renderReviewMd(entry(), snapshot);

		expect(md).not.toContain("this text must not leak for plain change entries");
		expect(md).not.toContain("source:");
	});

	test("title scene with no beats is unaffected by the release/recap full-text fallback", () => {
		const script: ReelScript = { changeSetId: "release-3", writer: "template", scenes: [titleScene("hello")] };
		const snapshot: DraftScriptSnapshot = { script, sources: [], meta: BASE_META };

		const md = renderReviewMd(entry({ kind: "release" }), snapshot);

		expect(md).toContain("Title — Subtitle");
	});
});

describe("excerptAroundQuote", () => {
	test("falls back to a bounded head-of-text excerpt when the quote cannot be found verbatim", () => {
		const text = `start of text ${"word ".repeat(300)}`;
		const result = excerptAroundQuote(text, "a quote that is not in the text at all");
		expect(result.length).toBeLessThan(text.length);
		expect(result.endsWith("…")).toBe(true);
	});
});
