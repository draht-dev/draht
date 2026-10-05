import { describe, expect, test } from "bun:test";
import type { TimedWord } from "../src/contract.ts";
import { CAPTION_MAX_LINES } from "../src/remotion/props.ts";
import {
	CAPTION_CHAR_BUDGET,
	CHARS_PER_LINE,
	chunkWords,
	currentSentence,
	currentWordIndex,
	findChunkForWord,
	simulateLineCount,
	splitIntoBudgetChunks,
	splitSentences,
	splitWordIntoPages,
	wordBreakSegments,
	wordLineCount,
} from "../src/remotion/scenes/caption-logic.ts";

function words(...texts: string[]): TimedWord[] {
	return texts.map((text, i) => ({ text, startMs: i * 100, endMs: (i + 1) * 100 }));
}

function chunkLength(chunk: TimedWord[]): number {
	return chunk.reduce((sum, w, i) => sum + w.text.length + (i > 0 ? 1 : 0), 0);
}

function flatten(chunks: TimedWord[][]): string[] {
	return chunks.flatMap((c) => c.map((w) => w.text));
}

describe("chunkWords", () => {
	// Regression: the root cause of captions cutting off after ~1 line — a sentence that
	// comfortably fits the caption's 2 lines must be shown whole, not pre-emptively split
	// once it crosses an arbitrary word count.
	test("keeps a sentence that fits the character budget as a single chunk, however many words it has", () => {
		const text = "This release tightens install security and sharpens review logic.";
		expect(text.length).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
		const chunks = chunkWords(words(...text.split(" ")));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toHaveLength(text.split(" ").length);
	});

	test("splits a sentence that overflows the character budget into multiple chunks, each within budget", () => {
		const longWords = Array.from({ length: 7 }, (_, i) => `disestablishmentarianism${i}`);
		const chunks = chunkWords(words(...longWords));
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunkLength(chunk)).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
	});

	test("every chunk from a long, mostly unpunctuated narration stays within the character budget", () => {
		const narration =
			"Draht's judge queue used to ask a human to re approve decisions the agent had already made before anyone noticed the pattern";
		const chunks = chunkWords(words(...narration.split(" ")));
		for (const chunk of chunks) expect(chunkLength(chunk)).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
	});

	test("never loses or duplicates a word when splitting", () => {
		const narration =
			"Draht's judge queue used to ask a human to re approve decisions the agent had already made before anyone noticed the pattern.";
		const input = words(...narration.split(" "));
		const chunks = chunkWords(input);
		expect(flatten(chunks)).toEqual(input.map((w) => w.text));
	});

	test("never runs a sentence boundary through the middle of a chunk", () => {
		const firstSentence =
			"The same probabilistic process that gets code wrong also wrote the check that should catch it.";
		const secondSentence = "A test written by an agent is a claim, not proof.";
		const firstSentenceWordCount = firstSentence.split(" ").length;
		const chunks = chunkWords(words(...firstSentence.split(" "), ...secondSentence.split(" ")));

		let cumulative = 0;
		let boundaryChunkIndex = -1;
		for (let i = 0; i < chunks.length; i++) {
			cumulative += chunks[i].length;
			if (cumulative >= firstSentenceWordCount) {
				boundaryChunkIndex = i;
				break;
			}
		}
		expect(cumulative).toBe(firstSentenceWordCount);
		expect(boundaryChunkIndex).toBeGreaterThanOrEqual(0);
	});

	test("a single word longer than the budget still gets its own chunk, never an empty one", () => {
		const hugeWord = "x".repeat(CAPTION_CHAR_BUDGET * 2);
		const chunks = chunkWords(words(hugeWord, "ok"));
		expect(chunks.every((c) => c.length > 0)).toBe(true);
		expect(chunks[0].map((w) => w.text)).toEqual([hugeWord]);
	});

	test("prefers splitting at a clause boundary over an arbitrary midpoint when a sentence must split", () => {
		const text =
			"SHA-256-bound release evidence over the exact installer source, the review command template's step now escalates a critical finding.";
		const chunks = chunkWords(words(...text.split(" ")));
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0][chunks[0].length - 1].text.endsWith(",")).toBe(true);
	});

	test("avoids a 1-2 word orphan chunk when a more balanced split is available", () => {
		const text =
			"Atomic token-directory lock ownership, destructive-boundary target revalidation, and release artifact signature verification all landed together.";
		const chunks = chunkWords(words(...text.split(" ")));
		for (const chunk of chunks) expect(chunk.length).toBeGreaterThanOrEqual(3);
	});

	// Real narration from a drafted release reel (release-v2026.9.5-1), copied verbatim from
	// /tmp/reels-accept2/drafts/draht-mono/release-v2026.9.5-1/entry.json's transcript. Longer
	// than the old MAX_CHUNK_WORDS=7 cap, which used to cut it after about one line.
	test("real drafted narration: every chunk fits budget and no sentence is cut after ~1 line when it fits 2", () => {
		const scenes: TimedWord[][] = [
			words(
				"This",
				"release",
				"tightens",
				"install",
				"security",
				"and",
				"sharpens",
				"the",
				"coding",
				"agent's",
				"review",
				"and",
				"verification",
				"logic.",
			),
			words(
				"This",
				"release",
				"also",
				"folds",
				"in",
				"two",
				"upstream-sync",
				"merges,",
				"integrating",
				"7",
				"and",
				"14",
				"commits",
				"of",
				"remaining",
				"upstream",
				"work",
				"into",
				"main.",
			),
			words(
				"That's",
				"the",
				"overview",
				"—",
				"stronger",
				"install",
				"safeguards",
				"and",
				"a",
				"more",
				"rigorous",
				"coding",
				"agent,",
				"all",
				"in",
				"this",
				"release.",
			),
		];
		for (const sceneWords of scenes) {
			const chunks = chunkWords(sceneWords);
			expect(flatten(chunks)).toEqual(sceneWords.map((w) => w.text));
			for (const chunk of chunks) expect(chunkLength(chunk)).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
			const wholeLength = chunkLength(sceneWords);
			if (wholeLength <= CAPTION_CHAR_BUDGET) {
				expect(chunks).toHaveLength(1);
			} else {
				// Still reads as whole phrases, not a lone 1-2 word fragment stranded at the end.
				for (const chunk of chunks) expect(chunk.length).toBeGreaterThanOrEqual(2);
			}
		}
	});
});

function chunkLineCount(chunk: TimedWord[]): number {
	return simulateLineCount(
		chunk.map((w) => w.text),
		CHARS_PER_LINE,
	);
}

describe("chunkWords: real wrap simulation (regression for frame_013-016.jpg)", () => {
	// The reported defect: a character-SUM budget let "Here is <58-char path>." through as one
	// chunk because the sum fit, even though the unbreakable path wasted most of a line and the
	// real layout needed 3 lines, line-clamping to "bug-…" for ~9s.
	test("a sentence with one long unbreakable path never simulates to more than CAPTION_MAX_LINES lines", () => {
		const text = "Here is packages/coding-agent/src/modes/interactive/bug-report.ts.";
		const chunks = chunkWords(words(...text.split(" ")));
		expect(flatten(chunks)).toEqual(text.split(" "));
		for (const chunk of chunks) expect(chunkLineCount(chunk)).toBeLessThanOrEqual(CAPTION_MAX_LINES);
	});

	// A single-word chunk that alone needs more than CAPTION_MAX_LINES lines isn't split by
	// chunkWords (that would desync the chunk/word-index mapping Caption.tsx relies on) — instead
	// Caption.tsx pages through it via splitWordIntoPages. Every multi-word chunk must still fit.
	test("a long URL fits per chunk, or (as a lone word) pages into pieces that each fit", () => {
		const text =
			"See the details at https://github.com/draht-dev/draht/blob/main/packages/reels/src/remotion/scenes/caption-logic.ts for the full diff.";
		const chunks = chunkWords(words(...text.split(" ")));
		expect(flatten(chunks)).toEqual(text.split(" "));
		for (const chunk of chunks) {
			if (chunk.length === 1) {
				for (const page of splitWordIntoPages(chunk[0].text)) {
					expect(simulateLineCount([page], CHARS_PER_LINE)).toBeLessThanOrEqual(CAPTION_MAX_LINES);
				}
			} else {
				expect(chunkLineCount(chunk)).toBeLessThanOrEqual(CAPTION_MAX_LINES);
			}
		}
	});

	test("a sentence with several long identifiers never simulates to more than CAPTION_MAX_LINES lines per chunk", () => {
		const text =
			"The InteractiveBugReportModeController now calls validateReleaseArtifactSignature before escalating to the destructiveBoundaryRevalidation step.";
		const chunks = chunkWords(words(...text.split(" ")));
		expect(flatten(chunks)).toEqual(text.split(" "));
		for (const chunk of chunks) expect(chunkLineCount(chunk)).toBeLessThanOrEqual(CAPTION_MAX_LINES);
	});

	test("never breaks a long token except at one of its own break points", () => {
		const path = "packages/coding-agent/src/modes/interactive/bug-report.ts";
		const segments = wordBreakSegments(path);
		expect(segments.join("")).toBe(path);
		for (const segment of segments) expect(path.includes(segment)).toBe(true);
	});
});

describe("simulateLineCount", () => {
	test("packs whole words greedily onto lines, like CSS normal wrapping", () => {
		expect(simulateLineCount(["one", "two", "three"], 100)).toBe(1);
		expect(simulateLineCount(["aaaa", "bbbb"], 5)).toBe(2);
	});

	test("breaks a token wider than a line at its own break points, continuing without a space", () => {
		const lines = simulateLineCount(["packages/coding-agent/src/modes/interactive/bug-report.ts."], 20);
		expect(lines).toBeGreaterThan(1);
	});
});

describe("splitWordIntoPages", () => {
	test("returns the word unchanged when it already fits", () => {
		expect(splitWordIntoPages("short")).toEqual(["short"]);
	});

	test("returns the word unchanged when it has no break points, however long", () => {
		const hugeWord = "x".repeat(CHARS_PER_LINE * CAPTION_MAX_LINES * 3);
		expect(wordLineCount(hugeWord)).toBeGreaterThan(CAPTION_MAX_LINES);
		expect(splitWordIntoPages(hugeWord)).toEqual([hugeWord]);
	});

	test("pages a long, breakable token into pieces that each fit CAPTION_MAX_LINES lines and reconstruct the word", () => {
		const longPath = Array.from({ length: 12 }, (_, i) => `very-long-directory-segment-${i}`).join("/");
		expect(wordLineCount(longPath)).toBeGreaterThan(CAPTION_MAX_LINES);
		const pages = splitWordIntoPages(longPath);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.join("")).toBe(longPath);
		for (const page of pages)
			expect(simulateLineCount([page], CHARS_PER_LINE)).toBeLessThanOrEqual(CAPTION_MAX_LINES);
	});
});

describe("currentWordIndex", () => {
	const w = words("one", "two", "three");

	test("picks the last word whose start has passed", () => {
		expect(currentWordIndex(w, 150)).toBe(1);
	});

	// Regression: before the first word's startMs there is nothing to show yet (not "the
	// first word already spoken") — the caller treats -1 as "render nothing".
	test("returns -1 before the first word starts", () => {
		expect(currentWordIndex(w, -50)).toBe(-1);
	});

	test("holds the last index after the last word", () => {
		expect(currentWordIndex(w, 10000)).toBe(2);
	});

	test("returns -1 for no words", () => {
		expect(currentWordIndex([], 0)).toBe(-1);
	});
});

describe("findChunkForWord", () => {
	test("finds the chunk and in-chunk position for a word spanning a chunk boundary", () => {
		const longWords = Array.from({ length: 3 }, (_, i) => `disestablishmentarianism${i}`);
		const chunks = chunkWords(words(...longWords));
		expect(chunks.length).toBeGreaterThan(1);
		const found = findChunkForWord(chunks, 2);
		expect(found?.chunk.map((w) => w.text)).toEqual([longWords[2]]);
		expect(found?.indexInChunk).toBe(0);
	});
});

describe("splitSentences", () => {
	test("splits on sentence punctuation, keeping it attached", () => {
		expect(splitSentences("Nobody used it. So now it reviews tests.")).toEqual([
			"Nobody used it.",
			"So now it reviews tests.",
		]);
	});
});

describe("splitIntoBudgetChunks", () => {
	test("splits only at word boundaries, never mid-word", () => {
		const text = "one two three four five six seven eight nine ten eleven twelve thirteen";
		const pieces = splitIntoBudgetChunks(text, 20);
		expect(pieces.join(" ")).toBe(text);
		for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(20);
	});

	test("returns the whole text as one piece when it already fits", () => {
		expect(splitIntoBudgetChunks("short text", 100)).toEqual(["short text"]);
	});
});

describe("currentSentence", () => {
	const text = "Nobody used it. So now it reviews tests.";

	test("picks the first sentence near the start", () => {
		expect(currentSentence(text, 0.1)).toBe("Nobody used it.");
	});

	test("picks the last sentence near the end", () => {
		expect(currentSentence(text, 0.95)).toBe("So now it reviews tests.");
	});

	test("never truncates: the returned sentence is always whole", () => {
		for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
			const sentence = currentSentence(text, fraction);
			expect(text.includes(sentence)).toBe(true);
		}
	});

	// Regression: a sentence longer than the caption's character budget must be
	// split into budget-sized pieces (by character share) instead of being handed to the
	// caption whole, which would overflow the 2-line box.
	test("splits a sentence longer than the character budget into pieces that each fit", () => {
		const longSentence =
			"The same probabilistic process that gets code wrong also wrote the check that should catch it, so a test written by an agent is a claim, not proof, and the machine goes first whenever it can answer the question itself.";
		expect(longSentence.length).toBeGreaterThan(CAPTION_CHAR_BUDGET);
		for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
			const piece = currentSentence(longSentence, fraction);
			expect(piece.length).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
			expect(longSentence.includes(piece)).toBe(true);
		}
	});
});
