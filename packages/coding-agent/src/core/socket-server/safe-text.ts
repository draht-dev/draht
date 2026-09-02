/**
 * safe-text — neutralize-and-bound for attacker-influenced text placed on the attach wire.
 *
 * A permission ask carries strings the model (and therefore an attacker) influenced: a shell
 * command, a file path, a URL. Four properties are load-bearing before such a string may be
 * rendered by a surface we do not control:
 *
 *  1. NEVER DELETE. Dropping a control character silently welds `rm -r` + `f /` into `rm -rf /`,
 *     so the displayed string stops matching the executed one with no evidence left behind. Every
 *     offending code point is therefore replaced by EXACTLY ONE visible marker code point.
 *  2. KEEP THE TAIL. The decision-relevant part of `curl … | sh   # AND THEN rm -rf ~/.ssh` is its
 *     end, so bounding elides the MIDDLE and preserves the tail, never the head.
 *  3. PRICE THE SPOOF. Bidi overrides cost zero display width, so a width budget cannot bound them;
 *     they are neutralized outright, and the elided grapheme count travels with the text.
 *  4. BOUND BOTH UNITS. A grapheme budget alone bounds nothing on the wire: ONE cluster admits
 *     unboundedly many combining marks, so 512 clusters of Zalgo encoded to 383,246 bytes — a frame
 *     the schema accepted and the attach bridge then refused, killing the renderer's connection with
 *     close 1008. Graphemes AND bytes are therefore bounded here, at CONSTRUCTION, whichever binds
 *     first. Downstream byte caps are backstops, not the bound.
 *
 * This module is deliberately pure and dependency-light: no I/O, no imports from socket-server
 * siblings, no @draht/* imports. It is the single place where the wire text is CONSTRUCTED safe;
 * the protocol layer only re-asserts the predicate.
 */

/** Neutralized, length-bounded text plus the evidence needed to trust the bound. */
export interface BoundedText {
	/** The neutralized (and possibly middle-elided) text. Safe to render verbatim. */
	value: string;
	/** True when `value` had to be elided to fit EITHER budget — graphemes or bytes. */
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
 * UTF-8 bytes `value` occupies. Derived from the code points rather than by encoding, so the wire
 * path never allocates a second copy of a string an attacker chose the length of.
 */
function utf8Length(value: string): number {
	let bytes = 0;
	for (const ch of value) {
		const cp = ch.codePointAt(0) as number;
		bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
	}
	return bytes;
}

/** UTF-8 bytes of the elision marker without its digits. Derived, so the two markers cannot drift. */
const MARKER_FIXED_BYTES = utf8Length(MARKER_PREFIX) + utf8Length(MARKER_SUFFIX);

/**
 * Bytes one cluster may contribute before the byte ceiling binds. Four is the widest a single code
 * point can be in UTF-8, so every ORDINARY cluster — one base code point, its canonical marks
 * already NFC-composed onto it — survives untouched, and what gets cut is a cluster carrying dozens
 * of marks, which is the attack rather than the text.
 *
 * It is an AVERAGE over the field, not a per-cluster refusal: a flag or a skin-tone emoji is eight
 * bytes in one cluster and passes unremarked inside ordinary text. A field that is nothing but such
 * clusters is elided, and the marker says by how much — which is the ordinary bounded outcome, not
 * a refusal.
 */
const MAX_BYTES_PER_GRAPHEME = 4;

/**
 * Absolute per-field byte ceiling, whatever the grapheme budget.
 *
 * 4096 ≥ 4000, the largest free-text grapheme budget on the permission wire, so no all-ASCII field
 * filled to its grapheme maximum is ever cut by bytes — the byte ceiling only ever binds on text
 * that is wide per cluster.
 *
 * THE FRAME ARITHMETIC this number is chosen for. With every field of `permission_request` at its
 * wire maximum and every one of them as wide as this ceiling allows, the worst case a field can
 * contribute to the encoded frame is `max(2 × maxGraphemes, byteCeiling(maxGraphemes))` — the left
 * term because JSON escapes `\` and `"` to two bytes each (an all-backslash ASCII field is bounded
 * by graphemes, not bytes), the right because non-ASCII is never escaped:
 *
 *   toolName(128)→512  cwd(1024)→4096  title(200)→800  message(4000)→8000  command(4000)→8000
 *   path(1024)→4096    operation(128)→512             16 × label(200)→12800
 *   = 38,816 bytes of free text
 *   + ids and instants (requestId 128, toolCallId 128, 16 option ids × 128, requestedAt 64,
 *     deadline 64 = 2,432 code units). These are plain `z.string().max(n)` on the wire, NOT
 *     `safeText`, so they accept control characters, and JSON escapes each of those to `\uXXXX`
 *     = 6 bytes. Their worst case is therefore 6 bytes per code unit, not 3: 14,592.
 *   + field names, braces, quotes and commas ≈ 700
 *   ≈ 54,108 bytes < 65,536 = `DEFAULT_TRANSPORT_LIMITS.maxFrameBytes`, with ~11 KiB of headroom.
 *
 * An earlier version of this comment costed the ids at 3 bytes and claimed ~46,812 with ~18 KiB
 * spare. That was wrong, and it was wrong in the direction that matters — a verifier built the
 * witness and measured 52,752 bytes (80.5% of the cap) using U+0001 in every id. The frame still
 * decodes, so the safety property held; the arithmetic asserting it did not. If those id fields
 * ever gain a `safeText` bound the number drops back to ~46,812.
 *
 * That is the BOUND, not a measurement: the worst witness the tests actually build — Zalgo in the
 * cluster-wide fields, backslashes in the escape-heavy ones — encodes to 35,518 bytes.
 */
const MAX_FIELD_BYTES = 4096;

/**
 * The byte ceiling that applies when a caller names only a grapheme budget — which is every caller
 * that has no reason to think about bytes, and therefore the reason this is a DEFAULT and not an
 * option: a caller who forgets it still gets a bounded string.
 */
export function defaultMaxBytes(maxGraphemes: number): number {
	return Math.min(Math.max(maxGraphemes, 0) * MAX_BYTES_PER_GRAPHEME, MAX_FIELD_BYTES);
}

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

/** How many clusters fit from one end under BOTH budgets, and what they cost in bytes. */
interface Taken {
	count: number;
	bytes: number;
}

/** The longest suffix of `graphemes` within both budgets. The tail is the decisive part: it goes first. */
function takeTail(byteLengths: readonly number[], maxGraphemes: number, maxBytes: number): Taken {
	let count = 0;
	let bytes = 0;
	for (let i = byteLengths.length - 1; i >= 0 && count < maxGraphemes; i--) {
		if (bytes + byteLengths[i] > maxBytes) break;
		bytes += byteLengths[i];
		count++;
	}
	return { count, bytes };
}

/** The longest prefix of `graphemes` within both budgets. */
function takeHead(byteLengths: readonly number[], maxGraphemes: number, maxBytes: number): Taken {
	let count = 0;
	let bytes = 0;
	for (let i = 0; i < byteLengths.length && count < maxGraphemes; i++) {
		if (bytes + byteLengths[i] > maxBytes) break;
		bytes += byteLengths[i];
		count++;
	}
	return { count, bytes };
}

/**
 * Neutralize `raw` one-for-one, then bound it to `maxGraphemes` grapheme clusters AND `maxBytes`
 * UTF-8 bytes — whichever binds first — with a MIDDLE elision that guarantees the decisive tail
 * survives.
 *
 * BOTH UNITS, because either alone is a hole. A byte budget alone would refuse legitimate text a
 * renderer can display in one line (a CJK cluster is three bytes, an astral emoji four); a grapheme
 * budget alone bounds nothing at all, because one cluster may carry unboundedly many combining
 * marks — that is the 383 KB "512-cluster" frame that got a phone disconnected with close 1008.
 * `maxBytes` defaults to {@link defaultMaxBytes}, so a caller that never thought about bytes still
 * gets a string bounded in them.
 *
 * The elision marker is `…[<k> chars elided]…`, where `k` is the number of elided graphemes — a bare
 * `…` cannot distinguish three elided characters from four thousand characters of padding. Of what
 * each budget has left after the marker, two thirds (rounded up) go to the tail and the remainder to
 * the head. When a budget is too small to hold the marker at all, the tail alone is kept.
 *
 * The marker's own width is reserved at the widest it could be — the digit count of the TOTAL, which
 * is an upper bound on the digit count of the elided count. Reserving the worst case rather than
 * solving the marker's self-reference is what keeps the result provably inside both budgets now that
 * `kept` depends on byte widths the marker cannot see; the cost is at most one unused character in
 * the rare case where the elided count has fewer digits than the total.
 */
export function boundedSafeText(
	raw: string,
	maxGraphemes: number,
	maxBytes = defaultMaxBytes(maxGraphemes),
): BoundedText {
	const neutralized = neutralize(normalizeAndRepair(raw));
	const graphemes = toGraphemes(neutralized);
	const originalLength = graphemes.length;

	if (maxGraphemes <= 0 || maxBytes <= 0) {
		return { value: "", truncated: originalLength > 0, originalLength };
	}
	if (originalLength <= maxGraphemes && utf8Length(neutralized) <= maxBytes) {
		return { value: neutralized, truncated: false, originalLength };
	}

	const byteLengths = graphemes.map(utf8Length);
	// Marker is ASCII digits plus two U+2026, so its UTF-16 length is also its grapheme length.
	const markerDigits = String(originalLength).length;
	const keepGraphemes = maxGraphemes - (MARKER_FIXED_LENGTH + markerDigits);
	const keepBytes = maxBytes - (MARKER_FIXED_BYTES + markerDigits);

	if (keepGraphemes < 1 || keepBytes < 1) {
		// Not enough budget for the marker: keep the decisive tail alone.
		const tail = takeTail(byteLengths, maxGraphemes, maxBytes);
		return { value: graphemes.slice(originalLength - tail.count).join(""), truncated: true, originalLength };
	}

	const tailGraphemes = Math.ceil((keepGraphemes * 2) / 3);
	const tail = takeTail(byteLengths, tailGraphemes, Math.ceil((keepBytes * 2) / 3));
	// The head gets its share of the clusters and every byte the tail did not spend. It can never
	// reach the tail: the two together are capped at `keepGraphemes`, and `originalLength` is larger.
	const head = takeHead(
		byteLengths,
		Math.min(keepGraphemes - tailGraphemes, originalLength - tail.count),
		keepBytes - tail.bytes,
	);
	const marker = elisionMarker(originalLength - head.count - tail.count);
	return {
		value: `${graphemes.slice(0, head.count).join("")}${marker}${graphemes.slice(originalLength - tail.count).join("")}`,
		truncated: true,
		originalLength,
	};
}
