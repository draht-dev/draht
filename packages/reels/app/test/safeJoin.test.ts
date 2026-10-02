import { describe, expect, test } from "bun:test";
import path from "node:path";
import { safeJoin } from "../src/lib/safeJoin.js";

const base = path.resolve("/tmp/reels-safe-join-test-base");

describe("safeJoin", () => {
	test("resolves a plain request path inside the base dir", () => {
		expect(safeJoin(base, "/repos.json")).toBe(path.join(base, "repos.json"));
		expect(safeJoin(base, "/draht-mono/feed.json")).toBe(path.join(base, "draht-mono/feed.json"));
	});

	test("rejects a path traversal escaping the base dir", () => {
		expect(safeJoin(base, "/../../etc/passwd")).toBeUndefined();
		expect(safeJoin(base, "/../outside.json")).toBeUndefined();
	});

	test("rejects a traversal that dips out and back in, since it still leaves the base dir", () => {
		expect(safeJoin(base, "/a/../../b.json")).toBeUndefined();
	});

	test("allows a traversal that stays inside the base dir", () => {
		expect(safeJoin(base, "/a/../b.json")).toBe(path.join(base, "b.json"));
	});

	test("the base dir itself resolves, not just its contents", () => {
		expect(safeJoin(base, "/")).toBe(base);
	});
});
