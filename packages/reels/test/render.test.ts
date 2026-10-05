import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishAudioForRender } from "../src/render.ts";

const SHA = "a".repeat(40);

describe("publishAudioForRender", () => {
	test("copies the audio into the bundle's served directory and returns a root-relative URL", async () => {
		const serveUrl = mkdtempSync(join(tmpdir(), "reels-render-test-"));
		const sourceDir = mkdtempSync(join(tmpdir(), "reels-render-src-"));
		try {
			const sourcePath = join(sourceDir, "narration.mp3");
			writeFileSync(sourcePath, "fake-mp3-bytes");

			const url = await publishAudioForRender({ serveUrl }, SHA, sourcePath);

			expect(url).toBe(`/audio/${SHA}.mp3`);
			const copied = readFileSync(join(serveUrl, "audio", `${SHA}.mp3`), "utf-8");
			expect(copied).toBe("fake-mp3-bytes");
		} finally {
			rmSync(serveUrl, { recursive: true, force: true });
			rmSync(sourceDir, { recursive: true, force: true });
		}
	});

	test("rejects a render key that is not a safe filename (defense in depth against path traversal/option injection)", async () => {
		const serveUrl = mkdtempSync(join(tmpdir(), "reels-render-test-"));
		const sourceDir = mkdtempSync(join(tmpdir(), "reels-render-src-"));
		try {
			const sourcePath = join(sourceDir, "narration.mp3");
			writeFileSync(sourcePath, "fake-mp3-bytes");
			await expect(publishAudioForRender({ serveUrl }, "../../../../etc/passwd", sourcePath)).rejects.toThrow();
		} finally {
			rmSync(serveUrl, { recursive: true, force: true });
			rmSync(sourceDir, { recursive: true, force: true });
		}
	});

	// Regression: a paid run crashed here because this validated the release artifact id (never a git
	// object id) against the git-sha-only pattern, after the LLM and TTS had already been paid for.
	test("accepts a release-artifact render key like release-<tag>, which is never a git sha", async () => {
		const serveUrl = mkdtempSync(join(tmpdir(), "reels-render-test-"));
		const sourceDir = mkdtempSync(join(tmpdir(), "reels-render-src-"));
		try {
			const sourcePath = join(sourceDir, "narration.mp3");
			writeFileSync(sourcePath, "fake-mp3-bytes");
			const renderKey = "release-v2026.10.4-1";

			const url = await publishAudioForRender({ serveUrl }, renderKey, sourcePath);

			expect(url).toBe(`/audio/${renderKey}.mp3`);
			const copied = readFileSync(join(serveUrl, "audio", `${renderKey}.mp3`), "utf-8");
			expect(copied).toBe("fake-mp3-bytes");
		} finally {
			rmSync(serveUrl, { recursive: true, force: true });
			rmSync(sourceDir, { recursive: true, force: true });
		}
	});
});
