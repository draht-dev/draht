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
import type { Beat, Scene, TimedWord, TranscriptSegment } from "./contract.ts";
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

/** Scene-relative timing (ms from the scene's own start), added to the reel cursor in {@link buildTranscript}. */
interface SceneTiming {
	durationMs: number;
	words?: TimedWord[];
	beatStartsMs?: number[];
}

function buildTranscript(scenes: Scene[], timings: SceneTiming[]): TranscriptSegment[] {
	const segments: TranscriptSegment[] = [];
	let cursor = 0;
	scenes.forEach((scene, sceneIndex) => {
		const { durationMs, words, beatStartsMs } = timings[sceneIndex] ?? { durationMs: 0 };
		segments.push({
			sceneIndex,
			text: scene.narration,
			startMs: cursor,
			endMs: cursor + durationMs,
			words: words?.map((word) => ({ ...word, startMs: word.startMs + cursor, endMs: word.endMs + cursor })),
			beatStartsMs: beatStartsMs?.map((ms) => ms + cursor),
		});
		cursor += durationMs;
	});
	return segments;
}

function estimateDurationMs(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	return Math.max(500, Math.round((words / WORDS_PER_SECOND) * 1000));
}

function collapseWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 * Rebuilds a scene's narration from its beats (each beat's text trimmed and
 * internal whitespace collapsed to a single space), so
 * `narration === beats.map(b => b.text).join(" ")` holds exactly, whatever
 * whitespace the beats were authored with. A scene with no beats is
 * returned unchanged. Both providers call this first, so the text actually
 * sent for synthesis/alignment always matches the beats used to derive
 * `beatStartsMs` from it.
 */
export function normalizeBeats<S extends Scene>(scene: S): S {
	if (!scene.beats || scene.beats.length === 0) return scene;
	const beats: Beat[] = scene.beats
		.map((beat) => ({ ...beat, text: collapseWhitespace(beat.text) }))
		.filter((beat) => beat.text.length > 0);
	if (beats.length === 0) return { ...scene, beats: undefined };
	return { ...scene, beats, narration: beats.map((beat) => beat.text).join(" ") };
}

/**
 * Splits `text` into words (runs of non-whitespace) with even timing across
 * `durationMs`: each word gets an equal time slice, in order. Used when no
 * TTS alignment is available (the silent provider).
 */
export function estimateWordTimings(text: string, durationMs: number): TimedWord[] {
	const matches = [...text.matchAll(/\S+/g)];
	if (matches.length === 0) return [];
	const step = durationMs / matches.length;
	return matches.map((match, i) => ({
		text: match[0],
		startMs: Math.round(i * step),
		endMs: Math.round((i + 1) * step),
	}));
}

/**
 * Beat start times (ms) from the *word index*: beat i starts at the first
 * word after every earlier beat's words have been spoken, using whitespace
 * tokenization of the beat texts against the already-timed `words` (real
 * alignment or the silent estimate — either way). This is immune to
 * character-level drift between a beat's authored text and however the
 * words ended up segmented.
 *
 * If the beats' word counts don't sum to `words.length`, something split
 * differently than expected and timing can't be trusted: returns
 * `undefined` rather than silently shifting every beat after the mismatch.
 * Callers should log a warning and fall back to no beat timing for that
 * scene (no focus, but the scene still plays normally).
 */
export function beatStartsMsFromWords(beats: Beat[], words: TimedWord[]): number[] | undefined {
	const wordCounts = beats.map((beat) => beat.text.split(/\s+/).filter(Boolean).length);
	if (wordCounts.reduce((sum, n) => sum + n, 0) !== words.length) return undefined;

	const starts: number[] = [];
	let wordIndex = 0;
	for (const count of wordCounts) {
		starts.push(words[wordIndex]?.startMs ?? 0);
		wordIndex += count;
	}
	return starts;
}

function beatStartsMsOrWarn(sceneIndex: number, beats: Beat[], words: TimedWord[]): number[] | undefined {
	const starts = beatStartsMsFromWords(beats, words);
	if (!starts) {
		console.warn(
			`draht-reels: scene ${sceneIndex}'s beats' word count does not match its aligned words; dropping beat timing (no focus) for this scene`,
		);
	}
	return starts;
}

export const silentProvider: TtsProvider = {
	async synthesize(rawScenes) {
		const scenes = rawScenes.map(normalizeBeats);
		const timings = scenes.map((scene, sceneIndex): SceneTiming => {
			const durationMs = estimateDurationMs(scene.narration);
			const words = estimateWordTimings(scene.narration, durationMs);
			return {
				durationMs,
				words,
				beatStartsMs: scene.beats ? beatStartsMsOrWarn(sceneIndex, scene.beats, words) : undefined,
			};
		});
		return {
			scenes: timings.map(({ durationMs }) => ({ durationMs })),
			transcript: buildTranscript(scenes, timings),
		};
	},
};

interface ElevenLabsAlignment {
	characters: string[];
	character_start_times_seconds?: number[];
	character_end_times_seconds: number[];
}

/** Start time (seconds) of character `index`, falling back to the previous character's end when no start-times array was returned. */
function charStartSeconds(index: number, alignment: ElevenLabsAlignment): number {
	if (alignment.character_start_times_seconds) return alignment.character_start_times_seconds[index] ?? 0;
	if (index === 0) return 0;
	return alignment.character_end_times_seconds[index - 1] ?? 0;
}

/**
 * Derives word timings from ElevenLabs per-character alignment: runs of
 * non-whitespace characters become words, timed from the first character's
 * start to the last character's end. Handles punctuation (kept attached to
 * the word) and runs of multiple whitespace characters (treated as a single
 * separator).
 */
export function wordsFromAlignment(alignment: ElevenLabsAlignment): TimedWord[] {
	const words: TimedWord[] = [];
	let current = "";
	let startSeconds = 0;
	let endSeconds = 0;

	const flush = () => {
		if (!current) return;
		words.push({ text: current, startMs: Math.round(startSeconds * 1000), endMs: Math.round(endSeconds * 1000) });
		current = "";
	};

	alignment.characters.forEach((char, i) => {
		if (/\s/.test(char)) {
			flush();
			return;
		}
		if (!current) startSeconds = charStartSeconds(i, alignment);
		endSeconds = alignment.character_end_times_seconds[i] ?? endSeconds;
		current += char;
	});
	flush();

	return words;
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
		async synthesize(rawScenes, outDir) {
			const scenes = rawScenes.map(normalizeBeats);
			// Per-scene MP3s are scratch files, not published output: keep them
			// in a temp dir (removed before returning) so the reel's media
			// directory only ever contains the one final audio.mp3, not every
			// intermediate scene clip plus a redundant pre-copy of the mix.
			const scratchDir = await mkdtemp(join(tmpdir(), "draht-reels-tts-"));
			try {
				const timings: SceneTiming[] = [];
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

					const words = body.alignment ? wordsFromAlignment(body.alignment) : undefined;
					timings.push({
						durationMs,
						words,
						beatStartsMs: scene.beats && words ? beatStartsMsOrWarn(i, scene.beats, words) : undefined,
					});
					scratchPaths.push(scratchPath);
				}

				const audioPath =
					scratchPaths.length > 0 ? await concatenateMp3(scratchPaths, join(outDir, "audio.mp3")) : undefined;

				return {
					scenes: timings.map(({ durationMs }) => ({ durationMs })),
					transcript: buildTranscript(scenes, timings),
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
