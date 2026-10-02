import { describe, expect, test } from "bun:test";
import type { Feed } from "../../src/contract.js";
import { feedDirOf, resolveFeedMediaPaths, resolveMediaPath } from "../src/lib/mediaPath.js";

describe("feedDirOf", () => {
	test("strips the filename, keeping a trailing slash", () => {
		expect(feedDirOf("draht-mono/feed.json")).toBe("draht-mono/");
		expect(feedDirOf("a/b/feed.json")).toBe("a/b/");
	});

	test("is empty when the feed is at the site root", () => {
		expect(feedDirOf("feed.json")).toBe("");
	});
});

describe("resolveMediaPath", () => {
	test("prefixes a relative media path with the feed's directory", () => {
		expect(resolveMediaPath("draht-mono-e2e/feed.json", "reels/abc123/video.mp4")).toBe(
			"draht-mono-e2e/reels/abc123/video.mp4",
		);
	});

	test("leaves an absolute URL unchanged", () => {
		expect(resolveMediaPath("draht-mono/feed.json", "https://cdn.example.com/v.mp4")).toBe("https://cdn.example.com/v.mp4");
	});

	test("leaves a root-relative path unchanged", () => {
		expect(resolveMediaPath("draht-mono/feed.json", "/media/v.mp4")).toBe("/media/v.mp4");
	});
});

describe("resolveFeedMediaPaths", () => {
	test("resolves video, audio and poster on every reel, leaving everything else intact", () => {
		const feed: Feed = {
			schemaVersion: 1,
			repo: { name: "draht-mono-e2e" },
			generatedAt: "2026-10-02T00:00:00Z",
			reels: [
				{
					id: "a8d5d316b534",
					commits: ["a8d5d316b534"],
					title: "docs: update",
					authors: ["Oskar Freye"],
					date: "2026-10-02T00:39:16+02:00",
					durationMs: 15770,
					video: "reels/a8d5d316b534/video.mp4",
					poster: "reels/a8d5d316b534/poster.jpg",
					scenes: [],
					transcript: [],
					stats: { files: 2, additions: 7, deletions: 2 },
				},
			],
		};

		const resolved = resolveFeedMediaPaths(feed, "draht-mono-e2e/feed.json");
		expect(resolved.reels[0]?.video).toBe("draht-mono-e2e/reels/a8d5d316b534/video.mp4");
		expect(resolved.reels[0]?.poster).toBe("draht-mono-e2e/reels/a8d5d316b534/poster.jpg");
		expect(resolved.reels[0]?.audio).toBeUndefined();
		expect(resolved.reels[0]?.id).toBe("a8d5d316b534");
	});
});
