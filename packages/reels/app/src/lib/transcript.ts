import type { TranscriptSegment } from "../../../src/contract.js";

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
