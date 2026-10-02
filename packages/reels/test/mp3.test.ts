import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mp3DurationMs } from "../src/mp3.ts";

const TONE = readFileSync(join(import.meta.dir, "fixtures", "tone.mp3"));

describe("mp3DurationMs", () => {
	// ffprobe (bundled with @remotion/compositor) reports duration=0.574694 for this fixture.
	test("matches ffprobe on a real MP3, excluding the Xing/Info metadata frame", () => {
		expect(mp3DurationMs(TONE)).toBe(575);
	});

	test("skips a leading ID3v2 tag", () => {
		const tag = Buffer.alloc(10 + 20);
		tag.write("ID3", 0);
		tag[3] = 4;
		tag[9] = 20; // synchsafe size of the tag body
		expect(mp3DurationMs(Buffer.concat([tag, TONE]))).toBe(575);
	});

	test("counts concatenated clips as the sum of their audio", () => {
		expect(mp3DurationMs(Buffer.concat([TONE, TONE]))).toBeGreaterThanOrEqual(1150);
	});

	test("returns undefined for data with no MPEG frames", () => {
		expect(mp3DurationMs(Buffer.from("not an mp3 at all"))).toBeUndefined();
	});
});
