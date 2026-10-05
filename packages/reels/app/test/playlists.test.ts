import { describe, expect, test } from "bun:test";
import type { Feed, ReelEntry } from "../../src/contract.js";
import { isDraftReel, playlistReelIds, publishedReels, reelsByIds, visiblePlaylists } from "../src/lib/playlists.js";

/** The contract has no draft field yet; this fixture type exercises `isDraftReel`'s read-side filter. */
type DraftReel = ReelEntry & { status: "draft" };

const draftStory: DraftReel = {
	id: "story-draft",
	commits: ["c"],
	title: "Unapproved story",
	authors: ["A"],
	date: "2026-10-01T00:00:00Z",
	durationMs: 1000,
	scenes: [],
	transcript: [],
	stats: { files: 0, additions: 0, deletions: 0 },
	kind: "story",
	release: "v1.0.0",
	status: "draft",
};

function makeFeed(): Feed {
	return {
		schemaVersion: 2,
		repo: { name: "demo" },
		generatedAt: "2026-10-01T00:00:00Z",
		reels: [
			{
				id: "overview",
				commits: ["a"],
				title: "Release overview",
				authors: ["A"],
				date: "2026-10-01T00:00:00Z",
				durationMs: 1000,
				scenes: [],
				transcript: [],
				stats: { files: 0, additions: 0, deletions: 0 },
				kind: "release",
				release: "v1.0.0",
			},
			{
				id: "story-1",
				commits: ["b"],
				title: "Story one",
				authors: ["A"],
				date: "2026-10-01T00:00:00Z",
				durationMs: 1000,
				scenes: [],
				transcript: [],
				stats: { files: 0, additions: 0, deletions: 0 },
				kind: "story",
				release: "v1.0.0",
			},
			draftStory,
			{
				id: "recap-1",
				commits: ["d"],
				title: "Upstream sync recap",
				authors: ["A"],
				date: "2026-10-01T00:00:00Z",
				durationMs: 1000,
				scenes: [],
				transcript: [],
				stats: { files: 0, additions: 0, deletions: 0 },
				kind: "recap",
				release: "v1.0.0",
			},
		],
		playlists: [
			{
				tag: "v1.0.0",
				sha: "aaa",
				date: "2026-10-01T00:00:00Z",
				title: "v1.0.0",
				storyIds: ["story-1", "story-draft"],
				overviewId: "overview",
				themes: [{ name: "core", storyIds: ["story-1", "story-draft"] }],
				syncs: [{ title: "Upstream sync", commitCount: 10, recapId: "recap-1" }],
				changeCount: 2,
				tiny: false,
			},
			{
				tag: "v0.9.0",
				sha: "bbb",
				date: "2026-09-01T00:00:00Z",
				title: "v0.9.0",
				storyIds: ["story-draft"],
				themes: [],
				syncs: [],
				changeCount: 1,
				tiny: true,
			},
		],
	};
}

describe("isDraftReel / publishedReels", () => {
	test("hides a reel marked draft", () => {
		const feed = makeFeed();
		expect(isDraftReel(draftStory)).toBe(true);
		const published = publishedReels(feed);
		expect(published.map((reel) => reel.id)).toEqual(["overview", "story-1", "recap-1"]);
	});
});

describe("visiblePlaylists", () => {
	test("hides a playlist whose only referenced reel is a draft", () => {
		const feed = makeFeed();
		const visible = visiblePlaylists(feed);
		expect(visible.map((playlist) => playlist.tag)).toEqual(["v1.0.0"]);
	});
});

describe("playlistReelIds", () => {
	test("orders overview, then stories, then sync recaps, dropping drafts", () => {
		const feed = makeFeed();
		const playlist = feed.playlists?.[0];
		if (!playlist) throw new Error("fixture missing playlist");
		expect(playlistReelIds(playlist, feed)).toEqual(["overview", "story-1", "recap-1"]);
	});
});

describe("reelsByIds", () => {
	test("resolves ids in the given order, dropping unknown ids", () => {
		const feed = makeFeed();
		const reels = reelsByIds(feed, ["story-1", "missing", "overview"]);
		expect(reels.map((reel) => reel.id)).toEqual(["story-1", "overview"]);
	});
});
