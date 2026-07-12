// S-NIAH (Synthetic Needle-In-A-Haystack) regression suite.
//
// See .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
// section 2. For this test's math we treat the mocked root model as if it had
// a 100,000-token / 400,000-character context window (a ~4 chars/token
// heuristic -- not measured against any real tokenizer, just a round number
// to derive "10x"/"100x" from). The two cases below plant one needle in
// filler content that is:
//   - 10x that window:  ~4,000,000 characters
//   - 100x that window: ~40,000,000 characters
//
// `rootLlm` here is a **scripted mock**, not a real model call. It runs a
// fixed, deterministic 3-turn plan regardless of `context`'s actual length --
// exactly mirroring a plausible real RLM strategy while keeping the turn
// count constant (not scaling with content size, per the plan's explicit
// "keep the mock's turn count small and deterministic" requirement):
//   1. peek at `len(context)` (root LLM can't otherwise know how big the
//      haystack is without asking the REPL).
//   2. chunk-scan: split `context` into MOCKED_WINDOW_CHARS-sized windows and
//      find which window contains the needle marker. The scan over however
//      many windows exist happens inside ONE Python `while` loop (a single
//      exec/turn) using `str.find` with `start`/`end` bounds -- this is what
//      keeps turn count flat at 100x while still genuinely "chunking" the
//      content via Python string operations, rather than the root LLM
//      inspecting one chunk per turn (which *would* scale turn count with
//      content size, exactly what we're told to avoid).
//   3. slice just the located chunk, extract the needle's value with a
//      regex, and call FINAL(...) with it.
//
// Building the multi-megabyte filler itself uses a single short string
// repeated via `String.prototype.repeat` (cheap, no per-character work) --
// see the plan's "Risks" section on not making fixture generation slow.

import { afterEach, describe, expect, test } from "vitest";
import type { RlmHistoryEntry } from "../src/index.js";
import { RlmSession } from "../src/index.js";

/** Assumed mocked root model context window, in characters (see file header). */
const MOCKED_WINDOW_CHARS = 400_000;

const NEEDLE_PREFIX = "<<NIAH-NEEDLE:";
const NEEDLE_SUFFIX = ">>";

/**
 * Builds a haystack of exactly `totalChars` characters with one needle
 * planted dead-center inside a deliberately non-trivial chunk (not chunk 0,
 * not the last chunk -- proves the chunk-scan is doing real work, not just
 * trivially finding something at the very start) relative to `chunkChars`.
 *
 * The needle is centered within its chunk (never within `chunkChars/2` of a
 * chunk boundary given how small the needle is relative to `chunkChars`), so
 * there's no risk of it straddling two chunks and being missed/truncated by
 * the mock's per-chunk `find`/slice-then-regex logic.
 */
function buildHaystack(
	totalChars: number,
	needleValue: string,
	chunkChars: number,
): { context: string; expectedChunk: number } {
	const needle = `${NEEDLE_PREFIX}${needleValue}${NEEDLE_SUFFIX}`;
	const numChunks = Math.ceil(totalChars / chunkChars);
	const expectedChunk = Math.floor(numChunks / 2);
	const needleOffset = expectedChunk * chunkChars + Math.floor(chunkChars / 2);

	const fillerUnit = "the quick brown fox jumps over the lazy dog. ";
	const before = fillerUnit.repeat(Math.ceil(needleOffset / fillerUnit.length)).slice(0, needleOffset);
	const afterLength = totalChars - needleOffset - needle.length;
	const after = fillerUnit.repeat(Math.ceil(afterLength / fillerUnit.length)).slice(0, afterLength);

	const context = before + needle + after;
	return { context, expectedChunk };
}

/**
 * The scripted 3-turn mock `rootLlm` described in the file header. Uses
 * `history.length` (not any actual "understanding" of context) to decide
 * which fixed turn it's on -- deterministic regardless of scale.
 */
function scriptedNiahRootLlm(chunkChars: number): (history: RlmHistoryEntry[]) => Promise<string> {
	return async (history: RlmHistoryEntry[]) => {
		const turn = history.length;

		if (turn === 0) {
			return ["```python", "print(len(context))", "```"].join("\n");
		}

		if (turn === 1) {
			return [
				"```python",
				`CHUNK = ${chunkChars}`,
				"n = len(context)",
				"found_chunk = -1",
				"i = 0",
				"while i * CHUNK < n:",
				"    start = i * CHUNK",
				"    end = min(start + CHUNK, n)",
				`    if context.find(${JSON.stringify(NEEDLE_PREFIX)}, start, end) != -1:`,
				"        found_chunk = i",
				"        break",
				"    i += 1",
				"print(found_chunk)",
				"```",
			].join("\n");
		}

		// turn === 2: parse the chunk index the previous turn printed, slice
		// just that chunk, and extract + FINAL from it.
		const prevStdout = history[1]?.truncatedStdout ?? "";
		const foundChunk = Number.parseInt(prevStdout.trim(), 10);
		return [
			"```python",
			`CHUNK = ${chunkChars}`,
			`chunk = context[${foundChunk} * CHUNK : (${foundChunk} + 1) * CHUNK]`,
			"import re",
			`match = re.search(r'${NEEDLE_PREFIX}(.*?)${NEEDLE_SUFFIX}', chunk)`,
			"FINAL(match.group(1))",
			"```",
		].join("\n");
	};
}

describe("S-NIAH regression suite (Phase 30, Architecture section 2)", () => {
	let session: RlmSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	test("10x scale: recovers the needle from ~4,000,000 characters of filler in 3 deterministic turns", async () => {
		const totalChars = 4_000_000; // 10x MOCKED_WINDOW_CHARS
		const needleValue = "s-niah-10x-answer-7a1c";
		const { context, expectedChunk } = buildHaystack(totalChars, needleValue, MOCKED_WINDOW_CHARS);
		expect(context).toHaveLength(totalChars);

		const start = Date.now();
		session = new RlmSession({
			prompt: context,
			rootLlm: scriptedNiahRootLlm(MOCKED_WINDOW_CHARS),
			// Generous headroom over the 256MB production default: the driver
			// transiently holds both the raw JSON wire message and the decoded
			// Python string for a multi-megabyte `context` payload at once
			// during message parsing -- see this file's module docstring risk
			// note. Not a claim that RLM sessions need this much memory in
			// general, just that this synthetic worst-case seed shouldn't be
			// mistaken for a runaway allocation.
			maxRssBytes: 512 * 1024 * 1024,
		});
		const result = await session.run();
		const elapsedMs = Date.now() - start;

		expect(result.kind).toBe("final");
		expect(result.value).toBe(needleValue);
		// Exactly the mock's fixed 3-turn plan -- proves turn count didn't
		// balloon with content size.
		expect(result.steps).toBe(3);
		expect(result.history[1].truncatedStdout.trim()).toBe(String(expectedChunk));

		// Test-infrastructure speed, not real-RLM speed: the mock's 3 turns
		// each do O(context length) work at worst, which should complete in
		// well under this bound on any reasonable dev/CI machine.
		expect(elapsedMs).toBeLessThan(15_000);
	}, 20_000);

	test("100x scale: recovers the needle from ~40,000,000 characters of filler in 3 deterministic turns", async () => {
		const totalChars = 40_000_000; // 100x MOCKED_WINDOW_CHARS
		const needleValue = "s-niah-100x-answer-9f3e";
		const { context, expectedChunk } = buildHaystack(totalChars, needleValue, MOCKED_WINDOW_CHARS);
		expect(context).toHaveLength(totalChars);

		const start = Date.now();
		session = new RlmSession({
			prompt: context,
			rootLlm: scriptedNiahRootLlm(MOCKED_WINDOW_CHARS),
			// See the 10x case's comment above -- scaled further up for a 10x
			// larger context payload.
			maxRssBytes: 1024 * 1024 * 1024,
			// The chunk-scan turn now loops ~100 times (40,000,000 /
			// MOCKED_WINDOW_CHARS) inside a single exec -- still one root-LLM
			// turn, but give it a bit more per-step wall-clock headroom than
			// the 30s default's margin against this test's own 25s bound below.
			stepTimeoutMs: 20_000,
		});
		const result = await session.run();
		const elapsedMs = Date.now() - start;

		expect(result.kind).toBe("final");
		expect(result.value).toBe(needleValue);
		expect(result.steps).toBe(3);
		expect(result.history[1].truncatedStdout.trim()).toBe(String(expectedChunk));

		// Reasonable wall-clock time even at 100x scale: still just a few
		// linear scans over a 40MB string plus process/sandbox spawn
		// overhead -- seconds, not the "many turns" a real root LLM run would
		// take (which is exactly what the fixed 3-turn mock avoids).
		expect(elapsedMs).toBeLessThan(25_000);
	}, 30_000);
});
