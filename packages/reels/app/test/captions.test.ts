import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../../src/contract.js";
import { currentCaptionChunk } from "../src/lib/captions.js";

const segment: TranscriptSegment = {
	sceneIndex: 0,
	text: "Here is a short sentence, with a clause break too.",
	startMs: 0,
	endMs: 4000,
	words: "Here is a short sentence, with a clause break too.".split(" ").map((text, i) => ({
		text,
		startMs: i * 400,
		endMs: i * 400 + 350,
	})),
};

describe("currentCaptionChunk", () => {
	test("picks the chunk containing the active word, and the word's position within it", () => {
		const chunk = currentCaptionChunk(segment, 0);
		expect(chunk).toBeDefined();
		expect(chunk?.words[chunk.activeIndexInChunk]?.text).toBe("Here");
	});

	test("the active index moves as playback advances within the same chunk", () => {
		const first = currentCaptionChunk(segment, 0);
		const later = currentCaptionChunk(segment, 400);
		expect(later?.words[later.activeIndexInChunk]?.text).toBe("is");
		expect(first?.words).toBe(first?.words); // chunking is stable for the same segment
	});

	test("undefined before the first word starts", () => {
		expect(currentCaptionChunk(segment, -1)).toBeUndefined();
	});

	test("undefined when the segment has no word timing", () => {
		expect(currentCaptionChunk({ sceneIndex: 0, text: "x", startMs: 0, endMs: 100 }, 0)).toBeUndefined();
		expect(currentCaptionChunk(undefined, 0)).toBeUndefined();
	});
});
