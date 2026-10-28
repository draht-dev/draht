import { describe, expect, test } from "bun:test";
import type { ReelMedia, TranscriptSegment } from "../../src/contract.js";
import { activeBeat, activeBeatIndex, activeSceneIndex, activeSegment, activeWordIndex } from "../src/lib/transcript.js";

const transcript: TranscriptSegment[] = [
	{ sceneIndex: 0, text: "a", startMs: 0, endMs: 1000 },
	{ sceneIndex: 1, text: "b", startMs: 1000, endMs: 3000 },
	{ sceneIndex: 2, text: "c", startMs: 3000, endMs: 6000 },
];

describe("activeSegment", () => {
	test("returns the segment covering the given time", () => {
		expect(activeSegment(transcript, 0)?.text).toBe("a");
		expect(activeSegment(transcript, 500)?.text).toBe("a");
		expect(activeSegment(transcript, 1000)?.text).toBe("b");
		expect(activeSegment(transcript, 4999)?.text).toBe("c");
	});

	test("returns the last segment once playback is past the end", () => {
		expect(activeSegment(transcript, 999_999)?.text).toBe("c");
	});

	test("returns undefined for an empty transcript", () => {
		expect(activeSegment([], 500)).toBeUndefined();
	});
});

describe("activeSceneIndex", () => {
	test("maps time to the owning scene index", () => {
		expect(activeSceneIndex(transcript, 1500)).toBe(1);
	});
});

const segmentWithBeats: TranscriptSegment = {
	sceneIndex: 1,
	text: "b",
	startMs: 1000,
	endMs: 3000,
	beatStartsMs: [1000, 1800, 2500],
};

describe("activeBeatIndex", () => {
	test("returns the beat active at the given time", () => {
		expect(activeBeatIndex(segmentWithBeats, 1000)).toBe(0);
		expect(activeBeatIndex(segmentWithBeats, 1799)).toBe(0);
		expect(activeBeatIndex(segmentWithBeats, 1800)).toBe(1);
		expect(activeBeatIndex(segmentWithBeats, 2999)).toBe(2);
	});

	test("returns -1 before the first beat, and when there is no beat timing", () => {
		expect(activeBeatIndex(segmentWithBeats, 999)).toBe(-1);
		expect(activeBeatIndex(transcript[0], 500)).toBe(-1);
		expect(activeBeatIndex(undefined, 500)).toBe(-1);
	});
});

const segmentWithWords: TranscriptSegment = {
	sceneIndex: 0,
	text: "hello there",
	startMs: 0,
	endMs: 2000,
	words: [
		{ text: "hello", startMs: 0, endMs: 900 },
		{ text: "there", startMs: 900, endMs: 2000 },
	],
};

const reelWithBeats: ReelMedia = {
	durationMs: 6000,
	scenes: [
		{ kind: "title", narration: "a", title: "Title", subtitle: "" },
		{
			kind: "outro",
			narration: "b",
			beats: [{ text: "beat 0" }, { text: "beat 1" }, { text: "beat 2" }],
		},
		{ kind: "outro", narration: "c" },
	],
	transcript: [
		{ sceneIndex: 0, text: "a", startMs: 0, endMs: 1000 },
		segmentWithBeats,
		{ sceneIndex: 2, text: "c", startMs: 3000, endMs: 6000 },
	],
};

describe("activeBeat", () => {
	test("resolves the beat active at the given time via its owning scene", () => {
		expect(activeBeat(reelWithBeats, 1000)?.text).toBe("beat 0");
		expect(activeBeat(reelWithBeats, 1800)?.text).toBe("beat 1");
		expect(activeBeat(reelWithBeats, 2999)?.text).toBe("beat 2");
	});

	test("returns undefined before the first beat, and for a scene with no beats", () => {
		expect(activeBeat(reelWithBeats, 999)).toBeUndefined();
		expect(activeBeat(reelWithBeats, 0)).toBeUndefined();
		expect(activeBeat(reelWithBeats, 4000)).toBeUndefined();
	});
});

describe("activeWordIndex", () => {
	test("returns the word active at the given time", () => {
		expect(activeWordIndex(segmentWithWords, 0)).toBe(0);
		expect(activeWordIndex(segmentWithWords, 899)).toBe(0);
		expect(activeWordIndex(segmentWithWords, 900)).toBe(1);
	});

	test("falls back to -1 before the first word, and when there is no word timing", () => {
		expect(activeWordIndex(transcript[0], 0)).toBe(-1);
		expect(activeWordIndex(undefined, 0)).toBe(-1);
	});
});
