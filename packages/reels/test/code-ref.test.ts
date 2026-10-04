import { describe, expect, test } from "bun:test";
import type { HeadFileContent, ResolveCodeRefContext, ResolveCodeRefOptions } from "../src/code-ref.ts";
import { resolveCodeRef } from "../src/code-ref.ts";
import type { FileChange } from "../src/contract.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const files: FileChange[] = [
	{
		path: "src/foo.ts",
		status: "modified",
		additions: 1,
		deletions: 1,
		hunks: [
			{
				header: "@@ -10,3 +10,4 @@",
				lines: [" line ten", "+line eleven (added)", " line twelve", "-line thirteen (removed)"],
			},
		],
	},
	{
		path: "src/secret.ts",
		status: "modified",
		additions: 1,
		deletions: 0,
		hunks: [{ header: "@@ content withheld: possible secret @@", lines: [], withheld: true }],
	},
];

const headFiles = new Map<string, HeadFileContent>([
	[
		"src/foo.ts",
		{
			path: "src/foo.ts",
			lines: [
				"line one",
				"line two",
				"line three",
				"line four",
				"line five",
				"line six",
				"line seven",
				"line eight",
				"line nine",
				"line ten",
				"line eleven (added)",
				"line twelve",
			],
		},
	],
	["src/context-only.ts", { path: "src/context-only.ts", lines: ["a", "b", "c", "d", "e"] }],
]);

const ctx: ResolveCodeRefContext = { files, headFiles };
const shortOptions: ResolveCodeRefOptions = { maxLines: 18, allowContextOnlyHead: false };
const deepOptions: ResolveCodeRefOptions = { maxLines: 30, allowContextOnlyHead: true };

describe("resolveCodeRef: diff refs", () => {
	test("resolves a verbatim slice from the real hunk, never from model-supplied text (the ref carries no text field)", () => {
		const result = resolveCodeRef(
			{ path: "src/foo.ts", ref: "diff", hunkIndex: 0, lines: [1, 2] },
			ctx,
			shortOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.code.lines).toEqual([" line ten", "+line eleven (added)"]);
			expect(result.code.origin).toBe("diff");
			expect(result.code.hunkHeader).toBe("@@ -10,3 +10,4 @@");
		}
	});

	test("a range outside the hunk is rejected", () => {
		const result = resolveCodeRef(
			{ path: "src/foo.ts", ref: "diff", hunkIndex: 0, lines: [3, 10] },
			ctx,
			shortOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(false);
	});

	test("a withheld hunk is rejected", () => {
		const result = resolveCodeRef(
			{ path: "src/secret.ts", ref: "diff", hunkIndex: 0, lines: [1, 1] },
			ctx,
			shortOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(false);
	});

	test("a path not in the story's changed files is rejected", () => {
		const result = resolveCodeRef(
			{ path: "src/unknown.ts", ref: "diff", hunkIndex: 0, lines: [1, 1] },
			ctx,
			shortOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(false);
	});
});

describe("resolveCodeRef: head refs", () => {
	test("a head range overlapping an added line is accepted in a short, with +/space markers computed from the diff", () => {
		const result = resolveCodeRef({ path: "src/foo.ts", ref: "head", lines: [10, 11] }, ctx, shortOptions, HEAD_SHA);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.code.lines).toEqual([" line ten", "+line eleven (added)"]);
			expect(result.code.origin).toBe("head");
			expect(result.code.startLine).toBe(10);
			expect(result.code.overlapsAddedLine).toBe(true);
		}
	});

	test("a head range outside the file is rejected", () => {
		const result = resolveCodeRef({ path: "src/foo.ts", ref: "head", lines: [1, 100] }, ctx, shortOptions, HEAD_SHA);
		expect(result.ok).toBe(false);
	});

	test("a file not present in the head-file registry is rejected", () => {
		const result = resolveCodeRef(
			{ path: "src/never-seen.ts", ref: "head", lines: [1, 2] },
			ctx,
			shortOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(false);
	});

	test("a context-only (no added line) head range is rejected in a short", () => {
		const result = resolveCodeRef(
			{ path: "src/context-only.ts", ref: "head", lines: [1, 2] },
			ctx,
			shortOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(false);
	});

	test("the same context-only head range is accepted, and marked, in a deep dive", () => {
		const result = resolveCodeRef(
			{ path: "src/context-only.ts", ref: "head", lines: [1, 2] },
			ctx,
			deepOptions,
			HEAD_SHA,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.code.overlapsAddedLine).toBe(false);
			expect(result.code.lines).toEqual([" a", " b"]);
		}
	});

	test("a range over the line cap is rejected", () => {
		const result = resolveCodeRef(
			{ path: "src/foo.ts", ref: "head", lines: [1, 11] },
			ctx,
			{ maxLines: 5, allowContextOnlyHead: true },
			HEAD_SHA,
		);
		expect(result.ok).toBe(false);
	});
});
