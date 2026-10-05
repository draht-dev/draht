/**
 * Pure caption logic for {@link Caption.tsx}: chunking words into short
 * on-screen phrases and picking which chunk/sentence is current. Kept out of
 * the React component so it can be unit tested without Remotion or a DOM.
 */

import type { TimedWord } from "../../contract.ts";
import { CAPTION_FONT_SIZE, CAPTION_MAX_LINES, CAPTION_PADDING_X, SAFE_ZONE_WIDTH } from "../props.ts";

const MAX_CHUNK_WORDS = 7;
const MIN_CHUNK_WORDS_BEFORE_CLAUSE_BREAK = 3;
/** A sentence end, optionally followed by a closing quote/paren/bracket (e.g. `done."` or `really?)`). */
const SENTENCE_END_PATTERN = /[.!?]+['")\]]*$/;
const CLAUSE_END_PATTERN = /[,;:]$/;

/**
 * Average glyph advance for the caption's sans-serif font, as a fraction of
 * its font size — there is no live DOM to measure text width against (this
 * runs during Remotion's render pass, not after layout), so this is an
 * estimate, deliberately conservative (glyphs are usually narrower) so the
 * budget undershoots rather than overflows the box.
 */
// Conservative: words wrap whole, so lines rarely fill; identifier-dense text averages ~0.56em.
const AVG_CHAR_WIDTH_EM = 0.6;

const CAPTION_CONTENT_WIDTH = SAFE_ZONE_WIDTH - CAPTION_PADDING_X * 2;
const CHARS_PER_LINE = Math.floor(CAPTION_CONTENT_WIDTH / (CAPTION_FONT_SIZE * AVG_CHAR_WIDTH_EM));
/** Max characters (including inter-word spaces) a chunk/piece may contain and still fit {@link CAPTION_MAX_LINES} lines at the caption's font size and width. */
export const CAPTION_CHAR_BUDGET = CHARS_PER_LINE * CAPTION_MAX_LINES;

function textLength(words: readonly string[]): number {
	return words.reduce((sum, w, i) => sum + w.length + (i > 0 ? 1 : 0), 0);
}

/**
 * Breaks `words` into chunks of at most {@link MAX_CHUNK_WORDS} words and
 * {@link CAPTION_CHAR_BUDGET} characters — either limit forces a break
 * before the next word is added, so a chunk never overflows the caption box
 * at its own font size. A sentence end always breaks the chunk — a chunk
 * must never run a sentence boundary through its middle — and a clause
 * break (`, ; :`) breaks it once the chunk has at least a few words.
 */
export function chunkWords(words: TimedWord[]): TimedWord[][] {
	const chunks: TimedWord[][] = [];
	let current: TimedWord[] = [];
	for (const word of words) {
		const overflowsWords = current.length >= MAX_CHUNK_WORDS;
		const overflowsBudget =
			current.length > 0 && textLength([...current.map((w) => w.text), word.text]) > CAPTION_CHAR_BUDGET;
		if (overflowsWords || overflowsBudget) {
			chunks.push(current);
			current = [];
		}
		current.push(word);
		const mustBreak = SENTENCE_END_PATTERN.test(word.text);
		const canBreak = CLAUSE_END_PATTERN.test(word.text) && current.length >= MIN_CHUNK_WORDS_BEFORE_CLAUSE_BREAK;
		if (mustBreak || canBreak) {
			chunks.push(current);
			current = [];
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * Index of the word spoken at `ms`: the last word whose start has passed.
 * Before the first word starts, there is nothing to show yet: -1. After the
 * last word it stays at the last index (held, not reset).
 */
export function currentWordIndex(words: TimedWord[], ms: number): number {
	if (words.length === 0 || ms < words[0].startMs) return -1;
	let index = 0;
	for (let i = 0; i < words.length; i++) {
		if (ms >= words[i].startMs) index = i;
		else break;
	}
	return index;
}

/** The chunk (and the word's position within it) containing word `wordIndex`. */
export function findChunkForWord(
	chunks: TimedWord[][],
	wordIndex: number,
): { chunk: TimedWord[]; indexInChunk: number } | undefined {
	let seen = 0;
	for (const chunk of chunks) {
		if (wordIndex < seen + chunk.length) return { chunk, indexInChunk: wordIndex - seen };
		seen += chunk.length;
	}
	return undefined;
}

/** Splits narration into sentences for the no-word-timing fallback. Keeps trailing punctuation on each sentence. */
export function splitSentences(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const sentences = trimmed.match(/[^.!?]+[.!?]*/g);
	return sentences ? sentences.map((s) => s.trim()).filter(Boolean) : [trimmed];
}

/** Splits `text` into pieces of at most `budget` characters, breaking only at word boundaries (never mid-word). */
export function splitIntoBudgetChunks(text: string, budget: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const pieces: string[] = [];
	let current: string[] = [];
	for (const word of words) {
		if (current.length > 0 && textLength([...current, word]) > budget) {
			pieces.push(current.join(" "));
			current = [];
		}
		current.push(word);
	}
	if (current.length > 0) pieces.push(current.join(" "));
	return pieces.length > 0 ? pieces : [text];
}

/**
 * The caption text estimated to be spoken at `fraction` (0..1) of the
 * scene's elapsed duration, by character share, for the no-word-timing
 * fallback. Never truncates: a sentence longer than the caption's character
 * budget is split into budget-sized pieces (at word boundaries) first, and
 * the piece is picked the same way a whole short sentence would be.
 */
export function currentSentence(text: string, fraction: number): string {
	const sentences = splitSentences(text);
	if (sentences.length === 0) return "";
	const pieces = sentences.flatMap((sentence) =>
		sentence.length > CAPTION_CHAR_BUDGET ? splitIntoBudgetChunks(sentence, CAPTION_CHAR_BUDGET) : [sentence],
	);
	const totalLength = pieces.reduce((sum, p) => sum + p.length, 0);
	const targetChar = Math.min(Math.max(fraction, 0), 1) * totalLength;
	let cursor = 0;
	for (const piece of pieces) {
		cursor += piece.length;
		if (targetChar <= cursor) return piece;
	}
	return pieces[pieces.length - 1];
}
