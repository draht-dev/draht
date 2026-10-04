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
