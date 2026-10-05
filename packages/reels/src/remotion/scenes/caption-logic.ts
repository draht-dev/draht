/**
 * Pure caption logic for {@link Caption.tsx}: chunking words into on-screen
 * phrases and picking which chunk/sentence is current. Kept out of the React
 * component so it can be unit tested without Remotion or a DOM.
 */

import type { TimedWord } from "../../contract.ts";
import { CAPTION_FONT_SIZE, CAPTION_MAX_LINES, CAPTION_PADDING_X, SAFE_ZONE_WIDTH } from "../props.ts";

/**
 * A chunk's word count ceiling. No longer the primary limit — the line-fit
 * simulation below does the real work — but a backstop against a chunk of
 * many short words (e.g. "a a a a a a a a a a a a a a a a") still reading as
 * one giant block.
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
/** Characters that fit one caption line at {@link AVG_CHAR_WIDTH_EM}'s estimated glyph width. */
export const CHARS_PER_LINE = Math.floor(CAPTION_CONTENT_WIDTH / (CAPTION_FONT_SIZE * AVG_CHAR_WIDTH_EM));
/**
 * Max characters (including inter-word spaces) a piece may contain and still
 * fit {@link CAPTION_MAX_LINES} lines, as a flat character sum. Used only by
 * the no-word-timing fallback ({@link currentSentence}), which has no word
 * boundaries to simulate a real wrap against. The word-timed path
 * ({@link chunkWords}) uses {@link simulateLineCount} instead — a character
 * sum can't tell a chunk that wraps efficiently from one wasted by a single
 * long unbreakable token (a path, URL, or identifier), which is exactly the
 * case it used to get wrong: the sum fit, but the real layout needed 3 lines.
 */
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

/**
 * Splits `word` at its preferred break points: right after a `/`, `.`, `-`,
 * or `_`, and right before a camelCase capital. Mirrors the `<wbr/>`
 * placement in {@link Caption.tsx}, so the browser only ever breaks a token
 * where this function already decided it could.
 */
export function wordBreakSegments(word: string): string[] {
	const breaks: number[] = [];
	for (let i = 1; i < word.length; i++) {
		const prev = word[i - 1];
		const cur = word[i];
		if (prev === "/" || prev === "." || prev === "-" || prev === "_") breaks.push(i);
		else if (/[a-z0-9]/.test(prev) && /[A-Z]/.test(cur)) breaks.push(i);
	}
	if (breaks.length === 0) return [word];
	const segments: string[] = [];
	let start = 0;
	for (const pos of breaks) {
		segments.push(word.slice(start, pos));
		start = pos;
	}
	segments.push(word.slice(start));
	return segments;
}

/**
 * `word` split into the pieces a greedy line-wrap would actually place: its
 * break-point segments, hard-chunked further if a segment is itself still
 * wider than one line (no break point gave the browser anywhere to go).
 */
function wrapAtoms(word: string, charsPerLine: number): string[] {
	if (word.length <= charsPerLine) return [word];
	const atoms: string[] = [];
	for (const segment of wordBreakSegments(word)) {
		if (segment.length <= charsPerLine) {
			atoms.push(segment);
			continue;
		}
		for (let i = 0; i < segment.length; i += charsPerLine) atoms.push(segment.slice(i, i + charsPerLine));
	}
	return atoms;
}

/**
 * Simulates greedy word-wrap layout (the same algorithm a browser uses for
 * `white-space: normal`) and returns how many lines `words` needs at
 * `charsPerLine`. Words wrap whole; a word wider than one line is broken at
 * its {@link wordBreakSegments} points, each piece continuing immediately
 * (no inter-word space) on whatever line has room, exactly like a `<wbr/>`.
 */
export function simulateLineCount(words: readonly string[], charsPerLine: number): number {
	let lines = 1;
	let col = 0;
	for (const word of words) {
		const atoms = wrapAtoms(word, charsPerLine);
		for (let i = 0; i < atoms.length; i++) {
			const atom = atoms[i];
			const spaceLen = i === 0 && col > 0 ? 1 : 0;
			if (col + spaceLen + atom.length <= charsPerLine) {
				col += spaceLen + atom.length;
			} else if (col === 0) {
				// Atom alone is wider than a full line even at line start (e.g. a
				// break-point-free token); place it anyway rather than loop forever.
				col = atom.length;
			} else {
				lines += 1;
				col = atom.length;
			}
		}
	}
	return lines;
}

/** Whether `words`, laid out as a caption, fits {@link CAPTION_MAX_LINES} lines. */
function fitsCaption(words: readonly string[]): boolean {
	return simulateLineCount(words, CHARS_PER_LINE) <= CAPTION_MAX_LINES;
}

/** Number of lines `word` alone needs, with its own break points, at the caption's width. */
export function wordLineCount(word: string): number {
	return simulateLineCount([word], CHARS_PER_LINE);
}

/**
 * Groups `word`'s break-point segments into pages that each fit
 * {@link CAPTION_MAX_LINES} lines on their own, for a single token so long
 * it alone needs more lines than the caption has. Used to page through such
 * a token over its own spoken duration instead of clamping it. Returns
 * `[word]` unchanged when it has no break points (nothing to split on) or
 * already fits.
 */
export function splitWordIntoPages(word: string): string[] {
	if (wordLineCount(word) <= CAPTION_MAX_LINES) return [word];
	const segments = wordBreakSegments(word);
	if (segments.length <= 1) return [word];

	const pages: string[] = [];
	let current = "";
	for (const segment of segments) {
		const candidate = current + segment;
		if (current.length > 0 && simulateLineCount([candidate], CHARS_PER_LINE) > CAPTION_MAX_LINES) {
			pages.push(current);
			current = segment;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) pages.push(current);
	return pages.length > 0 ? pages : [word];
}

function rangeFits(words: readonly TimedWord[], from: number, to: number): boolean {
	return fitsCaption(words.slice(from, to + 1).map((w) => w.text));
}

/**
 * Picks the best index `i` to split `words` into `words[0..i]` and
 * `words[i+1..]` (both non-empty). Prefers, in order: a split where both
 * sides fit {@link CAPTION_MAX_LINES} lines; among those, one that lands on
 * a clause boundary (comma/semicolon/colon); among those, one that doesn't
 * leave an orphan side under {@link MIN_CHUNK_WORDS} or end the first side
 * on a function word; and ties break toward the most balanced (closest to
 * the middle) split.
 */
function pickSplitIndex(words: readonly TimedWord[]): number {
	const n = words.length;
	const inFit: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		if (rangeFits(words, 0, i) && rangeFits(words, i + 1, n - 1)) inFit.push(i);
	}
	const candidates = inFit.length > 0 ? inFit : [Math.max(0, Math.floor(n / 2) - 1)];

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
 * already fits {@link CAPTION_MAX_LINES} lines (simulated) and
 * {@link MAX_CHUNK_WORDS} — the common case — otherwise recursively bisected
 * via {@link pickSplitIndex} until every piece fits. A lone word is always
 * its own chunk regardless of fit: it can't be split further without
 * changing word count (see {@link splitWordIntoPages} for how `Caption.tsx`
 * pages through one that's still too long on its own).
 */
function splitSentenceIntoChunks(words: readonly TimedWord[]): TimedWord[][] {
	if (words.length === 0) return [];
	if (words.length === 1) return [[...words]];
	if (fitsCaption(words.map((w) => w.text)) && words.length <= MAX_CHUNK_WORDS) return [[...words]];

	const splitAt = pickSplitIndex(words);
	const left = words.slice(0, splitAt + 1);
	const right = words.slice(splitAt + 1);
	return [...splitSentenceIntoChunks(left), ...splitSentenceIntoChunks(right)];
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
	return groupIntoSentences(words).flatMap((sentence) => splitSentenceIntoChunks(sentence));
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
