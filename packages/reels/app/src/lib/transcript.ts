import type { TranscriptSegment } from "../../../src/contract.js";
import { currentWordIndex } from "../../../src/remotion/scenes/caption-logic.ts";

/**
 * The segment covering `currentMs`, or the nearest preceding one if playback
 * is between segments (e.g. a silent gap). Returns `undefined` for an empty
 * transcript or before the first segment starts.
 */
export function activeSegment(transcript: TranscriptSegment[], currentMs: number): TranscriptSegment | undefined {
	let candidate: TranscriptSegment | undefined;
	for (const segment of transcript) {
		if (segment.startMs > currentMs) break;
		candidate = segment;
	}
	return candidate;
}

export function activeSceneIndex(transcript: TranscriptSegment[], currentMs: number): number | undefined {
	return activeSegment(transcript, currentMs)?.sceneIndex;
}

/**
 * Index of the beat active at `currentMs` within `segment.beatStartsMs`
 * (reel-absolute ms, parallel to `scene.beats`), mirroring
 * `src/remotion/beats.ts`'s frame-based `activeBeatIndex` in ms instead of
 * frames. Returns -1 when the segment has no beat timing, or playback is
 * before the first beat.
 */
export function activeBeatIndex(segment: TranscriptSegment | undefined, currentMs: number): number {
	const starts = segment?.beatStartsMs;
	if (!starts || starts.length === 0) return -1;
	let index = -1;
	for (let i = 0; i < starts.length; i++) {
		if (currentMs >= starts[i]) index = i;
		else break;
	}
	return index;
}

/**
 * Index of the word active at `currentMs` within `segment.words`, delegating
 * to the video engine's own `currentWordIndex` (`caption-logic.ts`) so
 * audio-mode captions pick the same word as the rendered video's. Returns -1
 * when the segment has no word timing, or before the first word starts.
 */
export function activeWordIndex(segment: TranscriptSegment | undefined, currentMs: number): number {
	const words = segment?.words;
	if (!words || words.length === 0) return -1;
	return currentWordIndex(words, currentMs);
}
