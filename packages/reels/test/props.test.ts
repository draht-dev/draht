import { describe, expect, test } from "bun:test";
import type { Feed, ReelEntry } from "../src/contract.ts";
import { FEED_SCHEMA_VERSION } from "../src/contract.ts";
import { msToFrames } from "../src/remotion/props.ts";

describe("msToFrames", () => {
	test("maps 0ms to frame 0, not frame 1 (a scene starting at ms=0 must land on frame 0 or frame 0 renders blank)", () => {
		expect(msToFrames(0, 30)).toBe(0);
	});

	test("rounds to the nearest frame", () => {
		expect(msToFrames(1000, 30)).toBe(30);
		expect(msToFrames(500, 30)).toBe(15);
	});
});

describe("contract v2 (compile-time fixture)", () => {
	test("a story entry with a deep dive, a release entry, and a sync recap all satisfy Feed", () => {
		expect(FEED_SCHEMA_VERSION).toBe(2);

		const storyWithDeepDive: ReelEntry = {
			id: "7eaeb65a2".padEnd(40, "0"),
			commits: ["7eaeb65a2"],
			title: "feat(reels): word captions and beat-synced focus",
			authors: ["Oskar Freye"],
			date: "2026-10-04T00:00:00.000Z",
			durationMs: 120_000,
			poster: "reels/7eaeb65a2/poster.png",
			scenes: [{ kind: "outro", narration: "That is the change." }],
			transcript: [{ sceneIndex: 0, text: "That is the change.", startMs: 0, endMs: 1000 }],
			stats: { files: 3, additions: 40, deletions: 2 },
			kind: "story",
			writer: "llm",
			release: "v2026.10.4-3",
			story: {
				origin: "branch",
				base: "5608a0d48",
				commitCount: 5,
				branch: "feat/reels-explainer-visuals",
				theme: "reels",
				summary: "Beat-synced captions land in the reel player.",
				deepDive: "rendered",
			},
			sources: [{ id: "c:7eaeb65a2", kind: "commit", label: "feat(reels): word captions" }],
			deepDive: {
				durationMs: 300_000,
				scenes: [{ kind: "outro", narration: "The deep dive." }],
				transcript: [{ sceneIndex: 0, text: "The deep dive.", startMs: 0, endMs: 1000 }],
			},
		};

		const releaseEntry: ReelEntry = {
			id: "release-v2026.10.4-3",
			commits: [],
			title: "v2026.10.4-3",
			authors: [],
			date: "2026-10-05T00:00:00.000Z",
			durationMs: 60_000,
			scenes: [{ kind: "outro", narration: "That is the release." }],
			transcript: [{ sceneIndex: 0, text: "That is the release.", startMs: 0, endMs: 1000 }],
			stats: { files: 0, additions: 0, deletions: 0 },
			kind: "release",
			writer: "llm",
			release: "v2026.10.4-3",
			sources: [{ id: "st:7eaeb65a2", kind: "story", label: "word captions and beat-synced focus" }],
		};

		const syncRecapEntry: ReelEntry = {
			id: "recap-v0.99.2",
			commits: [],
			title: "Upstream sync through v0.99.2",
			authors: [],
			date: "2026-10-01T00:00:00.000Z",
			durationMs: 90_000,
			scenes: [{ kind: "outro", narration: "That is the sync." }],
			transcript: [{ sceneIndex: 0, text: "That is the sync.", startMs: 0, endMs: 1000 }],
			stats: { files: 0, additions: 0, deletions: 0 },
			kind: "recap",
			writer: "llm",
			recap: {
				fromRef: "v0.84.4",
				toRef: "v0.99.2",
				commitCount: 365,
				themes: [{ name: "chord", sourceIds: ["cl:chord@0.99.2#1"] }],
			},
		};

		const feed: Feed = {
			schemaVersion: FEED_SCHEMA_VERSION,
			repo: { name: "draht-mono", blobUrlTemplate: "https://example.com/{sha}/{path}#L{line}" },
			generatedAt: "2026-10-05T00:00:00.000Z",
			reels: [storyWithDeepDive, releaseEntry, syncRecapEntry],
			playlists: [
				{
					tag: "v2026.10.4-3",
					sha: storyWithDeepDive.id,
					date: releaseEntry.date,
					title: "v2026.10.4-3",
					storyIds: [storyWithDeepDive.id],
					overviewId: releaseEntry.id,
					themes: [{ name: "reels", storyIds: [storyWithDeepDive.id] }],
					syncs: [{ title: "Upstream sync through v0.99.2", commitCount: 365, recapId: syncRecapEntry.id }],
					changeCount: 5,
					tiny: false,
				},
			],
		};

		expect(feed.reels).toHaveLength(3);
		expect(feed.playlists?.[0].syncs[0].recapId).toBe(syncRecapEntry.id);
	});
});
