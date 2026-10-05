import { describe, expect, test } from "bun:test";
import type { PublicSource } from "../../src/contract.js";
import { isSourceCited, sourcesCitedBy } from "../src/lib/sources.js";

const sources: PublicSource[] = [
	{ id: "c:abc123", kind: "commit", label: "Add the writer" },
	{ id: "pr:12", kind: "pr", label: "PR #12", url: "https://example/pr/12" },
	{ id: "doc:readme", kind: "doc", label: "README" },
];

describe("sourcesCitedBy", () => {
	test("returns only the cited sources, in source order", () => {
		expect(sourcesCitedBy(sources, ["doc:readme", "c:abc123"]).map((s) => s.id)).toEqual(["c:abc123", "doc:readme"]);
	});

	test("empty cites or missing sources yield nothing", () => {
		expect(sourcesCitedBy(sources, [])).toEqual([]);
		expect(sourcesCitedBy(sources, undefined)).toEqual([]);
		expect(sourcesCitedBy(undefined, ["c:abc123"])).toEqual([]);
	});

	test("an unknown cited id is dropped", () => {
		expect(sourcesCitedBy(sources, ["nope"])).toEqual([]);
	});
});

describe("isSourceCited", () => {
	test("true only when the id is in cites", () => {
		expect(isSourceCited(["pr:12"], "pr:12")).toBe(true);
		expect(isSourceCited(["pr:12"], "doc:readme")).toBe(false);
		expect(isSourceCited(undefined, "pr:12")).toBe(false);
	});
});
