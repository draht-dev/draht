import { describe, expect, test } from "bun:test";
import type { AnchorContext, RawDiagram } from "../src/anchored-diagram.ts";
import type { HeadFileContent } from "../src/code-ref.ts";
import type { FileChange, Section } from "../src/contract.ts";
import { createSourceRegistry } from "../src/sources.ts";
import type { RawBeat, RawScene, RawWriterResponse } from "../src/story-protocol.ts";
import type { ValidationContext } from "../src/story-validate.ts";
import { REASON_NOT_RECORDED_TEXT, validateStoryScript } from "../src/story-validate.ts";

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

function metaBeat(text: string): RawBeat {
	return { text, claim: "meta", cites: [] };
}

function validDiagram(): RawDiagram {
	return {
		nodes: [
			{ id: "a", anchor: { kind: "component", value: "@draht/reels" }, caption: "the package" },
			{ id: "b", anchor: { kind: "component", value: "src" }, caption: "the source" },
			{ id: "c", anchor: { kind: "symbol", value: "resolveCodeRef" }, caption: "resolves it" },
		],
		edges: [],
	};
}

function validCodeRef(): RawScene["code"] {
	return { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [1, 2] };
}

/**
 * The minimal arc that satisfies `validateArc` (short, or deep when `deep` is set): problem -> idea ->
 * mechanism(diagram) -> code -> impact -> [alternatives] -> outro, every scene a single `meta` beat. `overrides`
 * replaces one or more sections by name (and, for `deep`, may add `alternatives`) so a test can focus on one scene
 * without re-deriving the rest of the arc.
 */
function fullArc(overrides: Partial<Record<Section, RawScene>> = {}, deep = false): RawScene[] {
	const base: Record<string, RawScene> = {
		problem: { section: "problem", beats: [metaBeat("Problem.")] },
		idea: { section: "idea", beats: [metaBeat("Idea.")] },
		mechanism: { section: "mechanism", diagram: validDiagram(), beats: [metaBeat("Mechanism.")] },
		code: { section: "code", code: validCodeRef(), beats: [metaBeat("Code.")] },
		impact: { section: "impact", beats: [metaBeat("Impact.")] },
		outro: { section: "outro", beats: [metaBeat("Outro.")] },
	};
	const order: Section[] = deep
		? ["problem", "idea", "mechanism", "code", "impact", "alternatives", "outro"]
		: ["problem", "idea", "mechanism", "code", "impact", "outro"];
	return order.flatMap((section) => {
		const scene = overrides[section] ?? base[section];
		return scene ? [scene] : [];
	});
}

function sceneFor(result: ReturnType<typeof validateStoryScript>, section: Section) {
	return result.script?.scenes.find((s) => s.section === section);
}

describe("validateStoryScript: code", () => {
	test("code lines come from git, never from the model: a diff ref resolves to the real hunk text", () => {
		const raw = response(
			fullArc({
				code: {
					section: "code",
					code: { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [1, 2] },
					beats: [{ text: "Here is the fix.", claim: "what", cites: [] }],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(sceneFor(result, "code")).toMatchObject({ kind: "code", lines: [" line ten", "+line eleven (added)"] });
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
		const raw = response(
			fullArc(
				{
					code: {
						section: "code",
						code: { path: "src/context-only.ts", ref: "head", lines: [1, 2] },
						beats: [{ text: "Context.", claim: "what", cites: [] }],
					},
				},
				true,
			),
		);
		const result = validateStoryScript(raw, baseCtx({ isDeepDive: true }), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(sceneFor(result, "code")).toMatchObject({ kind: "code", origin: "head" });
	});
});

describe("validateStoryScript: diagrams and focus", () => {
	function diagramNode(id: string, value: string) {
		return { id, anchor: { kind: "symbol" as const, value }, caption: "does X" };
	}

	test("a node anchor absent from the sources is dropped, not fatal, when the diagram still has enough valid nodes", () => {
		const raw = response(
			fullArc({
				mechanism: {
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
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.dropped.some((d) => d.includes("id=c"))).toBe(true);
	});

	test("2 of 5 invalid diagram nodes rejects the whole script", () => {
		const raw = response(
			fullArc({
				mechanism: {
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
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "anchors")).toBe(true);
	});

	test("focus lines outside the code scene's shown lines are stripped, not fatal", () => {
		const raw = response(
			fullArc({
				code: {
					section: "code",
					code: { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [1, 2] },
					beats: [{ text: "Here.", claim: "what", cites: [], focus: { lines: [1, 99] } }],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(sceneFor(result, "code")?.beats?.[0].focus).toBeUndefined();
		expect(result.dropped.some((d) => d.includes("focus.lines"))).toBe(true);
	});

	test("focus nodes must exist in the emitted diagram: a dropped node id is stripped from focus", () => {
		const raw = response(
			fullArc({
				mechanism: {
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
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(sceneFor(result, "mechanism")?.beats?.[0].focus).toBeUndefined();
	});
});

describe("validateStoryScript: citations", () => {
	test("a quote not present in the cited source is rejected", () => {
		const raw = response(
			fullArc({
				problem: { section: "problem", beats: [whyBeat({ quote: "this phrase is nowhere in the source" })] },
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations" && e.path.endsWith(".quote"))).toBe(true);
	});

	test("a cite to a truncated source is rejected", () => {
		const raw = response(
			fullArc({
				problem: {
					section: "problem",
					beats: [whyBeat({ cites: ["doc:TRUNCATED.md#x"], quote: "performance degraded under load" })],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a cite to an unknown source id is rejected", () => {
		const raw = response(
			fullArc({ problem: { section: "problem", beats: [whyBeat({ cites: ["c:000000000000"] })] } }),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a why beat without a citation is rejected", () => {
		const raw = response(
			fullArc({ problem: { section: "problem", beats: [whyBeat({ cites: [], quote: undefined })] } }),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a why beat without a citation is accepted only when its ENTIRE text is the one fixed sentence", () => {
		const raw = response(
			fullArc({
				problem: {
					section: "problem",
					beats: [{ text: REASON_NOT_RECORDED_TEXT.en, claim: "why", cites: [] }],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script).toBeDefined();
	});

	test("a real claim plus a trailing hedge no longer bypasses grounding (the fixed bug)", () => {
		const raw = response(
			fullArc({
				problem: {
					section: "problem",
					beats: [{ text: "This was needed, but the commits don't say why.", claim: "why", cites: [] }],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a what/how beat needs a cite outside a code or diagram scene", () => {
		const raw = response(
			fullArc({
				problem: { section: "problem", beats: [{ text: "This is what changed.", claim: "what", cites: [] }] },
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations")).toBe(true);
	});

	test("a how beat inside a code scene is grounded implicitly and gets the hunk's source id added", () => {
		const raw = response(
			fullArc({
				code: {
					section: "code",
					code: { path: "src/foo.ts", ref: "diff", hunk: 0, lines: [1, 2] },
					beats: [{ text: "This is how it works.", claim: "how", cites: [] }],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(sceneFor(result, "code")?.beats?.[0].cites).toEqual(["h:src/foo.ts#0"]);
	});
});

describe("validateStoryScript: narration, URLs, and redaction", () => {
	test("narration always equals the beats joined with single spaces", () => {
		const raw = response(
			fullArc({
				idea: {
					section: "idea",
					beats: [
						{ text: "First idea.  ", claim: "meta", cites: [] },
						{ text: "  Second idea.", claim: "meta", cites: [] },
					],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		const scene = sceneFor(result, "idea");
		expect(scene?.narration).toBe(scene?.beats?.map((b) => b.text).join(" "));
		expect(scene?.narration).toBe("First idea. Second idea.");
	});

	test("URLs are stripped from narration (owner decision Q7)", () => {
		const raw = response(
			fullArc({
				idea: {
					section: "idea",
					beats: [{ text: "See https://example.com/secret-plan for details.", claim: "meta", cites: [] }],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		const scene = sceneFor(result, "idea");
		expect(scene?.narration).not.toContain("https://");
		expect(scene?.beats?.[0].text).not.toContain("https://");
	});

	test("prose fields (beat text) pass through redactText", () => {
		const raw = response(
			fullArc({
				idea: { section: "idea", beats: [{ text: 'api_key = "supersecretvalue123"', claim: "meta", cites: [] }] },
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		const scene = sceneFor(result, "idea");
		expect(scene?.narration).toContain("[redacted]");
		expect(scene?.narration).not.toContain("supersecretvalue123");
	});
});

describe("validateStoryScript: arc", () => {
	test("a response with no scenes is rejected", () => {
		const raw = response([]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "arc")).toBe(true);
	});

	test("a full valid short arc passes with no arc errors", () => {
		const raw = response(fullArc());
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes.map((s) => s.section)).toEqual([
			"problem",
			"idea",
			"mechanism",
			"code",
			"impact",
			"outro",
		]);
	});

	test("a scene out of order (idea before problem) is rejected", () => {
		const raw = response([
			{ section: "idea", beats: [metaBeat("Idea.")] },
			{ section: "problem", beats: [metaBeat("Problem.")] },
			...fullArc().slice(2),
		]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "arc")).toBe(true);
	});

	test('a "mechanism" scene without a diagram is rejected', () => {
		const raw = response(fullArc({ mechanism: { section: "mechanism", beats: [metaBeat("No diagram.")] } }));
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "arc" && e.detail.includes("diagram"))).toBe(true);
	});

	test("a short with 4 code scenes exceeds the 3-scene cap", () => {
		const codeScene = (): RawScene => ({ section: "code", code: validCodeRef(), beats: [metaBeat("Code.")] });
		const scenes = fullArc();
		const codeIndex = scenes.findIndex((s) => s.section === "code");
		scenes.splice(codeIndex, 1, codeScene(), codeScene(), codeScene(), codeScene());
		const result = validateStoryScript(response(scenes), baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "arc" && e.detail.includes("at most 3"))).toBe(true);
	});

	test("a deep dive may have up to 6 code scenes and an optional alternatives scene before outro", () => {
		const codeScene = (): RawScene => ({ section: "code", code: validCodeRef(), beats: [metaBeat("Code.")] });
		const scenes = fullArc({ alternatives: { section: "alternatives", beats: [metaBeat("Alt.")] } }, true);
		const codeIndex = scenes.findIndex((s) => s.section === "code");
		scenes.splice(codeIndex, 1, ...Array.from({ length: 6 }, codeScene));
		const result = validateStoryScript(response(scenes), baseCtx({ isDeepDive: true }), HEAD_SHA);
		expect(result.errors).toEqual([]);
	});

	test('"outro" must be the last scene', () => {
		const raw = response([...fullArc(), { section: "impact", beats: [metaBeat("Late impact.")] }]);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "arc" && e.detail.includes("last scene"))).toBe(true);
	});

	test("a scene with no beats is rejected", () => {
		const raw = response(fullArc({ outro: { section: "outro", beats: [] } }));
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "beats" && e.detail.includes("at least one beat"))).toBe(true);
	});

	test("more than 8 beats in one scene is rejected", () => {
		const raw = response(
			fullArc({ outro: { section: "outro", beats: Array.from({ length: 9 }, (_, i) => metaBeat(`Beat ${i}.`)) } }),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "beats" && e.detail.includes("at most 8"))).toBe(true);
	});

	test("a beat text over 40 words is rejected", () => {
		const longText = `${Array.from({ length: 41 }, (_, i) => `word${i}`).join(" ")}.`;
		const raw = response(fullArc({ outro: { section: "outro", beats: [metaBeat(longText)] } }));
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "beats" && e.detail.includes("cap"))).toBe(true);
	});

	test("a diagram over the 9-node cap is rejected", () => {
		const raw = response(
			fullArc({
				mechanism: {
					section: "mechanism",
					diagram: {
						nodes: Array.from({ length: 10 }, (_, i) => ({
							id: `n${i}`,
							anchor: { kind: "component" as const, value: "src" },
							caption: "node",
						})),
						edges: [],
					},
					beats: [metaBeat("Mechanism.")],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx(), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "anchors" && e.detail.includes("9-node cap"))).toBe(true);
	});

	test("a deny pattern in a diagram caption is rejected with a repair message", () => {
		const raw = response(
			fullArc({
				mechanism: {
					section: "mechanism",
					diagram: {
						nodes: [
							{ id: "a", anchor: { kind: "component", value: "@draht/reels" }, caption: "Acme Corp internal" },
							{ id: "b", anchor: { kind: "component", value: "src" }, caption: "the source" },
							{ id: "c", anchor: { kind: "symbol", value: "resolveCodeRef" }, caption: "resolves it" },
						],
						edges: [],
					},
					beats: [metaBeat("Mechanism.")],
				},
			}),
		);
		const result = validateStoryScript(raw, baseCtx({ denyPatterns: [/acme corp/i] }), HEAD_SHA);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "prose" && e.detail.includes("deny pattern"))).toBe(true);
	});
});
