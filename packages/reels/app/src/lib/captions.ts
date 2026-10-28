import type { TimedWord, TranscriptSegment } from "../../../src/contract.js";
import { chunkWords, findChunkForWord } from "../../../src/remotion/scenes/caption-logic.ts";
import { activeWordIndex } from "./transcript.js";

export interface CaptionChunk {
	words: TimedWord[];
	/** Index within `words` of the word active at the queried time. */
	activeIndexInChunk: number;
}

/**
 * The caption chunk and active-word position at `currentMs`, reusing the
 * video engine's own word chunking (`caption-logic.ts`'s `chunkWords`) so
 * audio-mode captions group and highlight words the same way the rendered
 * video does. Undefined before the segment's first word starts, or when the
 * segment has no word timing (callers fall back to the plain segment text).
 */
export function currentCaptionChunk(segment: TranscriptSegment | undefined, currentMs: number): CaptionChunk | undefined {
	const words = segment?.words;
	if (!words || words.length === 0) return undefined;
	const wordIndex = activeWordIndex(segment, currentMs);
	if (wordIndex < 0) return undefined;
	const chunks = chunkWords(words);
	const active = findChunkForWord(chunks, wordIndex);
	return active ? { words: active.chunk, activeIndexInChunk: active.indexInChunk } : undefined;
}
