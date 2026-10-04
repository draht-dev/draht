import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REELS_CONFIG, loadReelsConfig, parseReelsConfig, ReelsConfigError } from "../src/reels-config.ts";

describe("parseReelsConfig", () => {
	test("a valid config loads with defaults filled in", () => {
		const config = parseReelsConfig({
			tagPattern: "^v2026\\.",
			historyFloor: "abc123",
			overrides: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "back-merge" },
			upstream: { markerPaths: [".upstream-sync"] },
			story: { maxBranchCommits: 200 },
		});
		expect(config.tagPattern).toBe("^v2026\\.");
		expect(config.historyFloor).toBe("abc123");
		expect(config.overrides).toEqual({ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: "back-merge" });
		expect(config.upstream.markerPaths).toEqual([".upstream-sync"]);
		expect(config.upstream.subjectPatterns).toEqual(DEFAULT_REELS_CONFIG.upstream.subjectPatterns);
		expect(config.upstream.foreignAuthorRatio).toBe(DEFAULT_REELS_CONFIG.upstream.foreignAuthorRatio);
		expect(config.story.maxBranchCommits).toBe(200);
		expect(config.story.directCommitTypes).toEqual(DEFAULT_REELS_CONFIG.story.directCommitTypes);
	});

	test("an empty object loads as all defaults", () => {
		expect(parseReelsConfig({})).toEqual(DEFAULT_REELS_CONFIG);
	});

	test("rejects an unknown top-level key", () => {
		expect(() => parseReelsConfig({ bogusKey: true })).toThrow(ReelsConfigError);
	});

	test("rejects an unknown key inside upstream", () => {
		expect(() => parseReelsConfig({ upstream: { bogusKey: true } })).toThrow(ReelsConfigError);
	});

	test("rejects an unknown key inside story", () => {
		expect(() => parseReelsConfig({ story: { bogusKey: true } })).toThrow(ReelsConfigError);
	});

	test("rejects a bad regex in tagPattern", () => {
		expect(() => parseReelsConfig({ tagPattern: "(unclosed" })).toThrow(ReelsConfigError);
	});

	test("rejects a bad regex in upstream.subjectPatterns", () => {
		expect(() => parseReelsConfig({ upstream: { subjectPatterns: ["[unclosed"] } })).toThrow(ReelsConfigError);
	});

	test("rejects an override value outside the enum", () => {
		expect(() => parseReelsConfig({ overrides: { deadbeef: "not-a-real-class" } })).toThrow(ReelsConfigError);
	});

	test("rejects a non-object config", () => {
		expect(() => parseReelsConfig("not an object")).toThrow(ReelsConfigError);
		expect(() => parseReelsConfig(null)).toThrow(ReelsConfigError);
		expect(() => parseReelsConfig([])).toThrow(ReelsConfigError);
	});
});

describe("loadReelsConfig", () => {
	test("reads and validates a config file from disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "reels-config-test-"));
		try {
			writeFileSync(join(dir, ".reels.json"), JSON.stringify({ tagPattern: "^v" }));
			const config = await loadReelsConfig(join(dir, ".reels.json"));
			expect(config.tagPattern).toBe("^v");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects invalid JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "reels-config-test-"));
		try {
			writeFileSync(join(dir, ".reels.json"), "{ not json");
			await expect(loadReelsConfig(join(dir, ".reels.json"))).rejects.toThrow(ReelsConfigError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
