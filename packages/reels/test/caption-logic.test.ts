import { describe, expect, test } from "bun:test";
import type { TimedWord } from "../src/contract.ts";
import {
	CAPTION_CHAR_BUDGET,
	chunkWords,
	currentSentence,
	currentWordIndex,
	findChunkForWord,
	splitIntoBudgetChunks,
	splitSentences,
} from "../src/remotion/scenes/caption-logic.ts";

function words(...texts: string[]): TimedWord[] {
	return texts.map((text, i) => ({ text, startMs: i * 100, endMs: (i + 1) * 100 }));
}

describe("chunkWords", () => {
	test("breaks at a max of 7 words", () => {
		const chunks = chunkWords(words("one", "two", "three", "four", "five", "six", "seven", "eight"));
		expect(chunks.map((c) => c.map((w) => w.text))).toEqual([
			["one", "two", "three", "four", "five", "six", "seven"],
			["eight"],
		]);
	});

	test("prefers breaking after punctuation once a chunk has a few words", () => {
		const chunks = chunkWords(words("Draht's", "judge", "queue,", "nobody", "used", "it."));
		expect(chunks.map((c) => c.map((w) => w.text))).toEqual([
			["Draht's", "judge", "queue,"],
			["nobody", "used", "it."],
		]);
	});

	test("does not break on a clause comma before the minimum chunk size, but still breaks on a sentence end regardless of chunk size", () => {
		const chunks = chunkWords(words("Wait,", "really?", "yes", "it", "does"));
		expect(chunks.map((c) => c.map((w) => w.text))).toEqual([
			["Wait,", "really?"],
			["yes", "it", "does"],
		]);
	});

	test("never lets a chunk run a sentence boundary through its middle, even well under the max chunk size", () => {
		const chunks = chunkWords(
			words("the", "test", "was", "a", "rubber", "stamp.", "An", "assertion", "failure", "is", "a", "real", "red,"),
		);
		expect(chunks.map((c) => c.map((w) => w.text))).toEqual([
			["the", "test", "was", "a", "rubber", "stamp."],
			["An", "assertion", "failure", "is", "a", "real", "red,"],
		]);
	});

	test("breaks after a sentence end followed by a closing quote or paren", () => {
		const chunks = chunkWords(words("He", "said", '"done."', "Then", "left."));
		expect(chunks.map((c) => c.map((w) => w.text))).toEqual([
			["He", "said", '"done."'],
			["Then", "left."],
		]);
	});

	// Regression: a run of words with no sentence/clause punctuation and under
	// the max word count must still break once it would overflow the caption's character
	// budget, or a long enough chunk would overflow the caption box at render time.
	test("breaks on the character budget even with no punctuation and under the max word count", () => {
		const longWords = Array.from({ length: 7 }, (_, i) => `disestablishmentarianism${i}`);
		const chunks = chunkWords(words(...longWords));
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const length = chunk.reduce((sum, w, i) => sum + w.text.length + (i > 0 ? 1 : 0), 0);
			expect(length).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
		}
	});

	test("every chunk from a long, mostly unpunctuated narration stays within the character budget", () => {
		const narration =
			"Draht's judge queue used to ask a human to re approve decisions the agent had already made before anyone noticed the pattern";
		const chunks = chunkWords(words(...narration.split(" ")));
		for (const chunk of chunks) {
			const length = chunk.reduce((sum, w, i) => sum + w.text.length + (i > 0 ? 1 : 0), 0);
			expect(length).toBeLessThanOrEqual(CAPTION_CHAR_BUDGET);
		}
	});

	test("a single word longer than the budget still gets its own chunk, never an empty one", () => {
		const hugeWord = "x".repeat(CAPTION_CHAR_BUDGET * 2);
		const chunks = chunkWords(words(hugeWord, "ok"));
		expect(chunks.every((c) => c.length > 0)).toBe(true);
		expect(chunks[0].map((w) => w.text)).toEqual([hugeWord]);
	});
});

describe("currentWordIndex", () => {
	const w = words("one", "two", "three");

	test("picks the last word whose start has passed", () => {
		expect(currentWordIndex(w, 150)).toBe(1);
	});

	// Regression: before the first word's startMs there is nothing to show yet
	// (not "the first word already spoken") — the caller treats -1 as "render nothing".
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
		const chunks = chunkWords(words("one", "two", "three", "four", "five", "six", "seven", "eight", "nine"));
		const found = findChunkForWord(chunks, 7);
		expect(found?.chunk.map((w) => w.text)).toEqual(["eight", "nine"]);
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
