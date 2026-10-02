import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Feed, ReelEntry } from "../src/contract.ts";
import { mergeFeed, mergeRepoIndex, pruneFeed, publishFeed } from "../src/publish.ts";

const VALID_SHA_A = "a".repeat(40);
const VALID_SHA_B = "b".repeat(40);

function entry(overrides: Partial<ReelEntry> = {}): ReelEntry {
	return {
		id: "sha1",
		commits: ["sha1"],
		title: "First change",
		authors: ["Ada"],
		date: "2024-01-01T00:00:00Z",
		durationMs: 3000,
		scenes: [],
		transcript: [],
		stats: { files: 1, additions: 1, deletions: 0 },
		...overrides,
	};
}

describe("mergeFeed", () => {
	test("orders reels newest first", () => {
		const feed = mergeFeed(
			undefined,
			{ name: "repo" },
			[entry({ id: "old", date: "2024-01-01T00:00:00Z" }), entry({ id: "new", date: "2024-06-01T00:00:00Z" })],
			"2024-06-02T00:00:00Z",
		);
		expect(feed.reels.map((r) => r.id)).toEqual(["new", "old"]);
	});

	test("is idempotent: merging the same entry twice does not duplicate it", () => {
		const first = mergeFeed(undefined, { name: "repo" }, [entry({ id: "a" })], "2024-01-01T00:00:00Z");
		const second = mergeFeed(first, { name: "repo" }, [entry({ id: "a" })], "2024-01-02T00:00:00Z");
		expect(second.reels).toHaveLength(1);
		expect(second.reels[0].id).toBe("a");
	});

	test("replaces an existing entry with the same id instead of appending", () => {
		const first = mergeFeed(
			undefined,
			{ name: "repo" },
			[entry({ id: "a", title: "Old title" })],
			"2024-01-01T00:00:00Z",
		);
		const second = mergeFeed(
			first,
			{ name: "repo" },
			[entry({ id: "a", title: "New title" })],
			"2024-01-02T00:00:00Z",
		);
		expect(second.reels).toHaveLength(1);
		expect(second.reels[0].title).toBe("New title");
	});

	test("keeps the existing repo.url/commitUrlTemplate when a later run omits --repo-url", () => {
		const first = mergeFeed(
			undefined,
			{
				name: "repo",
				url: "https://github.com/acme/repo",
				commitUrlTemplate: "https://github.com/acme/repo/commit/{sha}",
			},
			[entry({ id: "a" })],
			"2024-01-01T00:00:00Z",
		);
		const second = mergeFeed(first, { name: "repo" }, [entry({ id: "b" })], "2024-01-02T00:00:00Z");
		expect(second.repo.url).toBe("https://github.com/acme/repo");
		expect(second.repo.commitUrlTemplate).toBe("https://github.com/acme/repo/commit/{sha}");
	});

	test("a later run's --repo-url overrides the stored value", () => {
		const first = mergeFeed(
			undefined,
			{ name: "repo", url: "https://old" },
			[entry({ id: "a" })],
			"2024-01-01T00:00:00Z",
		);
		const second = mergeFeed(
			first,
			{ name: "repo", url: "https://new" },
			[entry({ id: "b" })],
			"2024-01-02T00:00:00Z",
		);
		expect(second.repo.url).toBe("https://new");
	});

	test("adding a new entry keeps existing entries", () => {
		const first = mergeFeed(
			undefined,
			{ name: "repo" },
			[entry({ id: "a", date: "2024-01-01T00:00:00Z" })],
			"2024-01-01T00:00:00Z",
		);
		const second = mergeFeed(
			first,
			{ name: "repo" },
			[entry({ id: "b", date: "2024-02-01T00:00:00Z" })],
			"2024-02-01T00:00:00Z",
		);
		expect(second.reels.map((r) => r.id)).toEqual(["b", "a"]);
	});
});

describe("mergeRepoIndex", () => {
	test("adds a new repo and keeps the index sorted by name", () => {
		const feedA: Feed = { schemaVersion: 1, repo: { name: "beta" }, generatedAt: "now", reels: [entry({ id: "a" })] };
		const feedB: Feed = { schemaVersion: 1, repo: { name: "alpha" }, generatedAt: "now", reels: [] };
		const withA = mergeRepoIndex(undefined, feedA);
		const withBoth = mergeRepoIndex(withA, feedB);
		expect(withBoth.repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
	});

	test("re-publishing a repo updates its entry instead of duplicating it", () => {
		const feed: Feed = { schemaVersion: 1, repo: { name: "repo" }, generatedAt: "now", reels: [entry({ id: "a" })] };
		const first = mergeRepoIndex(undefined, feed);
		const updatedFeed: Feed = { ...feed, reels: [entry({ id: "a" }), entry({ id: "b" })] };
		const second = mergeRepoIndex(first, updatedFeed);
		expect(second.repos).toHaveLength(1);
		expect(second.repos[0].reelCount).toBe(2);
	});

	test("latest is the newest reel's ISO date, not its id (the app parses it as a date)", () => {
		const feed: Feed = {
			schemaVersion: 1,
			repo: { name: "repo" },
			generatedAt: "now",
			reels: [entry({ id: "newest-sha", date: "2024-06-01T00:00:00Z" })],
		};
		const index = mergeRepoIndex(undefined, feed);
		expect(index.repos[0].latest).toBe("2024-06-01T00:00:00Z");
	});

	test("poster is relative to repos.json (prefixed with the repo name), not to feed.json", () => {
		const feed: Feed = {
			schemaVersion: 1,
			repo: { name: "repo" },
			generatedAt: "now",
			reels: [entry({ id: "a", poster: "reels/abc/poster.jpg" })],
		};
		const index = mergeRepoIndex(undefined, feed);
		expect(index.repos[0].poster).toBe("repo/reels/abc/poster.jpg");
	});
});

describe("publishFeed (file system)", () => {
	test("running build twice for the same repo is idempotent on disk", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-publish-test-"));
		try {
			await publishFeed({
				outDir,
				repo: { name: "demo" },
				entries: [entry({ id: "a" })],
				now: () => "2024-01-01T00:00:00Z",
			});
			const { feedPath } = await publishFeed({
				outDir,
				repo: { name: "demo" },
				entries: [entry({ id: "a" }), entry({ id: "b", date: "2024-02-01T00:00:00Z" })],
				now: () => "2024-02-01T00:00:00Z",
			});

			const feed = JSON.parse(readFileSync(feedPath, "utf-8")) as Feed;
			expect(feed.reels.map((r) => r.id)).toEqual(["b", "a"]);

			const index = JSON.parse(readFileSync(join(outDir, "repos.json"), "utf-8"));
			expect(index.repos).toHaveLength(1);
			expect(index.repos[0].reelCount).toBe(2);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("pruneFeed (file system)", () => {
	test("removes entries no longer reachable from ref, for retraction after a force-push", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-prune-test-"));
		try {
			await publishFeed({
				outDir,
				repo: { name: "demo" },
				entries: [
					entry({ id: "a", date: "2024-01-01T00:00:00Z" }),
					entry({ id: "b", date: "2024-02-01T00:00:00Z" }),
				],
				now: () => "2024-02-01T00:00:00Z",
			});

			const result = await pruneFeed(outDir, "demo", new Set(["b"]), () => "2024-03-01T00:00:00Z");
			expect(result?.removed.map((r) => r.id)).toEqual(["a"]);
			expect(result?.feed.reels.map((r) => r.id)).toEqual(["b"]);

			const feed = JSON.parse(readFileSync(join(outDir, "demo", "feed.json"), "utf-8")) as Feed;
			expect(feed.reels.map((r) => r.id)).toEqual(["b"]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("does nothing when the feed does not exist", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-prune-test-"));
		try {
			const result = await pruneFeed(outDir, "demo", new Set());
			expect(result).toBeUndefined();
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("security: a feed entry id crafted as a path traversal cannot escape --out to delete an unrelated directory", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-prune-test-"));
		const canaryDir = mkdtempSync(join(tmpdir(), "reels-prune-canary-"));
		const canaryFile = join(canaryDir, "canary.txt");
		try {
			writeFileSync(canaryFile, "do not delete me\n");

			await publishFeed({
				outDir,
				repo: { name: "demo" },
				entries: [entry({ id: VALID_SHA_A, date: "2024-01-01T00:00:00Z" })],
				now: () => "2024-01-01T00:00:00Z",
			});

			// Simulate an attacker-controlled feed.json entry id. "../../../../"
			// previously resolved to the reels dir's great-grandparent and was
			// `rm -rf`'d wholesale.
			const traversalId = "../../../../";
			const feedPath = join(outDir, "demo", "feed.json");
			const feed = JSON.parse(readFileSync(feedPath, "utf-8")) as Feed;
			feed.reels.push({ ...entry({ id: traversalId }), id: traversalId });
			writeFileSync(feedPath, JSON.stringify(feed));

			const result = await pruneFeed(outDir, "demo", new Set([VALID_SHA_A]));
			expect(result?.removed.map((r) => r.id)).toEqual([traversalId]);
			expect(existsSync(canaryFile)).toBe(true);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
			rmSync(canaryDir, { recursive: true, force: true });
		}
	});

	test("security: pruning skips media removal for an entry whose id is not a valid sha, without throwing", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "reels-prune-test-"));
		try {
			await publishFeed({
				outDir,
				repo: { name: "demo" },
				entries: [
					entry({ id: VALID_SHA_A, date: "2024-01-01T00:00:00Z" }),
					entry({ id: "not-a-sha", date: "2024-02-01T00:00:00Z" }),
				],
				now: () => "2024-02-01T00:00:00Z",
			});

			const legitMediaDir = join(outDir, "demo", "reels", VALID_SHA_A.slice(0, 12));
			mkdirSync(legitMediaDir, { recursive: true });

			const result = await pruneFeed(outDir, "demo", new Set([VALID_SHA_B]));
			expect(result?.removed.map((r) => r.id).sort()).toEqual([VALID_SHA_A, "not-a-sha"]);
			expect(existsSync(dirname(legitMediaDir))).toBe(true);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
