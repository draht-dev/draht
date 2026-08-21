/**
 * safe-text — neutralize-and-bound for attacker-influenced text placed on the attach wire.
 *
 * A permission ask carries strings the model (and therefore an attacker) influenced: a shell
 * command, a file path, a URL. Three properties are load-bearing before such a string may be
 * rendered by a surface we do not control:
 *
 *  1. NEVER DELETE. Dropping a control character silently welds `rm -r` + `f /` into `rm -rf /`,
 *     so the displayed string stops matching the executed one with no evidence left behind. Every
 *     offending code point is therefore replaced by EXACTLY ONE visible marker code point.
 *  2. KEEP THE TAIL. The decision-relevant part of `curl … | sh   # AND THEN rm -rf ~/.ssh` is its
 *     end, so bounding elides the MIDDLE and preserves the tail, never the head.
 *  3. PRICE THE SPOOF. Bidi overrides cost zero display width, so a width budget cannot bound them;
 *     they are neutralized outright, and the elided grapheme count travels with the text.
 *
 * This module is deliberately pure and dependency-light: no I/O, no imports from socket-server
 * siblings, no @draht/* imports. It is the single place where the wire text is CONSTRUCTED safe;
 * the protocol layer only re-asserts the predicate.
 */

/** Neutralized, length-bounded text plus the evidence needed to trust the bound. */
export interface BoundedText {
	/** The neutralized (and possibly middle-elided) text. Safe to render verbatim. */
	value: string;
	/** True when `value` had to be elided to fit the grapheme budget. */
	truncated: boolean;
	/** Grapheme count of the NEUTRALIZED text — never of the raw input. */
	originalLength: number;
}

/**
 * Inclusive code point ranges that are replaced one-for-one by a visible marker.
 *
 * C0 (the first range) becomes its Control Pictures glyph, `U+2400 + cp`; every other range becomes
 * U+FFFD. Nothing here is ever deleted, so the neutralized string has the same code point count as
 * its input.
 *
 * A LATER TASK HAND-MIRRORS THIS TABLE inside `packages/geist-protocol` as a zod `.refine()`
 * predicate — that package must keep zero @draht dependencies, so it cannot import this constant.
 * Any edit here has to be repeated there by hand, and the two must stay byte-for-byte equivalent.
 *
 * Sorted ascending by range start; `isForbiddenCodePoint` relies on that for its early exit.
 */
export const NEUTRALIZED_FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
	[0x0000, 0x001f], // C0 controls, including TAB, LF, CR and ESC
	[0x007f, 0x007f], // DEL
	[0x0080, 0x009f], // C1 controls, including CSI (U+009B)
	[0x00ad, 0x00ad], // SOFT HYPHEN
	[0x061c, 0x061c], // ARABIC LETTER MARK
	[0x200b, 0x200d], // ZWSP, ZWNJ, ZWJ
	[0x200e, 0x200f], // LRM, RLM
	[0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
	[0x2060, 0x2060], // WORD JOINER
	[0x2066, 0x2069], // LRI, RLI, FSI, PDI
	[0xfe00, 0xfe0f], // variation selectors VS1..VS16
	[0xfeff, 0xfeff], // ZWNBSP / BOM
	[0xfff9, 0xfffb], // interlinear annotation anchor/separator/terminator
	[0xe0000, 0xe007f], // tag characters
];

/** Last C0 code point. C0 is the one range that gets a Control Pictures glyph instead of U+FFFD. */
const C0_LAST = 0x001f;
/** Base of the Control Pictures block: `U+2400 + cp` is the visible glyph for C0 code point `cp`. */
const CONTROL_PICTURES_BASE = 0x2400;
/** The one-for-one marker for every non-C0 forbidden code point. */
const REPLACEMENT_CHARACTER = "�";

const MARKER_PREFIX = "…[";
const MARKER_SUFFIX = " chars elided]…";
/** Grapheme length of the elision marker without its digits. */
const MARKER_FIXED_LENGTH = MARKER_PREFIX.length + MARKER_SUFFIX.length;

/**
 * Same primitive as `getGraphemeSegmenter()` (packages/tui/src/utils.ts:10), deliberately NOT
 * imported from @draht/tui so this module stays dependency-light.
 */
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Unpaired surrogates: a high surrogate with no low surrogate after it, or a low surrogate with no
 * high surrogate before it. Replicated from `sanitizeSurrogates` in
 * packages/ai/src/utils/sanitize-unicode.ts:21 — that helper is not re-exported from the @draht/ai
 * entry point, and importing it would pull a heavy package into the wire path.
 */
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function isForbiddenCodePoint(cp: number): boolean {
	for (const [start, end] of NEUTRALIZED_FORBIDDEN_RANGES) {
		if (cp < start) return false; // ranges are sorted ascending
		if (cp <= end) return true;
	}
	return false;
}

/**
 * True when `value` carries no code point from {@link NEUTRALIZED_FORBIDDEN_RANGES} — i.e. when it
 * is safe to hand to a renderer verbatim. Every `BoundedText.value` satisfies this.
 */
export function isNeutralized(value: string): boolean {
	for (const ch of value) {
		if (isForbiddenCodePoint(ch.codePointAt(0) as number)) return false;
	}
	return true;
}

/** Step 1: NFC, then repair unpaired surrogates. */
function normalizeAndRepair(raw: string): string {
	const composed = raw.normalize("NFC");
	const repaired = composed.replace(UNPAIRED_SURROGATE_PATTERN, "");
	// Re-compose only when the repair actually dropped something: removing a lone surrogate can leave
	// a base character adjacent to a combining mark, and without this second pass a second call to
	// boundedSafeText would compose them and yield a different string, breaking idempotence.
	return repaired === composed ? composed : repaired.normalize("NFC");
}

/** Step 2: replace each offending code point with EXACTLY ONE visible marker code point. */
function neutralize(text: string): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) as number;
		if (cp <= C0_LAST) {
			out += String.fromCodePoint(CONTROL_PICTURES_BASE + cp);
		} else if (isForbiddenCodePoint(cp)) {
			out += REPLACEMENT_CHARACTER;
		} else {
			out += ch;
		}
	}
	return out;
}

function toGraphemes(text: string): string[] {
	const out: string[] = [];
	for (const { segment } of graphemeSegmenter.segment(text)) out.push(segment);
	return out;
}

function elisionMarker(elided: number): string {
	return `${MARKER_PREFIX}${elided}${MARKER_SUFFIX}`;
}

/**
 * The elided count is self-referential: it is `total - kept`, `kept` is `maxGraphemes` minus the
 * marker length, and the marker length grows with the digit count of the elided count itself.
 * Iterate to the fixed point — it converges in at most a couple of rounds because adding a digit
 * only ever raises the count by one.
 */
function resolveElidedCount(total: number, maxGraphemes: number): number {
	let digits = 1;
	let candidate = total;
	for (let round = 0; round < 8; round++) {
		const keep = maxGraphemes - (MARKER_FIXED_LENGTH + digits);
		candidate = total - Math.max(keep, 0);
		const candidateDigits = String(candidate).length;
		if (candidateDigits === digits) return candidate;
		digits = candidateDigits;
	}
	return candidate;
}

/**
 * Neutralize `raw` one-for-one, then bound it to `maxGraphemes` grapheme clusters with a MIDDLE
 * elision that guarantees the decisive tail survives.
 *
 * The elision marker is `…[<k> chars elided]…`, where `k` is the number of elided graphemes — a bare
 * `…` cannot distinguish three elided characters from four thousand characters of padding. Of the
 * budget left after the marker, two thirds (rounded up) go to the tail and the remainder to the
 * head. When `maxGraphemes` is too small to hold the marker at all, the tail alone is kept.
 */
export function boundedSafeText(raw: string, maxGraphemes: number): BoundedText {
	const neutralized = neutralize(normalizeAndRepair(raw));
	const graphemes = toGraphemes(neutralized);
	const originalLength = graphemes.length;

	if (maxGraphemes <= 0) {
		return { value: "", truncated: originalLength > 0, originalLength };
	}
	if (originalLength <= maxGraphemes) {
		return { value: neutralized, truncated: false, originalLength };
	}

	// Marker is ASCII digits plus two U+2026, so its UTF-16 length is also its grapheme length.
	const marker = elisionMarker(resolveElidedCount(originalLength, maxGraphemes));
	const keep = maxGraphemes - marker.length;
	if (keep < 1) {
		// Not enough budget for the marker: keep the decisive tail alone.
		return { value: graphemes.slice(originalLength - maxGraphemes).join(""), truncated: true, originalLength };
	}

	const tailLength = Math.ceil((keep * 2) / 3);
	const headLength = keep - tailLength;
	const head = graphemes.slice(0, headLength).join("");
	const tail = graphemes.slice(originalLength - tailLength).join("");
	return { value: `${head}${marker}${tail}`, truncated: true, originalLength };
}
