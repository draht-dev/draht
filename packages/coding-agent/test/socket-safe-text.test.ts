import { describe, expect, it } from "vitest";
import { boundedSafeText, isNeutralized, NEUTRALIZED_FORBIDDEN_RANGES } from "../src/core/socket-server/safe-text.ts";

/**
 * Every expected string below is written out literally (with \u escapes for the invisible parts)
 * rather than recomputed from the implementation — a test that recomputes the answer cannot catch a
 * wrong answer.
 *
 * Evidence class 2: this is a pure unit. The Class-3 closure over the real wire is a later task.
 */

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function graphemeCount(value: string): number {
	return [...segmenter.segment(value)].length;
}
function codePointCount(value: string): number {
	return [...value].length;
}

/** A piped installer whose decision-relevant content is entirely in its tail. */
const PIPED_INSTALLER = "curl https://good.example.com/install.sh | sh   # AND THEN rm -rf ~/.ssh";
/** A traversal path whose decision-relevant content is its final segment. */
const TRAVERSAL_PATH = "/Users/oskar/p/src/../../../.ssh/id_ed25519";
/** RLO ... PDF around a reversed name, so a naive renderer shows `rm -rf /tmp/js.png`. */
const BIDI_SPOOF = "rm -rf /tmp/\u202Egnp.sj\u202C";
/** ANSI clear-screen + cursor-home, the classic "scroll the real command out of view" payload. */
const ANSI_CLEAR = "\u001B[2J\u001B[H";
/** Deleting the newline here would weld `rm -r` and `f /` into `rm -rf /`. */
const WELDABLE = "rm -r\nf /";
/** ZWSP, SOFT HYPHEN and BOM hidden inside an otherwise innocent command. */
const INVISIBLES = "git\u200Bpush\u00ADorigin\uFEFFmain";

describe("boundedSafeText — bounding preserves the decisive tail", () => {
	it("elides the middle of a piped installer and keeps the payload at the end", () => {
		const bounded = boundedSafeText(PIPED_INSTALLER, 48);

		expect(bounded.value).toBe("curl http…[43 chars elided]…D THEN rm -rf ~/.ssh");
		expect(bounded.value).toContain("rm -rf ~/.ssh");
		expect(bounded).toEqual({
			value: "curl http…[43 chars elided]…D THEN rm -rf ~/.ssh",
			truncated: true,
			originalLength: 72,
		});
		expect(graphemeCount(bounded.value)).toBe(48);
	});

	it("ships the elided count as a number, not a bare ellipsis", () => {
		const bounded = boundedSafeText(PIPED_INSTALLER, 48);
		const marker = bounded.value.match(/…\[(\d+) chars elided\]…/);

		expect(marker).not.toBeNull();
		expect(bounded.value).toContain("elided]");
		// head (9) + tail (20) survive, so 72 - 29 = 43 graphemes were elided.
		expect(Number(marker?.[1])).toBe(43);
		expect(Number(marker?.[1])).toBe(bounded.originalLength - (graphemeCount(bounded.value) - marker![0].length));
	});

	it("distinguishes 3 elided characters from 4000 of padding", () => {
		const padded = `${"A".repeat(4096)} | sh`;
		const bounded = boundedSafeText(padded, 64);

		expect(bounded.value).toBe(`${"A".repeat(14)}…[4058 chars elided]…${"A".repeat(24)} | sh`);
		expect(bounded.value.endsWith(" | sh")).toBe(true);
		expect(bounded.truncated).toBe(true);
		expect(bounded.originalLength).toBe(4101);
		expect(graphemeCount(bounded.value)).toBe(64);
	});

	it("leaves a path that fits untouched, tail and all", () => {
		const bounded = boundedSafeText(TRAVERSAL_PATH, 48);

		expect(bounded.value).toBe("/Users/oskar/p/src/../../../.ssh/id_ed25519");
		expect(bounded.value.endsWith("id_ed25519")).toBe(true);
		expect(bounded.truncated).toBe(false);
		expect(bounded.originalLength).toBe(43);
	});

	it("still ends with the decisive segment when the same path is over budget", () => {
		const bounded = boundedSafeText(TRAVERSAL_PATH, 36);

		expect(bounded.value).toBe("/User…[26 chars elided]…h/id_ed25519");
		expect(bounded.value.endsWith("id_ed25519")).toBe(true);
		expect(graphemeCount(bounded.value)).toBe(36);
	});

	it("degrades to the tail alone when the budget cannot hold the marker", () => {
		const bounded = boundedSafeText(`${"B".repeat(30)}TAIL`, 8);

		expect(bounded).toEqual({ value: "BBBBTAIL", truncated: true, originalLength: 34 });
	});

	it("keeps the marker plus one tail grapheme at the exact marker boundary", () => {
		const bounded = boundedSafeText(`${"B".repeat(30)}TAIL`, 20);

		expect(bounded.value).toBe("…[33 chars elided]…L");
		expect(graphemeCount(bounded.value)).toBe(20);
	});

	it("reports originalLength from the NEUTRALIZED text, not the raw text", () => {
		// U+26A0 U+FE0F is one grapheme raw; the variation selector is neutralized to its own
		// code point, so the neutralized text is two graphemes.
		const bounded = boundedSafeText("⚠\uFE0F", 200);

		expect(graphemeCount("⚠\uFE0F")).toBe(1);
		expect(bounded.value).toBe("⚠�");
		expect(bounded.originalLength).toBe(2);
		expect(bounded.truncated).toBe(false);
	});

	it("returns nothing at all for a non-positive budget, and says it truncated", () => {
		expect(boundedSafeText("abc", 0)).toEqual({ value: "", truncated: true, originalLength: 3 });
		expect(boundedSafeText("", 10)).toEqual({ value: "", truncated: false, originalLength: 0 });
	});
});

describe("boundedSafeText — neutralize, never delete", () => {
	it("replaces both bidi controls of an override spoof with U+FFFD", () => {
		const bounded = boundedSafeText(BIDI_SPOOF, 200);

		expect(bounded.value).toBe("rm -rf /tmp/�gnp.sj�");
		expect(bounded.value).not.toMatch(/[\u202A-\u202E]/);
		expect(bounded.value).not.toContain("\u202E");
		expect(bounded.value).not.toContain("\u202C");
		expect(codePointCount(bounded.value)).toBe(codePointCount(BIDI_SPOOF));
	});

	it("turns ESC into a Control Pictures glyph and keeps the bracket text visible", () => {
		const bounded = boundedSafeText(ANSI_CLEAR, 200);

		expect(bounded.value).toBe("␛[2J␛[H");
		expect(bounded.value).not.toContain("\u001B");
		expect(codePointCount(bounded.value)).toBe(codePointCount(ANSI_CLEAR));
		expect(codePointCount(bounded.value)).toBe(7);
	});

	it("does NOT weld `rm -r` and `f /` together — the newline becomes one glyph, not nothing", () => {
		const bounded = boundedSafeText(WELDABLE, 200);

		expect(bounded.value).toBe("rm -r␊f /");
		expect(bounded.value).not.toContain("rm -rf /");
		expect(bounded.value.length).toBe(WELDABLE.length);
		expect(codePointCount(bounded.value)).toBe(codePointCount(WELDABLE));
	});

	it("marks zero-width and invisible characters instead of dropping them", () => {
		const bounded = boundedSafeText(INVISIBLES, 200);

		expect(bounded.value).toBe("git�push�origin�main");
		expect(codePointCount(bounded.value)).toBe(codePointCount(INVISIBLES));
	});

	it("neutralizes one-for-one at both ends of every forbidden range", () => {
		for (const [start, end] of NEUTRALIZED_FORBIDDEN_RANGES) {
			for (const cp of [start, end]) {
				const raw = `a${String.fromCodePoint(cp)}b`;
				const bounded = boundedSafeText(raw, 200);

				expect(isNeutralized(raw), `raw U+${cp.toString(16)} should be flagged`).toBe(false);
				expect(isNeutralized(bounded.value), `U+${cp.toString(16)} should be neutralized`).toBe(true);
				expect(codePointCount(bounded.value), `U+${cp.toString(16)} must not change length`).toBe(
					codePointCount(raw),
				);
				expect(bounded.value.startsWith("a")).toBe(true);
				expect(bounded.value.endsWith("b")).toBe(true);
			}
		}
	});

	it("maps C0 to Control Pictures and everything else to U+FFFD", () => {
		expect(boundedSafeText("\u0000", 200).value).toBe("␀");
		expect(boundedSafeText("\t", 200).value).toBe("␉");
		expect(boundedSafeText("\r\n", 200).value).toBe("␍␊");
		expect(boundedSafeText("\u001F", 200).value).toBe("␟");
		expect(boundedSafeText("\u007F", 200).value).toBe("�");
		expect(boundedSafeText("\u009B", 200).value).toBe("�");
		expect(boundedSafeText("\u2066x\u2069", 200).value).toBe("�x�");
	});

	it("leaves benign text — including real emoji — alone", () => {
		expect(boundedSafeText("git push origin main", 200).value).toBe("git push origin main");
		expect(boundedSafeText("echo 'héllo wörld'", 200).value).toBe("echo 'héllo wörld'");
		expect(boundedSafeText("echo 🙈", 200).value).toBe("echo 🙈");
	});
});

describe("isNeutralized", () => {
	it("is true for every value boundedSafeText returns", () => {
		for (const raw of [PIPED_INSTALLER, TRAVERSAL_PATH, BIDI_SPOOF, ANSI_CLEAR, WELDABLE, INVISIBLES]) {
			for (const budget of [8, 20, 48, 200]) {
				expect(isNeutralized(boundedSafeText(raw, budget).value), `${JSON.stringify(raw)} @ ${budget}`).toBe(true);
			}
		}
	});

	it("is false for each hostile raw input", () => {
		expect(isNeutralized(BIDI_SPOOF)).toBe(false);
		expect(isNeutralized(ANSI_CLEAR)).toBe(false);
		expect(isNeutralized(WELDABLE)).toBe(false);
		expect(isNeutralized(INVISIBLES)).toBe(false);
	});

	it("is true for raw inputs that never carried a forbidden code point", () => {
		// PIPED_INSTALLER and TRAVERSAL_PATH are hostile in CONTENT, not in ENCODING: the predicate
		// answers "is this safe to render verbatim", which for plain ASCII is already yes.
		expect(isNeutralized(PIPED_INSTALLER)).toBe(true);
		expect(isNeutralized(TRAVERSAL_PATH)).toBe(true);
	});
});

describe("boundedSafeText is idempotent", () => {
	it("re-bounding an already bounded value is a no-op", () => {
		const inputs = [
			PIPED_INSTALLER,
			TRAVERSAL_PATH,
			BIDI_SPOOF,
			ANSI_CLEAR,
			WELDABLE,
			INVISIBLES,
			`${"A".repeat(4096)} | sh`,
			"⚠\uFE0F",
			"",
		];
		for (const raw of inputs) {
			for (const budget of [8, 20, 48, 200]) {
				const once = boundedSafeText(raw, budget).value;
				const twice = boundedSafeText(once, budget).value;
				expect(twice, `${JSON.stringify(raw)} @ ${budget}`).toBe(once);
			}
		}
	});

	it("survives a lone surrogate without composing differently on the second pass", () => {
		const lone = `e\uD83D\u0301 rm -rf /`;
		const once = boundedSafeText(lone, 200).value;

		expect(boundedSafeText(once, 200).value).toBe(once);
		expect(isNeutralized(once)).toBe(true);
	});
});

/**
 * The 1008 witness (H5). A grapheme bound ALONE cannot keep a frame small: one cluster admits
 * unboundedly many combining marks, so 512 clusters encoded to 383,246 bytes — a frame
 * `decodeServerFrame` accepted and `AttachBridge.#fit` then refused, dropping the renderer.
 *
 * Marks are chosen from U+0334..U+033F: all combining, none of which forms a canonical composite
 * with the base `x`, so NFC cannot quietly collapse the witness into something smaller.
 */
const ZALGO_MARKS_PER_CLUSTER = 200;
const ZALGO_CLUSTER = `x${Array.from({ length: ZALGO_MARKS_PER_CLUSTER }, (_, i) => String.fromCodePoint(0x0334 + (i % 12))).join("")}`;
/** The decisive tail: what a human is actually deciding about, at the end where bounding keeps it. */
const ZALGO_TAIL = "| sh # rm -rf ~/.ssh";
const ZALGO = `${ZALGO_CLUSTER.repeat(512)}${ZALGO_TAIL}`;

/** JSON escapes `\\` to two bytes, so an all-backslash field is the other worst case: ASCII, but doubled. */
const BACKSLASHES = "\\".repeat(8192);

const utf8 = new TextEncoder();
function utf8Bytes(value: string): number {
	return utf8.encode(value).length;
}

/**
 * The wire's per-field grapheme budgets, hand-mirrored from `PermissionRequestFrameSchema` in
 * `packages/geist-protocol/src/wire.ts` — this package does not depend on that one, exactly as
 * that package does not depend on this one.
 */
const WIRE_FIELD_GRAPHEMES = {
	toolName: 128,
	cwd: 1024,
	title: 200,
	message: 4000,
	command: 4000,
	path: 1024,
	operation: 128,
	optionLabel: 200,
} as const;
const WIRE_MAX_OPTIONS = 16;
/** `DEFAULT_TRANSPORT_LIMITS.maxFrameBytes`, and the cap `AttachBridge.#fit` refuses a permission frame past. */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * A `permission_request` with every free-text field filled at its wire budget from whatever
 * `rawFor` hands back for that budget — so a test can put the worst raw text for EACH field in it,
 * which is the real worst case: bytes bind on wide clusters, JSON escaping binds on ASCII.
 */
function buildPermissionFrame(rawFor: (budget: number) => string): Record<string, unknown> {
	const field = (budget: number) => boundedSafeText(rawFor(budget), budget).value;
	return {
		type: "permission_request",
		requestId: "R".repeat(128),
		method: "select",
		toolCallId: "T".repeat(128),
		toolName: field(WIRE_FIELD_GRAPHEMES.toolName),
		cwd: field(WIRE_FIELD_GRAPHEMES.cwd),
		title: field(WIRE_FIELD_GRAPHEMES.title),
		message: field(WIRE_FIELD_GRAPHEMES.message),
		command: field(WIRE_FIELD_GRAPHEMES.command),
		path: field(WIRE_FIELD_GRAPHEMES.path),
		operation: field(WIRE_FIELD_GRAPHEMES.operation),
		truncated: true,
		options: Array.from({ length: WIRE_MAX_OPTIONS }, (_, i) => ({
			id: `${i}`.padEnd(128, "o"),
			label: field(WIRE_FIELD_GRAPHEMES.optionLabel),
		})),
		requestedAt: "2026-08-21T00:00:00.000Z".padEnd(64, "Z"),
		deadline: "2026-08-21T00:01:00.000Z".padEnd(64, "Z"),
	};
}

describe("boundedSafeText — the byte ceiling (the 1008 witness)", () => {
	it("bounds the Zalgo witness by BYTES as well as graphemes", () => {
		const bounded = boundedSafeText(ZALGO, 512);

		expect(graphemeCount(bounded.value)).toBeLessThanOrEqual(512);
		// 512 graphemes × 4 bytes — the widest a single code point is in UTF-8.
		expect(utf8Bytes(bounded.value)).toBeLessThanOrEqual(2048);
		expect(bounded.truncated).toBe(true);
	});

	it("keeps the decisive tail and the elision marker inside that byte budget", () => {
		const bounded = boundedSafeText(ZALGO, 512);

		expect(bounded.value.endsWith("rm -rf ~/.ssh")).toBe(true);
		const marker = bounded.value.match(/…\[(\d+) chars elided\]…/);
		expect(marker).not.toBeNull();
		expect(Number(marker?.[1])).toBeGreaterThan(0);
		expect(isNeutralized(bounded.value)).toBe(true);
	});

	it("encodes a whole permission_request under 64 KiB with every field at its wire maximum", () => {
		const encoded = JSON.stringify(buildPermissionFrame(() => ZALGO));

		expect(utf8Bytes(encoded)).toBeLessThan(MAX_FRAME_BYTES);
	});

	it("encodes a whole permission_request under 64 KiB when every field is escape-heavy ASCII", () => {
		// JSON escapes `\` and `"` to two bytes each, so an all-backslash field encodes to twice its
		// grapheme count. That is the other worst case, and it must fit too.
		const encoded = JSON.stringify(buildPermissionFrame(() => BACKSLASHES));

		expect(utf8Bytes(encoded)).toBeLessThan(MAX_FRAME_BYTES);
	});

	it("encodes a whole permission_request under 64 KiB when each field carries its OWN worst case", () => {
		// The binding case: the byte ceiling caps the wide fields, the grapheme budget caps the
		// escape-heavy ones, and the frame is the sum of both worsts, not of either alone.
		const encoded = JSON.stringify(buildPermissionFrame((budget) => (budget >= 4000 ? BACKSLASHES : ZALGO)));

		expect(utf8Bytes(encoded)).toBeLessThan(MAX_FRAME_BYTES);
	});

	it("does NOT cut a legitimate ASCII field that fills its grapheme budget", () => {
		const legitimate = `${"a".repeat(3984)} | sh # rm -rf ~`;

		expect(graphemeCount(legitimate)).toBe(4000);
		expect(boundedSafeText(legitimate, 4000)).toEqual({
			value: legitimate,
			truncated: false,
			originalLength: 4000,
		});
	});

	it("takes an explicit byte ceiling and honours it before the grapheme budget", () => {
		const bounded = boundedSafeText(`${"é".repeat(200)} | sh`, 200, 64);

		expect(utf8Bytes(bounded.value)).toBeLessThanOrEqual(64);
		expect(bounded.value.endsWith(" | sh")).toBe(true);
		expect(bounded.truncated).toBe(true);
		expect(bounded.originalLength).toBe(205);
	});

	it("degrades to the tail alone when the byte ceiling cannot hold the marker", () => {
		// The marker costs 21 bytes before its digits; 12 bytes cannot hold it.
		const bounded = boundedSafeText(`${"é".repeat(40)}TAIL`, 200, 12);

		expect(utf8Bytes(bounded.value)).toBeLessThanOrEqual(12);
		expect(bounded.value.endsWith("TAIL")).toBe(true);
		expect(bounded.truncated).toBe(true);
	});

	it("stays idempotent under the byte ceiling", () => {
		for (const budget of [8, 48, 512]) {
			const once = boundedSafeText(ZALGO, budget).value;
			expect(boundedSafeText(once, budget).value, `zalgo @ ${budget}`).toBe(once);
		}
	});
});
