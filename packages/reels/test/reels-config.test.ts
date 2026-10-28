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

	test("security: rejects a catastrophic-backtracking nested quantifier in tagPattern", () => {
		expect(() => parseReelsConfig({ tagPattern: "^(a+)+$" })).toThrow(ReelsConfigError);
	});

	test("security: rejects a catastrophic-backtracking nested quantifier in upstream.subjectPatterns", () => {
		expect(() => parseReelsConfig({ upstream: { subjectPatterns: ["(a*)*"] } })).toThrow(ReelsConfigError);
	});

	test("security: rejects a catastrophic-backtracking nested quantifier in prose.denyPatterns", () => {
		expect(() => parseReelsConfig({ prose: { denyPatterns: ["(a+)*"] } })).toThrow(ReelsConfigError);
	});

	test("an ordinary regex with an unnested quantifier is still accepted", () => {
		const config = parseReelsConfig({ tagPattern: "^v[0-9]+\\.[0-9]+\\.[0-9]+$" });
		expect(config.tagPattern).toBe("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
	});

	test("docs.deny extends the default deny list instead of replacing it", () => {
		const config = parseReelsConfig({ docs: { deny: ["custom/secret.md"] } });
		expect(config.docs.deny).toContain("custom/secret.md");
		for (const defaultDeny of DEFAULT_REELS_CONFIG.docs.deny) {
			expect(config.docs.deny).toContain(defaultDeny);
		}
	});

	test("accepts a valid story.model", () => {
		const config = parseReelsConfig({ story: { model: "anthropic/claude-sonnet-5" } });
		expect(config.story.model).toBe("anthropic/claude-sonnet-5");
	});

	test("story.model is undefined when absent", () => {
		expect(parseReelsConfig({}).story.model).toBeUndefined();
	});

	test("rejects a story.model with no slash", () => {
		expect(() => parseReelsConfig({ story: { model: "anthropic" } })).toThrow(ReelsConfigError);
	});

	test("rejects a story.model with more than one slash", () => {
		expect(() => parseReelsConfig({ story: { model: "anthropic/claude/sonnet" } })).toThrow(ReelsConfigError);
	});

	test("rejects a story.model with an empty provider or id", () => {
		expect(() => parseReelsConfig({ story: { model: "/claude-sonnet-5" } })).toThrow(ReelsConfigError);
		expect(() => parseReelsConfig({ story: { model: "anthropic/" } })).toThrow(ReelsConfigError);
	});

	test("rejects a non-string story.model", () => {
		expect(() => parseReelsConfig({ story: { model: 123 } })).toThrow(ReelsConfigError);
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

describe("story.skipTypes / story.skipAuthors (housekeeping/bot filter)", () => {
	test("defaults are filled in", () => {
		const config = parseReelsConfig({});
		expect(config.story.skipTypes).toEqual(DEFAULT_REELS_CONFIG.story.skipTypes);
		expect(config.story.skipAuthors).toEqual(DEFAULT_REELS_CONFIG.story.skipAuthors);
	});

	test("accepts an override of both lists", () => {
		const config = parseReelsConfig({ story: { skipTypes: ["chore", "docs"], skipAuthors: ["my-bot[bot]"] } });
		expect(config.story.skipTypes).toEqual(["chore", "docs"]);
		expect(config.story.skipAuthors).toEqual(["my-bot[bot]"]);
	});

	test("rejects a non-array skipTypes/skipAuthors", () => {
		expect(() => parseReelsConfig({ story: { skipTypes: "chore" } })).toThrow(ReelsConfigError);
		expect(() => parseReelsConfig({ story: { skipAuthors: "bot" } })).toThrow(ReelsConfigError);
	});

	test("rejects an uppercase or empty skipTypes entry", () => {
		expect(() => parseReelsConfig({ story: { skipTypes: ["CHORE"] } })).toThrow(ReelsConfigError);
		expect(() => parseReelsConfig({ story: { skipTypes: [""] } })).toThrow(ReelsConfigError);
	});

	test("rejects an empty or overlong skipAuthors entry", () => {
		expect(() => parseReelsConfig({ story: { skipAuthors: [""] } })).toThrow(ReelsConfigError);
		expect(() => parseReelsConfig({ story: { skipAuthors: ["x".repeat(129)] } })).toThrow(ReelsConfigError);
	});

	test("rejects a skipAuthors entry with a path separator", () => {
		expect(() => parseReelsConfig({ story: { skipAuthors: ["foo/bar"] } })).toThrow(ReelsConfigError);
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
