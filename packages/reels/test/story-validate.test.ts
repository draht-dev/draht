import { describe, expect, test } from "bun:test";
import type { AnchorContext } from "../src/anchored-diagram.ts";
import type { HeadFileContent } from "../src/code-ref.ts";
import type { FileChange } from "../src/contract.ts";
import { createSourceRegistry } from "../src/sources.ts";
import type { RawScene, RawWriterResponse } from "../src/story-protocol.ts";
import type { ValidationContext } from "../src/story-validate.ts";
import { validateStoryScript } from "../src/story-validate.ts";

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
];

const headFiles = new Map<string, HeadFileContent>([
	["src/foo.ts", { path: "src/foo.ts", lines: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`) }],
	["src/context-only.ts", { path: "src/context-only.ts", lines: ["a", "b", "c"] }],
]);

const anchors: AnchorContext = {
	changedPaths: new Set(["src/foo.ts"]),
	contextPaths: new Set(["src/context-only.ts"]),
	textByPath: new Map([["src/foo.ts", "export function resolveCodeRef() {}"]]),
	packageNames: new Set(["@draht/reels"]),
	topLevelDirs: new Set(["src"]),
};

const sources = createSourceRegistry([
	{
		id: "c:abcdef123456",
		kind: "commit",
		label: "fix: slow query",
		text: "fix: slow query\n\nBecause performance degraded under load, we added an index.",
	},
	{
		id: "doc:TRUNCATED.md#x",
		kind: "doc",
		label: "truncated doc",
		text: "[never sent to the model]",
		included: false,
	},
]);

function baseCtx(overrides: Partial<ValidationContext> = {}): ValidationContext {
	return {
		files,
		headFiles,
		sources,
		anchors,
		headSha: HEAD_SHA,
		isDeepDive: false,
		maxCodeLines: 18,
		...overrides,
	};
}

function response(scenes: RawScene[]): RawWriterResponse {
	return { title: "A change", subtitle: "By someone", summary: { text: "Summary.", cites: [] }, scenes };
}

function whyBeat(overrides: Partial<RawScene["beats"][number]> = {}): RawScene["beats"][number] {
	return {
		text: "It was slow because performance degraded under load.",
		claim: "why",
		cites: ["c:abcdef123456"],
		quote: "performance degraded under load",
		...overrides,
	};
}

describe("validateStoryScript: code", () => {
	test("code lines come from git, never from the model: a diff ref resolves to the real hunk text", () => {
		const raw = response([
			{
				section: "code",
				code: { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [1, 2] },
				beats: [{ text: "Here is the fix.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes[0]).toMatchObject({ kind: "code", lines: [" line ten", "+line eleven (added)"] });
	});

	test("a code range outside the hunk is rejected", () => {
		const raw = response([
			{
				section: "code",
				code: { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [50, 60] },
				beats: [{ text: "Here is the fix.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "code")).toBe(true);
	});

	test("a context-only head range is rejected in a short", () => {
		const raw = response([
			{
				section: "code",
				code: { path: "src/context-only.ts", ref: "head", lines: [1, 2] },
				beats: [{ text: "Context.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx({ isDeepDive: false }), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "code")).toBe(true);
	});

	test("the same context-only head range is accepted, and marked as head-origin, in a deep dive", () => {
		const raw = response([
			{
				section: "code",
				code: { path: "src/context-only.ts", ref: "head", lines: [1, 2] },
				beats: [{ text: "Context.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx({ isDeepDive: true }), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes[0]).toMatchObject({ kind: "code", origin: "head" });
	});
});

describe("validateStoryScript: diagrams and focus", () => {
	function diagramNode(id: string, value: string) {
		return { id, anchor: { kind: "symbol" as const, value }, caption: "does X" };
	}

	test("a node anchor absent from the sources is dropped, not fatal, when the diagram still has enough valid nodes", () => {
		const raw = response([
			{
				section: "mechanism",
				diagram: {
					nodes: [
						diagramNode("a", "resolveCodeRef"),
						diagramNode("b", "resolveCodeRef"),
						diagramNode("c", "neverWritten"),
						diagramNode("d", "resolveCodeRef"),
					],
					edges: [],
				},
				beats: [{ text: "See the diagram.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.dropped.some((d) => d.includes("id=c"))).toBe(true);
	});

	test("2 of 5 invalid diagram nodes rejects the whole script", () => {
		const raw = response([
			{
				section: "mechanism",
				diagram: {
					nodes: [
						diagramNode("a", "resolveCodeRef"),
						diagramNode("b", "resolveCodeRef"),
						diagramNode("c", "neverWritten1"),
						diagramNode("d", "neverWritten2"),
						diagramNode("e", "resolveCodeRef"),
					],
					edges: [],
				},
				beats: [{ text: "See the diagram.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "anchors")).toBe(true);
	});

	test("focus lines outside the code scene's shown lines are stripped, not fatal", () => {
		const raw = response([
			{
				section: "code",
				code: { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [1, 2] },
				beats: [{ text: "Here.", claim: "what", cites: [], focus: { lines: [1, 99] } }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes[0].beats?.[0].focus).toBeUndefined();
		expect(result.dropped.some((d) => d.includes("focus.lines"))).toBe(true);
	});

	test("focus nodes must exist in the emitted diagram: a dropped node id is stripped from focus", () => {
		const raw = response([
			{
				section: "mechanism",
				diagram: {
					nodes: [
						diagramNode("a", "resolveCodeRef"),
						diagramNode("b", "resolveCodeRef"),
						diagramNode("c", "neverWritten"),
						diagramNode("d", "resolveCodeRef"),
					],
					edges: [],
				},
				beats: [{ text: "See it.", claim: "what", cites: [], focus: { nodes: ["c"] } }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes[0].beats?.[0].focus).toBeUndefined();
	});
});

describe("validateStoryScript: citations", () => {
	test("a quote not present in the cited source is rejected", () => {
		const raw = response([
			{ section: "problem", beats: [whyBeat({ quote: "this phrase is nowhere in the source" })] },
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations" && e.path.endsWith(".quote"))).toBe(true);
	});

	test("a cite to a truncated source is rejected", () => {
		const raw = response([
			{
				section: "problem",
				beats: [whyBeat({ cites: ["doc:TRUNCATED.md#x"], quote: "performance degraded under load" })],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a cite to an unknown source id is rejected", () => {
		const raw = response([{ section: "problem", beats: [whyBeat({ cites: ["c:000000000000"] })] }]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a why beat without a citation is rejected", () => {
		const raw = response([{ section: "problem", beats: [whyBeat({ cites: [], quote: undefined })] }]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a why beat without a citation is accepted when its text explicitly says the reason isn't recorded", () => {
		const raw = response([
			{
				section: "problem",
				beats: [
					{ text: "The commits don't say why this was needed.", claim: "meta", cites: [] },
					{ text: "This was needed, but the commits don't say why.", claim: "why", cites: [] },
				],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script).toBeDefined();
	});
});

describe("validateStoryScript: narration, URLs, and redaction", () => {
	test("narration always equals the beats joined with single spaces", () => {
		const raw = response([
			{
				section: "idea",
				beats: [
					{ text: "First idea.  ", claim: "what", cites: [] },
					{ text: "  Second idea.", claim: "how", cites: [] },
				],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		const scene = result.script?.scenes[0];
		expect(scene?.narration).toBe(scene?.beats?.map((b) => b.text).join(" "));
		expect(scene?.narration).toBe("First idea. Second idea.");
	});

	test("URLs are stripped from narration (owner decision Q7)", () => {
		const raw = response([
			{
				section: "idea",
				beats: [{ text: "See https://example.com/secret-plan for details.", claim: "what", cites: [] }],
			},
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script?.scenes[0].narration).not.toContain("https://");
		expect(result.script?.scenes[0].beats?.[0].text).not.toContain("https://");
	});

	test("prose fields (beat text) pass through redactText", () => {
		const raw = response([
			{ section: "idea", beats: [{ text: 'api_key = "supersecretvalue123"', claim: "what", cites: [] }] },
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script?.scenes[0].narration).toContain("[redacted]");
		expect(result.script?.scenes[0].narration).not.toContain("supersecretvalue123");
	});
});

describe("validateStoryScript: arc", () => {
	test("a response with no scenes is rejected", () => {
		const raw = response([]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "arc")).toBe(true);
	});
});
