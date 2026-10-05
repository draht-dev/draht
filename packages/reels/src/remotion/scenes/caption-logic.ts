/**
 * Pure caption logic for {@link Caption.tsx}: chunking words into on-screen
 * phrases and picking which chunk/sentence is current. Kept out of the React
 * component so it can be unit tested without Remotion or a DOM.
 */

import type { TimedWord } from "../../contract.ts";
import { CAPTION_FONT_SIZE, CAPTION_MAX_LINES, CAPTION_PADDING_X, SAFE_ZONE_WIDTH } from "../props.ts";

/**
 * A chunk's word count ceiling. No longer the primary limit — the character
 * budget below does the real work — but a backstop against a chunk of many
 * short words (e.g. "a a a a a a a a a a a a a a a a") still reading as one
 * giant block.
 */
const MAX_CHUNK_WORDS = 16;
/** Below this many words, a chunk reads as an orphaned fragment; avoided when another split is available. */
const MIN_CHUNK_WORDS = 3;
/** A sentence end, optionally followed by a closing quote/paren/bracket (e.g. `done."` or `really?)`), or a narration ellipsis used the same way in drafted scripts (`…`). */
const SENTENCE_END_PATTERN = /[.!?…]+['")\]]*$/;
const CLAUSE_END_PATTERN = /[,;:]$/;
const FUNCTION_WORD_PATTERN = /^(the|a|an|to|of|in|and|or|but|for|with|at|by|from|on|as)$/i;

/**
 * Average glyph advance for Instrument Sans (the caption font) at its
 * default weight, as a fraction of font size — measured with `fontkitten`
 * against `public/fonts/instrument-sans-latin.woff2`, averaged over every
 * character (letters and spaces) in ~1,100 words of real drafted narration
 * (`/tmp/reels-accept2/drafts/draht-mono/*The/entry.json` transcripts):
 * 0.459em. Rounded up to 0.5em as a small safety margin so the budget
 * undershoots rather than overflows the box.
 */
const AVG_CHAR_WIDTH_EM = 0.5;

const CAPTION_CONTENT_WIDTH = SAFE_ZONE_WIDTH - CAPTION_PADDING_X * 2;
const CHARS_PER_LINE = Math.floor(CAPTION_CONTENT_WIDTH / (CAPTION_FONT_SIZE * AVG_CHAR_WIDTH_EM));
/** Max characters (including inter-word spaces) a chunk/piece may contain and still fit {@link CAPTION_MAX_LINES} lines at the caption's font size and width. */
export const CAPTION_CHAR_BUDGET = CHARS_PER_LINE * CAPTION_MAX_LINES;

function textLength(words: readonly string[]): number {
	return words.reduce((sum, w, i) => sum + w.length + (i > 0 ? 1 : 0), 0);
}

function bareWord(word: string): string {
	return word.replace(/^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$/g, "");
}

function endsOnFunctionWord(words: readonly TimedWord[]): boolean {
	const last = words[words.length - 1];
	return last !== undefined && FUNCTION_WORD_PATTERN.test(bareWord(last.text));
}

function rangeLength(words: readonly TimedWord[], from: number, to: number): number {
	return textLength(words.slice(from, to + 1).map((w) => w.text));
}

/**
 * Picks the best index `i` to split `words` into `words[0..i]` and
 * `words[i+1..]` (both non-empty). Prefers, in order: a split where both
 * sides fit the character budget; among those, one that lands on a clause
 * boundary (comma/semicolon/colon); among those, one that doesn't leave an
 * orphan side under {@link MIN_CHUNK_WORDS} or end the first side on a
 * function word; and ties break toward the most balanced (closest to the
 * middle) split.
 */
function pickSplitIndex(words: readonly TimedWord[], budget: number): number {
	const n = words.length;
	const inBudget: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		if (rangeLength(words, 0, i) <= budget && rangeLength(words, i + 1, n - 1) <= budget) inBudget.push(i);
	}
	const candidates = inBudget.length > 0 ? inBudget : [Math.max(0, Math.floor(n / 2) - 1)];

	const mid = (n - 1) / 2;
	const score = (i: number): number => {
		let s = 0;
		if (CLAUSE_END_PATTERN.test(words[i].text)) s += 100;
		if (i + 1 < MIN_CHUNK_WORDS || n - 1 - i < MIN_CHUNK_WORDS) s -= 50;
		if (endsOnFunctionWord(words.slice(0, i + 1))) s -= 20;
		s -= Math.abs(i - mid) * 0.1;
		return s;
	};
	return candidates.reduce((best, i) => (score(i) > score(best) ? i : best), candidates[0]);
}

/**
 * Splits one sentence's words into caption chunks: kept whole when it
 * already fits {@link CAPTION_CHAR_BUDGET} and {@link MAX_CHUNK_WORDS} — the
 * common case, and the fix for captions that used to be cut after about one
 * line regardless of how much room the box actually had — otherwise
 * recursively bisected via {@link pickSplitIndex} until every piece fits.
 */
function splitSentenceIntoChunks(words: readonly TimedWord[], budget: number): TimedWord[][] {
	if (words.length === 0) return [];
	if (words.length === 1) return [[...words]];
	if (textLength(words.map((w) => w.text)) <= budget && words.length <= MAX_CHUNK_WORDS) return [[...words]];

	const splitAt = pickSplitIndex(words, budget);
	const left = words.slice(0, splitAt + 1);
	const right = words.slice(splitAt + 1);
	return [...splitSentenceIntoChunks(left, budget), ...splitSentenceIntoChunks(right, budget)];
}

function groupIntoSentences(words: TimedWord[]): TimedWord[][] {
	const sentences: TimedWord[][] = [];
	let current: TimedWord[] = [];
	for (const word of words) {
		current.push(word);
		if (SENTENCE_END_PATTERN.test(word.text)) {
			sentences.push(current);
			current = [];
		}
	}
	if (current.length > 0) sentences.push(current);
	return sentences;
}

/**
 * Breaks `words` into on-screen caption chunks. A chunk never runs a
 * sentence boundary through its middle — sentences are grouped first, and
 * each is split on its own — and a sentence that fits the caption's two
 * lines as-is is shown whole instead of being pre-emptively cut.
 */
export function chunkWords(words: TimedWord[]): TimedWord[][] {
	return groupIntoSentences(words).flatMap((sentence) => splitSentenceIntoChunks(sentence, CAPTION_CHAR_BUDGET));
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
