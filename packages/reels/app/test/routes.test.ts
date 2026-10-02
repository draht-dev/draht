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
});

describe("routeToHash", () => {
	test("round-trips every route kind", () => {
		expect(routeToHash({ kind: "home" })).toBe("#/");
		expect(routeToHash({ kind: "repo", repo: "draht-mono" })).toBe("#/draht-mono");
		expect(routeToHash({ kind: "reel", repo: "draht-mono", reelId: "abc123" })).toBe("#/draht-mono/reel/abc123");
	});

	test("encodes special characters", () => {
		expect(routeToHash({ kind: "repo", repo: "my repo" })).toBe("#/my%20repo");
	});

	test("parseHash(routeToHash(route)) is the identity", () => {
		const routes = [
			{ kind: "home" as const },
			{ kind: "repo" as const, repo: "a/b c" },
			{ kind: "reel" as const, repo: "a/b c", reelId: "d e" },
		];
		for (const route of routes) {
			expect(parseHash(routeToHash(route))).toEqual(route);
		}
	});
});
