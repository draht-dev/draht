import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { transcribe } from "../../src/voice/transcribe.js";

/**
 * Real integration test — no mocks. Spawns the actual `whisper-cli` binary
 * against the classic JFK inaugural-address sample whisper.cpp ships as its own
 * smoke-test fixture, using the real `ggml-base.en.bin` model installed in this
 * sandbox at `~/.whisper-models/`. Proves the subprocess wiring genuinely works
 * end-to-end (spawn → JSON output file → parse), not just that it compiles.
 *
 * These tests need a real whisper.cpp install (the `whisper-cli` binary on PATH,
 * a ggml model, and the jfk.wav fixture). Those are present in this sandbox but
 * NOT on an arbitrary CI runner, so each test SKIPS gracefully when its
 * prerequisites are absent rather than hard-failing — a missing local toolchain
 * is not a product regression. In this sandbox they run for real and must pass.
 *
 * DE is not exercised here — see the doc comment on `transcribe()` for why.
 */

const MODEL_PATH = join(homedir(), ".whisper-models", "ggml-base.en.bin");

/**
 * Locates whisper.cpp's bundled jfk.wav smoke-test fixture without hardcoding
 * the Homebrew version number, returning `null` when it isn't installed.
 */
function findJfkFixture(): string | null {
	const cellar = "/opt/homebrew/Cellar/whisper-cpp";
	if (!existsSync(cellar)) return null;
	for (const version of readdirSync(cellar)) {
		const candidate = join(cellar, version, "share", "whisper-cpp", "jfk.wav");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const whisperCliPath = Bun.which("whisper-cli");
const jfkFixture = findJfkFixture();
const modelInstalled = existsSync(MODEL_PATH);
const canRunRealTranscription = whisperCliPath !== null && modelInstalled && jfkFixture !== null;

describe("transcribe", () => {
	test.skipIf(!canRunRealTranscription)(
		"transcribes the real jfk.wav sample via the installed whisper-cli + ggml-base.en.bin",
		async () => {
			// Guarded by `skipIf(!canRunRealTranscription)` — jfkFixture is non-null here.
			const result = await transcribe(jfkFixture as string, { language: "en", timeoutMs: 60_000 });

			// Actual whisper-cli output for this fixture (verified via direct CLI run):
			// "And so my fellow Americans, ask not what your country can do for you,
			//  ask what you can do for your country."
			expect(result.text.toLowerCase()).toContain("country");
			expect(result.text.toLowerCase()).toContain("ask");
			expect(result.language).toBe("en");
		},
		60_000,
	);

	test.skipIf(whisperCliPath === null)(
		"rejects with a clear error when whisper-cli exits non-zero (missing audio file)",
		async () => {
			await expect(transcribe("/tmp/geist-voice-test-does-not-exist.wav", { timeoutMs: 30_000 })).rejects.toThrow(
				/whisper-cli exited with code/,
			);
		},
		30_000,
	);
});
