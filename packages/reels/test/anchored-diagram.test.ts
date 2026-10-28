import { describe, expect, test } from "bun:test";
import type { AnchorContext, RawDiagram } from "../src/anchored-diagram.ts";
import { isAnchorValid, validateAndEmitDiagram } from "../src/anchored-diagram.ts";

const ctx: AnchorContext = {
	changedPaths: new Set(["src/foo.ts", "src/bar.ts"]),
	contextPaths: new Set(["README.md"]),
	textByPath: new Map([
		["src/foo.ts", "export function resolveCodeRef(ref: CodeRef) { return ref; }"],
		["README.md", "See the collectStories function for details."],
	]),
	packageNames: new Set(["@draht/reels"]),
	topLevelDirs: new Set(["src", "app"]),
};

describe("isAnchorValid", () => {
	test("a path anchor is valid for a changed or context path", () => {
		expect(isAnchorValid({ kind: "path", value: "src/foo.ts" }, ctx)).toBe(true);
		expect(isAnchorValid({ kind: "path", value: "README.md" }, ctx)).toBe(true);
	});

	test("a path anchor absent from changed and context paths is invalid", () => {
		expect(isAnchorValid({ kind: "path", value: "src/never-touched.ts" }, ctx)).toBe(false);
	});

	test("a symbol anchor is valid when it appears (word-bounded) in a known file's text", () => {
		expect(isAnchorValid({ kind: "symbol", value: "resolveCodeRef" }, ctx)).toBe(true);
		expect(isAnchorValid({ kind: "symbol", value: "collectStories" }, ctx)).toBe(true);
	});

	test("a symbol anchor absent from every source's text is invalid", () => {
		expect(isAnchorValid({ kind: "symbol", value: "neverWritten" }, ctx)).toBe(false);
	});

	test("a symbol anchor must match a whole word, not a substring", () => {
		expect(isAnchorValid({ kind: "symbol", value: "resolveCode" }, ctx)).toBe(false);
	});

	test("a component anchor is valid for a known package name or top-level dir", () => {
		expect(isAnchorValid({ kind: "component", value: "@draht/reels" }, ctx)).toBe(true);
		expect(isAnchorValid({ kind: "component", value: "src" }, ctx)).toBe(true);
		expect(isAnchorValid({ kind: "component", value: "packages/unknown" }, ctx)).toBe(false);
	});

	test("an empty symbol anchor is invalid (the old /\\b\\b/ bug matched anything)", () => {
		expect(isAnchorValid({ kind: "symbol", value: "" }, ctx)).toBe(false);
	});

	test("a symbol anchor shorter than 3 characters is invalid", () => {
		expect(isAnchorValid({ kind: "symbol", value: "fn" }, ctx)).toBe(false);
	});

	test("a language keyword is never a valid symbol anchor, even if it appears in the text", () => {
		const keywordCtx: AnchorContext = {
			...ctx,
			textByPath: new Map([["src/foo.ts", "export function resolveCodeRef(ref) { return ref; }"]]),
		};
		for (const keyword of ["const", "function", "return", "if", "this", "async", "await"]) {
			expect(isAnchorValid({ kind: "symbol", value: keyword }, keywordCtx)).toBe(false);
		}
	});

	test("a symbol anchor starting with - or / matches as a whole token (CLI flags, /commands)", () => {
		const flagCtx: AnchorContext = {
			...ctx,
			textByPath: new Map([["docs/cli.md", "Run with --output=x to force, or use --force, or /help."]]),
		};
		expect(isAnchorValid({ kind: "symbol", value: "--output" }, flagCtx)).toBe(true);
		expect(isAnchorValid({ kind: "symbol", value: "--force" }, flagCtx)).toBe(true);
		expect(isAnchorValid({ kind: "symbol", value: "/help" }, flagCtx)).toBe(true);
		expect(isAnchorValid({ kind: "symbol", value: "--missing" }, flagCtx)).toBe(false);
	});
});

function node(id: string, anchorValue: string, caption = "does something") {
	return { id, anchor: { kind: "symbol" as const, value: anchorValue }, caption };
}

describe("validateAndEmitDiagram", () => {
	test("a node whose anchor symbol is absent from the sources is dropped, not rejected, when enough others are valid", () => {
		const diagram: RawDiagram = {
			nodes: [
				node("a", "resolveCodeRef"),
				node("b", "collectStories"),
				node("c", "neverWritten"),
				node("d", "resolveCodeRef"),
			],
			edges: [],
		};
		const result = validateAndEmitDiagram(diagram, ctx);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.droppedIds).toEqual(["c"]);
			expect(result.idMap.has("c")).toBe(false);
			expect(result.idMap.size).toBe(3);
		}
	});

	test("2 of 5 nodes with an invalid anchor rejects the whole diagram", () => {
		const diagram: RawDiagram = {
			nodes: [
				node("a", "resolveCodeRef"),
				node("b", "collectStories"),
				node("c", "neverWritten1"),
				node("d", "neverWritten2"),
				node("e", "resolveCodeRef"),
			],
			edges: [],
		};
		const result = validateAndEmitDiagram(diagram, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.droppedIds.sort()).toEqual(["c", "d"]);
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});

	test("fewer than 3 valid nodes rejects even when none are dropped", () => {
		const diagram: RawDiagram = { nodes: [node("a", "resolveCodeRef"), node("b", "collectStories")], edges: [] };
		const result = validateAndEmitDiagram(diagram, ctx);
		expect(result.ok).toBe(false);
	});

	test("emits Mermaid with pipeline-generated node ids, never the model's own id strings, so a click/style directive in a model id cannot reach the output", () => {
		const diagram: RawDiagram = {
			nodes: [
				node("click Y call evil()", "resolveCodeRef", "does X"),
				node("b", "collectStories", "collects Y"),
				node("c", "resolveCodeRef", "does Z"),
			],
			edges: [{ from: "click Y call evil()", to: "b", label: "feeds" }],
		};
		const result = validateAndEmitDiagram(diagram, ctx);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mermaid).not.toContain("click Y call evil()");
			expect(result.mermaid).toContain("n0");
			expect(result.mermaid).toContain("n0 -->|feeds| n1");
		}
	});

	test("more than 9 (MAX_NODES) offered nodes rejects the whole diagram, even if all are valid", () => {
		const diagram: RawDiagram = {
			nodes: Array.from({ length: 10 }, (_, i) => node(`n${i}`, "resolveCodeRef")),
			edges: [],
		};
		const result = validateAndEmitDiagram(diagram, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.rule === "anchors" && e.detail.includes("9-node cap"))).toBe(true);
		}
	});

	test("a deny pattern in a caption rejects the diagram", () => {
		const diagram: RawDiagram = {
			nodes: [
				node("a", "resolveCodeRef", "Acme Corp internal"),
				node("b", "collectStories", "collects Y"),
				node("c", "resolveCodeRef", "does Z"),
			],
			edges: [],
		};
		const result = validateAndEmitDiagram(diagram, ctx, [/acme corp/i]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.rule === "prose")).toBe(true);
		}
	});

	test("a deny pattern in an edge label rejects the diagram", () => {
		const diagram: RawDiagram = {
			nodes: [node("a", "resolveCodeRef"), node("b", "collectStories"), node("c", "resolveCodeRef")],
			edges: [{ from: "a", to: "b", label: "feeds Acme Corp" }],
		};
		const result = validateAndEmitDiagram(diagram, ctx, [/acme corp/i]);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.rule === "prose")).toBe(true);
		}
	});

	test("edges referencing a dropped node are not emitted", () => {
		const diagram: RawDiagram = {
			nodes: [
				node("a", "resolveCodeRef"),
				node("b", "collectStories"),
				node("c", "neverWritten"),
				node("d", "resolveCodeRef"),
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
			],
		};
		const result = validateAndEmitDiagram(diagram, ctx);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mermaid).toContain("-->");
			expect(result.mermaid.split("\n").filter((l) => l.includes("-->"))).toHaveLength(1);
		}
	});
});
