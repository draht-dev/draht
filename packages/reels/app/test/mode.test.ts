import { describe, expect, test } from "bun:test";
import { resolvePlaybackMode } from "../src/lib/mode.js";

describe("resolvePlaybackMode", () => {
	test("prefers visual when video is available", () => {
		expect(resolvePlaybackMode("visual", { video: "v.mp4", audio: "a.mp3" })).toBe("visual");
	});

	test("falls back to audio when video is preferred but missing", () => {
		expect(resolvePlaybackMode("visual", { video: undefined, audio: "a.mp3" })).toBe("audio");
	});

	test("falls back to slideshow when neither asset exists", () => {
		expect(resolvePlaybackMode("visual", {})).toBe("slideshow");
		expect(resolvePlaybackMode("audio", {})).toBe("slideshow");
	});

	test("prefers audio when audio is available", () => {
		expect(resolvePlaybackMode("audio", { video: "v.mp4", audio: "a.mp3" })).toBe("audio");
	});

	test("falls back to the silent slideshow (never to video) when audio is preferred but missing", () => {
		expect(resolvePlaybackMode("audio", { video: "v.mp4", audio: undefined })).toBe("slideshow");
	});
});
