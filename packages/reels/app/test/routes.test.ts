import { describe, expect, test } from "bun:test";
import { parseHash, routeToHash } from "../src/lib/routes.js";

describe("parseHash", () => {
	test("empty hash is home", () => {
		expect(parseHash("")).toEqual({ kind: "home" });
		expect(parseHash("#")).toEqual({ kind: "home" });
		expect(parseHash("#/")).toEqual({ kind: "home" });
	});

	test("repo route", () => {
		expect(parseHash("#/draht-mono")).toEqual({ kind: "repo", repo: "draht-mono" });
	});

	test("reel route", () => {
		expect(parseHash("#/draht-mono/reel/abc123")).toEqual({ kind: "reel", repo: "draht-mono", reelId: "abc123" });
	});

	test("decodes URI-encoded segments", () => {
		expect(parseHash("#/my%20repo")).toEqual({ kind: "repo", repo: "my repo" });
	});

	test("repo segment without a trailing reel id falls back to repo route", () => {
		expect(parseHash("#/draht-mono/reel")).toEqual({ kind: "repo", repo: "draht-mono" });
	});

	test("release route", () => {
		expect(parseHash("#/draht-mono/release/v1.2.0")).toEqual({ kind: "release", repo: "draht-mono", tag: "v1.2.0" });
	});

	test("repo segment without a trailing tag falls back to repo route", () => {
		expect(parseHash("#/draht-mono/release")).toEqual({ kind: "repo", repo: "draht-mono" });
	});

	test("decodes an encoded release tag", () => {
		expect(parseHash("#/draht-mono/release/v1.2.0%2Fbeta")).toEqual({
			kind: "release",
			repo: "draht-mono",
			tag: "v1.2.0/beta",
		});
	});

	test("deep dive reel route", () => {
		expect(parseHash("#/draht-mono/reel/abc123/deep")).toEqual({
			kind: "reel",
			repo: "draht-mono",
			reelId: "abc123",
			deep: true,
		});
	});

	test("a trailing segment other than 'deep' is ignored, staying a plain reel route", () => {
		expect(parseHash("#/draht-mono/reel/abc123/whatever")).toEqual({ kind: "reel", repo: "draht-mono", reelId: "abc123" });
	});

	test("playlist-scoped reel route", () => {
		expect(parseHash("#/draht-mono/release/v1.2.0/reel/abc123")).toEqual({
			kind: "reel",
			repo: "draht-mono",
			reelId: "abc123",
			releaseTag: "v1.2.0",
		});
	});

	test("playlist-scoped deep dive reel route", () => {
		expect(parseHash("#/draht-mono/release/v1.2.0/reel/abc123/deep")).toEqual({
			kind: "reel",
			repo: "draht-mono",
			reelId: "abc123",
			releaseTag: "v1.2.0",
			deep: true,
		});
	});

	test("release segment without a trailing reel id falls back to release route", () => {
		expect(parseHash("#/draht-mono/release/v1.2.0/reel")).toEqual({ kind: "release", repo: "draht-mono", tag: "v1.2.0" });
	});
});

describe("routeToHash", () => {
	test("round-trips every route kind", () => {
		expect(routeToHash({ kind: "home" })).toBe("#/");
		expect(routeToHash({ kind: "repo", repo: "draht-mono" })).toBe("#/draht-mono");
		expect(routeToHash({ kind: "reel", repo: "draht-mono", reelId: "abc123" })).toBe("#/draht-mono/reel/abc123");
		expect(routeToHash({ kind: "release", repo: "draht-mono", tag: "v1.2.0" })).toBe("#/draht-mono/release/v1.2.0");
		expect(routeToHash({ kind: "reel", repo: "draht-mono", reelId: "abc123", deep: true })).toBe(
			"#/draht-mono/reel/abc123/deep",
		);
		expect(routeToHash({ kind: "reel", repo: "draht-mono", reelId: "abc123", releaseTag: "v1.2.0" })).toBe(
			"#/draht-mono/release/v1.2.0/reel/abc123",
		);
		expect(
			routeToHash({ kind: "reel", repo: "draht-mono", reelId: "abc123", releaseTag: "v1.2.0", deep: true }),
		).toBe("#/draht-mono/release/v1.2.0/reel/abc123/deep");
	});

	test("encodes special characters", () => {
		expect(routeToHash({ kind: "repo", repo: "my repo" })).toBe("#/my%20repo");
	});

	test("parseHash(routeToHash(route)) is the identity", () => {
		const routes = [
			{ kind: "home" as const },
			{ kind: "repo" as const, repo: "a/b c" },
			{ kind: "reel" as const, repo: "a/b c", reelId: "d e" },
			{ kind: "release" as const, repo: "a/b c", tag: "v1/2 0" },
			{ kind: "reel" as const, repo: "a/b c", reelId: "d e", deep: true as const },
			{ kind: "reel" as const, repo: "a/b c", reelId: "d e", releaseTag: "v1/2 0" },
			{ kind: "reel" as const, repo: "a/b c", reelId: "d e", releaseTag: "v1/2 0", deep: true as const },
		];
		for (const route of routes) {
			expect(parseHash(routeToHash(route))).toEqual(route);
		}
	});
});
