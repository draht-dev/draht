/**
 * Narration synthesis. `fetch` is always injected so tests never hit the
 * network. Follows `packages/draht-claude/scripts/speak.cjs` conventions for
 * env var names and ElevenLabs request shape.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Scene, TranscriptSegment } from "./contract.ts";
import { mp3DurationMs } from "./mp3.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // George — multilingual narrative
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
const WORDS_PER_SECOND = 2.6;

export interface SceneAudio {
	/** Absent in silent mode. */
	audioPath?: string;
	durationMs: number;
}

export interface NarrationResult {
	scenes: SceneAudio[];
	transcript: TranscriptSegment[];
	/** Path to the concatenated reel audio, absent in silent mode. */
	audioPath?: string;
}

export interface TtsProvider {
	synthesize(scenes: Scene[], outDir: string): Promise<NarrationResult>;
}

function buildTranscript(scenes: Scene[], durationsMs: number[]): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	let cursor = 0;
	scenes.forEach((scene, sceneIndex) => {
		const durationMs = durationsMs[sceneIndex] ?? 0;
		segments.push({ sceneIndex, text: scene.narration, startMs: cursor, endMs: cursor + durationMs });
		cursor += durationMs;
	});
	return segments;
}

function estimateDurationMs(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	return Math.max(500, Math.round((words / WORDS_PER_SECOND) * 1000));
}

export const silentProvider: TtsProvider = {
	async synthesize(scenes) {
		const durations = scenes.map((scene) => estimateDurationMs(scene.narration));
		return {
			scenes: durations.map((durationMs) => ({ durationMs })),
			transcript: buildTranscript(scenes, durations),
		};
	},
};

interface ElevenLabsAlignment {
	characters: string[];
	character_end_times_seconds: number[];
}

interface ElevenLabsResponse {
	audio_base64: string;
	alignment?: ElevenLabsAlignment;
	normalized_alignment?: ElevenLabsAlignment;
}

function durationFromAlignment(alignment: ElevenLabsAlignment | undefined, fallbackText: string): number {
	const endTimes = alignment?.character_end_times_seconds;
	if (!endTimes || endTimes.length === 0) return estimateDurationMs(fallbackText);
	return Math.round(endTimes[endTimes.length - 1] * 1000);
}

export interface ElevenLabsOptions {
	apiKey: string;
	voice?: string;
	model?: string;
	fetch?: typeof fetch;
}

export function elevenLabsProvider(options: ElevenLabsOptions): TtsProvider {
	const voice = options.voice ?? process.env.DRAHT_SPEAK_VOICE_ID ?? DEFAULT_VOICE;
	const model = options.model ?? DEFAULT_TTS_MODEL;
	const fetchImpl = options.fetch ?? fetch;

	return {
		async synthesize(scenes, outDir) {
			// Per-scene MP3s are scratch files, not published output: keep them
			// in a temp dir (removed before returning) so the reel's media
			// directory only ever contains the one final audio.mp3, not every
			// intermediate scene clip plus a redundant pre-copy of the mix.
			const scratchDir = await mkdtemp(join(tmpdir(), "draht-reels-tts-"));
			try {
				const durations: number[] = [];
				const scratchPaths: string[] = [];

				for (let i = 0; i < scenes.length; i++) {
					const scene = scenes[i];
					const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps`;
					const res = await fetchImpl(url, {
						method: "POST",
						headers: { "xi-api-key": options.apiKey, "Content-Type": "application/json" },
						body: JSON.stringify({ text: scene.narration, model_id: model }),
					});
					if (!res.ok) {
						const detail = await res.text().catch(() => "");
						throw new Error(`ElevenLabs API error ${res.status} for scene ${i}: ${detail.slice(0, 400)}`);
					}
					const body = (await res.json()) as ElevenLabsResponse;
					const audio = Buffer.from(body.audio_base64, "base64");
					// The clip's real length decides where the next scene starts in the concatenated audio.
					const durationMs = mp3DurationMs(audio) ?? durationFromAlignment(body.alignment, scene.narration);
					const scratchPath = join(scratchDir, `scene-${i}.mp3`);
					await writeFile(scratchPath, audio);

					durations.push(durationMs);
					scratchPaths.push(scratchPath);
				}

				const audioPath =
					scratchPaths.length > 0 ? await concatenateMp3(scratchPaths, join(outDir, "audio.mp3")) : undefined;

				return {
					scenes: durations.map((durationMs) => ({ durationMs })),
					transcript: buildTranscript(scenes, durations),
					audioPath,
				};
			} finally {
				await rm(scratchDir, { recursive: true, force: true });
			}
		},
	};
}

async function hasFfmpeg(): Promise<boolean> {
	try {
		await execFileAsync("ffmpeg", ["-version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Concatenates same-format MP3 files into one. Prefers ffmpeg when present
 * on PATH; falls back to raw frame concatenation, which is valid for CBR
 * MP3s sharing a sample rate and bitrate (as ElevenLabs produces per voice
 * and model here).
 */
export async function concatenateMp3(inputPaths: string[], outputPath: string): Promise<string> {
	if (inputPaths.length === 1) {
		await writeFile(outputPath, await readFile(inputPaths[0]));
		return outputPath;
	}

	if (await hasFfmpeg()) {
		const listDir = await mkdtemp(join(tmpdir(), "draht-reels-concat-"));
		const listFile = join(listDir, "list.txt");
		await writeFile(listFile, inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
		await execFileAsync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outputPath]);
		return outputPath;
	}

	const buffers = await Promise.all(inputPaths.map((p) => readFile(p)));
	await writeFile(outputPath, Buffer.concat(buffers));
	return outputPath;
}
