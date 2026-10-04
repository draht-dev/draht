import { describe, expect, test } from "bun:test";
import type { Beat } from "../src/contract.ts";
import {
	buildBeatFocusCss,
	extractEdgeLabelDataIds,
	extractSvgEdges,
	extractSvgNodes,
	extractSvgRootId,
	mermaidNodeIdFromDomId,
	resolveEdgeEndpoints,
} from "../src/remotion/scenes/diagram-focus.ts";

/** Builds a node `<g>` tag the way mermaid 12.1.0's flowchart-v2 renderer does. */
function nodeTag(renderId: string, nodeId: string, counter: number): string {
	return `<g class="node default" id="${renderId}-flowchart-${nodeId}-${counter}"><rect/><text>${nodeId}</text></g>`;
}

/** Builds an edge `<path>` + its `g.edgeLabel > g.label` the way mermaid renders every edge (`getEdgeId`: `L_<from>_<to>_<counter>`), labelled or not. */
function edgeTags(renderId: string, from: string, to: string, counter: number, label = ""): string {
	const dataId = `L_${from}_${to}_${counter}`;
	return [
		`<path d="M1,2L3,4" id="${renderId}-${dataId}" class="flowchart-link" data-edge="true" data-et="edge" data-id="${dataId}"/>`,
		`<g class="edgeLabel"><g class="label" data-id="${dataId}"><rect/><text>${label}</text></g></g>`,
	].join("");
}

const RENDER_ID = "reel-diagram-xyz";

function svg(...body: string[]): string {
	return [`<svg id="${RENDER_ID}" viewBox="0 0 400 300">`, '<g class="nodes">', ...body, "</svg>"].join("");
}

describe("mermaidNodeIdFromDomId", () => {
	test("strips the per-render prefix and trailing counter", () => {
		expect(mermaidNodeIdFromDomId(`${RENDER_ID}-flowchart-A-0`)).toBe("A");
	});

	test("returns undefined for an id with no flowchart- marker", () => {
		expect(mermaidNodeIdFromDomId("something-else")).toBeUndefined();
	});
});

describe("extractSvgRootId", () => {
	test("reads the id passed to mermaid.render off the root <svg>", () => {
		expect(extractSvgRootId(svg(nodeTag(RENDER_ID, "A", 0)))).toBe(RENDER_ID);
	});
});

describe("extractSvgNodes", () => {
	test("parses dom id and mermaid node id for each node", () => {
		const document = svg(nodeTag(RENDER_ID, "A", 0), nodeTag(RENDER_ID, "B", 1));
		expect(extractSvgNodes(document)).toEqual([
			{ domId: `${RENDER_ID}-flowchart-A-0`, nodeId: "A" },
			{ domId: `${RENDER_ID}-flowchart-B-1`, nodeId: "B" },
		]);
	});
});

describe("extractSvgEdges / extractEdgeLabelDataIds", () => {
	test("finds edge paths and their labels by data-id", () => {
		const document = svg(edgeTags(RENDER_ID, "A", "B", 0, "assertion fails"));
		expect(extractSvgEdges(document)).toEqual([{ domId: `${RENDER_ID}-L_A_B_0`, dataId: "L_A_B_0" }]);
		expect(extractEdgeLabelDataIds(document)).toEqual(["L_A_B_0"]);
	});
});

// Regression: parseMermaidEdges matched edges to the SVG by
// *position* in a regex-parsed copy of the mermaid source, which skips chains,
// `&` fan-outs, ids with `-`/`.`, `:::class`, inline edge text, and
// `;`-separated statements — any of those shift every edge after it out of
// sync, highlighting/dimming the wrong node for every later beat.
describe("resolveEdgeEndpoints (regression: resolve by data-id, not source position)", () => {
	test("resolves a plain edge", () => {
		expect(resolveEdgeEndpoints("L_A_B_0", ["A", "B"])).toEqual({ from: "A", to: "B" });
	});

	test("a chain (A --> B --> C) does not shift a later edge's resolved endpoints", () => {
		// The mermaid source `A --> B --> C` renders as two edges, L_A_B_0 and L_B_C_1 — no
		// textual "line" boundary a position-based parser could key off, so a source-regex
		// parser silently skips the whole statement and every edge declared after it drifts.
		expect(resolveEdgeEndpoints("L_A_B_0", ["A", "B", "C"])).toEqual({ from: "A", to: "B" });
		expect(resolveEdgeEndpoints("L_B_C_1", ["A", "B", "C"])).toEqual({ from: "B", to: "C" });
	});

	test("an `&` fan-out (A & B --> C) resolves each resulting edge correctly", () => {
		expect(resolveEdgeEndpoints("L_A_C_0", ["A", "B", "C"])).toEqual({ from: "A", to: "C" });
		expect(resolveEdgeEndpoints("L_B_C_1", ["A", "B", "C"])).toEqual({ from: "B", to: "C" });
	});

	test("node ids containing - or . resolve without being mistaken for a shorter prefix", () => {
		expect(resolveEdgeEndpoints("L_step-1_step.2_0", ["step-1", "step.2", "step"])).toEqual({
			from: "step-1",
			to: "step.2",
		});
	});

	test("a node id that is itself a prefix of another (dir / dir_0) resolves to the longer, exact match", () => {
		expect(resolveEdgeEndpoints("L_dir_dir_0_0", ["dir", "dir_0"])).toEqual({ from: "dir", to: "dir_0" });
	});

	test("an unresolvable data-id (unknown node ids) returns undefined rather than guessing", () => {
		expect(resolveEdgeEndpoints("L_X_Y_0", ["A", "B"])).toBeUndefined();
	});
});

describe("buildBeatFocusCss", () => {
	const nodes = [nodeTag(RENDER_ID, "A", 0), nodeTag(RENDER_ID, "B", 1), nodeTag(RENDER_ID, "C", 2)];

	test("produces no rules for a scene with no beats", () => {
		expect(buildBeatFocusCss(svg(...nodes), undefined, -1)).toBe("");
	});

	// Regression: beatIndex -1 (before the first beat, or no
	// transcript timing yet) must not dim every node — there is nothing "revealed"
	// yet by definition, which previously made the whole diagram read as dimmed.
	test("produces no rules before the first beat starts (beatIndex -1)", () => {
		const beats: Beat[] = [{ text: "first", focus: { nodes: ["A"] } }];
		expect(buildBeatFocusCss(svg(...nodes), beats, -1)).toBe("");
	});

	test("produces no rules when no beat in the scene focuses any node", () => {
		const beats: Beat[] = [{ text: "first" }, { text: "second", focus: { lines: [1, 2] } }];
		expect(buildBeatFocusCss(svg(...nodes), beats, 1)).toBe("");
	});

	test("dims nodes and edges not yet mentioned, and accents the focused node", () => {
		const beats: Beat[] = [
			{ text: "first", focus: { nodes: ["A"] } },
			{ text: "second", focus: { nodes: ["B"] } },
		];
		const document = svg(...nodes, edgeTags(RENDER_ID, "A", "B", 0, "assertion fails"));
		const css = buildBeatFocusCss(document, beats, 0);

		expect(css).toContain(`#${RENDER_ID} #${RENDER_ID}-flowchart-A-0{opacity:1;filter:`);
		expect(css).toContain(`#${RENDER_ID} #${RENDER_ID}-flowchart-B-1{opacity:0.25;}`);
		expect(css).toContain(`#${RENDER_ID} #${RENDER_ID}-flowchart-C-2{opacity:0.25;}`);
		expect(css).toContain(`#${RENDER_ID} #${RENDER_ID}-L_A_B_0{opacity:0.25;}`);
		expect(css).toContain(`#${RENDER_ID} g.label[data-id="L_A_B_0"]{opacity:0.25;}`);
	});

	test("keeps a node revealed once a later beat has moved on, and reveals the edge once both endpoints are mentioned", () => {
		const beats: Beat[] = [
			{ text: "first", focus: { nodes: ["A"] } },
			{ text: "second", focus: { nodes: ["B"] } },
			{ text: "third", focus: { nodes: ["C"] } },
		];
		const document = svg(...nodes, edgeTags(RENDER_ID, "A", "B", 0));
		const css = buildBeatFocusCss(document, beats, 1);

		expect(css).not.toContain(`${RENDER_ID}-flowchart-A-0{opacity:0.25`);
		expect(css).toContain(`#${RENDER_ID} #${RENDER_ID}-flowchart-B-1{opacity:1;filter:`);
		expect(css).not.toContain(`${RENDER_ID}-L_A_B_0{opacity:0.25`);
		expect(css).not.toContain('g.label[data-id="L_A_B_0"]{opacity:0.25');
	});

	// Regression: a node no beat ever focuses (e.g. a branch shown in the
	// diagram but never narrated) must still appear once the explanation is done,
	// not stay dimmed forever.
	test("reveals every node, including ones no beat ever focused, once the last beat starts", () => {
		const beats: Beat[] = [
			{ text: "first", focus: { nodes: ["A"] } },
			{ text: "second", focus: { nodes: ["B"] } },
		];
		// C is never in any beat's focus.nodes.
		const css = buildBeatFocusCss(svg(...nodes), beats, 1);
		expect(css).not.toContain(`${RENDER_ID}-flowchart-C-2{opacity:0.25`);
	});

	// Focused nodes must not change geometry: a CSS transform would override the node's
	// positional transform attribute, and scaling makes tightly packed nodes overlap.
	test("never emits transform or scale for focused nodes", () => {
		const beats: Beat[] = [{ text: "first", focus: { nodes: ["A"] } }];
		const css = buildBeatFocusCss(svg(...nodes), beats, 0);
		expect(css).not.toContain("transform:");
		expect(css).not.toContain("scale");
	});
});
