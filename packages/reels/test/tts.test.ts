import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scene } from "../src/contract.ts";
import { elevenLabsProvider, silentProvider } from "../src/tts.ts";

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
