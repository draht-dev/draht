import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_REELS_CONFIG, loadReelsConfig } from "../src/reels-config.ts";

/**
 * draht-mono.reels.json's `historyFloor`
 * (95276df0608dabe8d443c3191fa8e391f9922cca, "Add [Unreleased] section for
 * next cycle") is the merge-base of the earliest draht release tag
 * (v2026.2.28) and the current main branch tip in /srv/work/draht/draht-mono.
 * main's own first-parent chain was later rebased onto a newer upstream
 * snapshot, so the parent of the first Oskar-Freye-authored commit
 * (9e3973b9c) is NOT an ancestor of v2026.2.28 (`git merge-base --is-ancestor`
 * fails): only this merge-base sha is guaranteed to be an ancestor of every
 * draht release range regardless of that rewrite. It sits one commit after
 * the last pure-pi tag (v0.55.3) and is authored by Mario Zechner (upstream),
 * confirming it predates draht's own work. `git rev-list --count
 * 95276df06..v2026.2.28` is 18 (draht's own pre-release commits); without the
 * floor, `git rev-list --count v2026.2.28` is 3037 (includes pre-fork pi
 * history back to its own root).
 */
describe("draht-mono.reels.json", () => {
	test("loads and validates with the real loader", async () => {
		const config = await loadReelsConfig(join(import.meta.dir, "../examples/draht-mono.reels.json"));

		expect(config.tagPattern).toBe("^v2026\\.");
		expect(config.historyFloor).toBe("95276df0608dabe8d443c3191fa8e391f9922cca");
		expect(config.upstream.subjectPatterns).toEqual(["^merge: sync upstream pi", "^upstream:"]);
		expect(config.upstream.markerPaths).toEqual([".upstream-sync"]);
		expect(config.story.minAttribution).toBe("strong");
		expect(config.story.model).toBe("anthropic/claude-sonnet-5");
		expect(config.docs.allow).toContain("docs/**");
		expect(config.docs.allow).toContain("docs/adr/**");
		expect(config.docs.deny).toEqual(DEFAULT_REELS_CONFIG.docs.deny);
		expect(config.build.maxCostUsd).toBe(5);
		expect(config.build.maxLlmTokens).toBe(2_000_000);
		expect(config.build.maxTtsChars).toBe(50_000);
	});
});
