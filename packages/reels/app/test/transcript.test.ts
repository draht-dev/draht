import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../../src/contract.js";
import { activeSceneIndex, activeSegment } from "../src/lib/transcript.js";

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
