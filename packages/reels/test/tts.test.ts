import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Beat, Scene } from "../src/contract.ts";
import {
	beatStartsMsFromWords,
	elevenLabsProvider,
	estimateWordTimings,
	normalizeBeats,
	silentProvider,
	wordsFromAlignment,
} from "../src/tts.ts";

const SCENES: Scene[] = [
	{ kind: "title", title: "t", subtitle: "s", narration: "This is the first scene." },
	{ kind: "outro", narration: "This is the last scene." },
];

function fauxElevenLabsResponse(text: string, endTimeSeconds: number) {
	const audio = Buffer.from(`fake-mp3-for-${text}`).toString("base64");
	return {
		ok: true,
		status: 200,
		json: async () => ({
			audio_base64: audio,
			alignment: {
				characters: text.split(""),
				character_end_times_seconds: text.split("").map((_, i) => (endTimeSeconds * (i + 1)) / text.length),
			},
		}),
		text: async () => "",
	};
}

describe("silentProvider", () => {
	test("estimates durations from word count and produces no audio", async () => {
		const result = await silentProvider.synthesize(SCENES, "/unused");
		expect(result.scenes.every((s) => s.audioPath === undefined)).toBe(true);
		expect(result.transcript).toHaveLength(2);
		expect(result.transcript[0].startMs).toBe(0);
		expect(result.transcript[1].startMs).toBe(result.transcript[0].endMs);
	});

	test("derives beat starts from estimated word timings, offset by the running scene duration", async () => {
		const beats: Beat[] = [{ text: "One two" }, { text: "three four" }];
		const scenes: Scene[] = [
			{ kind: "title", title: "t", subtitle: "s", narration: "One two three four", beats },
			{ kind: "outro", narration: "five six" },
		];
		const result = await silentProvider.synthesize(scenes, "/unused");
		const [scene1, scene2] = result.transcript;

		expect(scene1.beatStartsMs).toHaveLength(2);
		expect(scene1.beatStartsMs?.[0]).toBe(scene1.startMs);
		expect(scene1.beatStartsMs?.[1]).toBeGreaterThan(scene1.startMs);
		expect(scene1.beatStartsMs?.[1]).toBeLessThan(scene1.endMs);

		// Regression: scene 2's words and beat starts are offset by scene 1's
		// duration (the running cursor buildTranscript carries forward), not scene-relative 0.
		expect(scene2.startMs).toBe(scene1.endMs);
		expect(scene2.words?.[0].startMs).toBe(scene2.startMs);
		expect(scene2.words?.every((w) => w.startMs >= scene1.endMs)).toBe(true);
	});
});

describe("elevenLabsProvider beat timing", () => {
	test("drops beat timing (and warns) for a scene when the aligned word count doesn't match the beats, without affecting other scenes", async () => {
		const beats: Beat[] = [{ text: "One two" }, { text: "three four" }];
		const scenes: Scene[] = [
			{ kind: "title", title: "t", subtitle: "s", narration: "ignored", beats },
			{ kind: "outro", narration: "five six" },
		];
		// The alignment's text has only 3 words where the beats expect 4 — a real-world
		// mismatch between what was sent and what came back aligned.
		const fetchStub = (async (_url: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { text: string };
			if (body.text.startsWith("One")) return fauxElevenLabsResponse("One two three", 3) as unknown as Response;
			return fauxElevenLabsResponse(body.text, 1) as unknown as Response;
		}) as typeof fetch;

		const warnings: unknown[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		const outDir = mkdtempSync(join(tmpdir(), "reels-tts-test-"));
		try {
			const result = await elevenLabsProvider({ apiKey: "fake-key", fetch: fetchStub }).synthesize(scenes, outDir);
			expect(result.transcript[0].beatStartsMs).toBeUndefined();
			expect(warnings.length).toBeGreaterThan(0);
			expect(String(warnings[0])).toContain("scene 0");
		} finally {
			console.warn = originalWarn;
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("elevenLabsProvider", () => {
	test("derives scene durations from alignment end times and never calls the real network", async () => {
		const calls: string[] = [];
		const fetchStub = (async (url: string | URL, init?: RequestInit) => {
			calls.push(String(url));
			const body = JSON.parse(String(init?.body)) as { text: string };
			const durationSeconds = body.text === SCENES[0].narration ? 2.5 : 1.5;
			return fauxElevenLabsResponse(body.text, durationSeconds) as unknown as Response;
		}) as typeof fetch;

		const outDir = mkdtempSync(join(tmpdir(), "reels-tts-test-"));
		try {
			const provider = elevenLabsProvider({ apiKey: "fake-key", fetch: fetchStub });
			const result = await provider.synthesize(SCENES, outDir);

			expect(calls).toHaveLength(2);
			expect(calls.every((url) => url.includes("elevenlabs.io"))).toBe(true);
			expect(result.scenes[0].durationMs).toBe(2500);
			expect(result.scenes[1].durationMs).toBe(1500);
			expect(result.transcript[0].endMs).toBe(2500);
			expect(result.transcript[1].startMs).toBe(2500);
			expect(result.transcript[1].endMs).toBe(4000);
			expect(result.audioPath).toBeDefined();
			if (result.audioPath) {
				const concatenated = readFileSync(result.audioPath);
				expect(concatenated.length).toBeGreaterThan(0);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("the reel directory ends up with only audio.mp3 — no per-scene clips, no intermediate mix, no leaked scratch dir", async () => {
		const fetchStub = (async (_url: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { text: string };
			return fauxElevenLabsResponse(body.text, 1) as unknown as Response;
		}) as typeof fetch;

		const outDir = mkdtempSync(join(tmpdir(), "reels-tts-test-"));
		const tmpDirBefore = new Set(readdirSync(tmpdir()));
		try {
			const provider = elevenLabsProvider({ apiKey: "fake-key", fetch: fetchStub });
			await provider.synthesize(SCENES, outDir);

			expect(readdirSync(outDir)).toEqual(["audio.mp3"]);

			const leakedScratchDirs = readdirSync(tmpdir()).filter(
				(name) => name.startsWith("draht-reels-tts-") && !tmpDirBefore.has(name),
			);
			expect(leakedScratchDirs).toEqual([]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("throws a descriptive error on a non-ok response", async () => {
		const fetchStub = (async (_url: string | URL, _init?: RequestInit) =>
			({
				ok: false,
				status: 401,
				text: async () => "invalid api key",
			}) as unknown as Response) as unknown as typeof fetch;

		const outDir = mkdtempSync(join(tmpdir(), "reels-tts-test-"));
		try {
			const provider = elevenLabsProvider({ apiKey: "fake-key", fetch: fetchStub });
			await expect(provider.synthesize(SCENES, outDir)).rejects.toThrow(/401/);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("elevenLabsProvider timing from real audio", () => {
	test("uses the measured MP3 length, not the shorter alignment end time", async () => {
		const tone = readFileSync(join(import.meta.dir, "fixtures", "tone.mp3")).toString("base64");
		const fetchStub = (async (_url: string | URL, _init?: RequestInit) =>
			({
				ok: true,
				status: 200,
				json: async () => ({
					audio_base64: tone,
					alignment: { characters: ["a"], character_end_times_seconds: [0.2] },
				}),
				text: async () => "",
			}) as unknown as Response) as typeof fetch;
		const outDir = mkdtempSync(join(tmpdir(), "reels-tts-real-"));
		try {
			const result = await elevenLabsProvider({ apiKey: "fake-key", fetch: fetchStub }).synthesize(SCENES, outDir);
			expect(result.scenes.map((s) => s.durationMs)).toEqual([575, 575]);
			expect(result.transcript[1].startMs).toBe(575);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

function uniformAlignment(text: string, msPerChar: number) {
	const characters = text.split("");
	return {
		characters,
		character_start_times_seconds: characters.map((_, i) => (i * msPerChar) / 1000),
		character_end_times_seconds: characters.map((_, i) => ((i + 1) * msPerChar) / 1000),
	};
}

describe("wordsFromAlignment", () => {
	test("splits on whitespace, keeping punctuation attached to the word", () => {
		const words = wordsFromAlignment(uniformAlignment("Wait, really?", 10));
		expect(words.map((w) => w.text)).toEqual(["Wait,", "really?"]);
		expect(words[0].startMs).toBe(0);
		expect(words[0].endMs).toBe(50);
		expect(words[1].startMs).toBe(60);
		expect(words[1].endMs).toBe(130);
	});

	test("collapses runs of multiple spaces into a single separator", () => {
		const words = wordsFromAlignment(uniformAlignment("a  b", 10));
		expect(words.map((w) => w.text)).toEqual(["a", "b"]);
	});

	test("falls back to the previous character's end time when no start-times array is present", () => {
		const alignment = uniformAlignment("hi", 10);
		const withoutStartTimes = {
			characters: alignment.characters,
			character_end_times_seconds: alignment.character_end_times_seconds,
		};
		const words = wordsFromAlignment(withoutStartTimes);
		expect(words).toEqual([{ text: "hi", startMs: 0, endMs: 20 }]);
	});
});

describe("estimateWordTimings", () => {
	test("distributes words evenly across the scene duration", () => {
		const words = estimateWordTimings("one two three four", 4000);
		expect(words.map((w) => w.text)).toEqual(["one", "two", "three", "four"]);
		expect(words.map((w) => w.startMs)).toEqual([0, 1000, 2000, 3000]);
		expect(words.map((w) => w.endMs)).toEqual([1000, 2000, 3000, 4000]);
	});
});

describe("normalizeBeats", () => {
	test("rebuilds narration from the beats, trimmed and with internal whitespace collapsed", () => {
		const scene: Scene = {
			kind: "outro",
			narration: "stale",
			beats: [{ text: "  One   two  " }, { text: "three\tfour" }],
		};
		const normalized = normalizeBeats(scene);
		const beatTexts = normalized.beats?.map((b) => b.text) ?? [];
		expect(beatTexts).toEqual(["One two", "three four"]);
		expect(normalized.narration).toBe("One two three four");
		expect(normalized.narration).toBe(beatTexts.join(" "));
	});

	test("leaves a scene with no beats unchanged", () => {
		const scene: Scene = { kind: "outro", narration: "plain narration" };
		expect(normalizeBeats(scene)).toEqual(scene);
	});
});

describe("beatStartsMsFromWords", () => {
	test("locates a beat boundary by word index, immune to character-level drift", () => {
		const beats: Beat[] = [{ text: "One two" }, { text: "three four" }];
		const words = estimateWordTimings("One two three four", 4000);
		const starts = beatStartsMsFromWords(beats, words);
		expect(starts).toEqual([words[0].startMs, words[2].startMs]);
	});

	// Regression: if the beats' word counts don't sum to the aligned words'
	// count, something split differently than the beat texts assumed — never shift
	// every later beat to compensate; drop timing for the whole scene instead.
	test("returns undefined when the beats' word count does not match the aligned words", () => {
		const beats: Beat[] = [{ text: "One two" }, { text: "three four" }];
		const words = estimateWordTimings("One two three four five", 5000); // 5 words, beats expect 4
		expect(beatStartsMsFromWords(beats, words)).toBeUndefined();
	});
});

describe("normalizeBeats empty beats", () => {
	test("drops empty beats so no beat starts at 0 and the narration has no double space", () => {
		const scene: Scene = {
			kind: "outro",
			narration: "",
			beats: [{ text: "one two" }, { text: "  " }, { text: "three" }],
		};
		const normalized = normalizeBeats(scene);
		expect(normalized.beats?.map((b) => b.text)).toEqual(["one two", "three"]);
		expect(normalized.narration).toBe("one two three");
	});

	test("removes beats entirely when all of them are empty", () => {
		const scene: Scene = { kind: "outro", narration: "kept", beats: [{ text: " " }] };
		expect(normalizeBeats(scene).beats).toBeUndefined();
	});
});
