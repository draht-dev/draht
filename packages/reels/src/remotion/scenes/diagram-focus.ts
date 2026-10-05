/**
 * Pure helpers for beat-driven diagram focus: parsed from the rendered
 * Mermaid SVG *string*, and turned into a `<style>` block rather than
 * imperative DOM mutation. Remotion's frame capture only reliably waits for
 * work gated behind `delayRender`/`continueRender`; a plain `useLayoutEffect`
 * mutating the already-mounted SVG races the screenshot and can be missed
 * entirely. Computing a style string during the normal render pass (like any
 * other frame-dependent prop) does not have that race.
 */

import type { Beat } from "../../contract.ts";
import { COLOR } from "../theme.ts";

export const DIMMED_NODE_OPACITY = 0.25;
export const DIMMED_EDGE_OPACITY = 0.25;
/** The signal accent for a focused node/edge — Solder Copper, per the Copper Scarcity Rule. */
export const FOCUS_ACCENT = COLOR.solderCopper;

export interface SvgNode {
	domId: string;
	/** The Mermaid node id declared in the diagram source (e.g. `A`), parsed from the end of `domId`. */
	nodeId: string | undefined;
}

export interface SvgEdge {
	/** The rendered `<path>`'s own `id` attribute (prefixed by the per-render diagram id). */
	domId: string;
	/** The edge's mermaid id (`getEdgeId`'s `L_<from>_<to>_<counter>`), shared verbatim with its `g.label`. */
	dataId: string;
}

function attr(tag: string, name: string): string | undefined {
	return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

/** Decodes the handful of entities d3/mermaid may use when serializing attribute values. */
function decodeHtmlEntities(text: string): string {
	return text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => {
		switch (entity) {
			case "&amp;":
				return "&";
			case "&lt;":
				return "<";
			case "&gt;":
				return ">";
			case "&quot;":
				return '"';
			default:
				return "'";
		}
	});
}

/** Escapes a value for use inside a quoted CSS attribute selector (`[data-id="..."]`), after HTML-decoding it. */
function escapeCssAttrValue(raw: string): string {
	return decodeHtmlEntities(raw).replace(/[\\"]/g, (ch) => `\\${ch}`);
}

/** CSS identifier escape for use after `#` (`CSS.escape` is a browser global, unavailable in the test runtime), after HTML-decoding the source value. */
function escapeCssId(raw: string): string {
	return decodeHtmlEntities(raw).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

/**
 * Mermaid's rendered node domId is `<diagramRenderId>-flowchart-<nodeId>-<counter>`
 * (`flowchart-` is `MERMAID_DOM_ID_PREFIX` in mermaid's flow renderer, prefixed
 * by the id passed to `mermaid.render`). Matched from the end so the
 * per-render random prefix doesn't matter.
 */
export function mermaidNodeIdFromDomId(domId: string): string | undefined {
	return decodeHtmlEntities(domId).match(/flowchart-(.+)-\d+$/)?.[1];
}

/** The rendered SVG root's own `id` (the id passed to `mermaid.render`), used to scope every selector below it. */
export function extractSvgRootId(svg: string): string | undefined {
	return svg.match(/<svg[^>]*\sid="([^"]*)"/)?.[1];
}

/** Parses each rendered node `<g class="node ...">` tag out of a Mermaid SVG string. */
export function extractSvgNodes(svg: string): SvgNode[] {
	const tags = svg.match(/<g class="node[^"]*"[^>]*>/g) ?? [];
	const seen = new Set<string>();
	const nodes: SvgNode[] = [];
	for (const tag of tags) {
		const domId = attr(tag, "id");
		if (domId === undefined || seen.has(domId)) continue;
		seen.add(domId);
		nodes.push({ domId, nodeId: mermaidNodeIdFromDomId(domId) });
	}
	return nodes;
}

/** Parses each rendered edge `<path data-edge="true">` tag's dom id and mermaid data-id. */
export function extractSvgEdges(svg: string): SvgEdge[] {
	const tags = svg.match(/<path[^>]*>/g) ?? [];
	const edges: SvgEdge[] = [];
	for (const tag of tags) {
		if (!tag.includes('data-edge="true"')) continue;
		const domId = attr(tag, "id");
		const dataId = attr(tag, "data-id");
		if (domId !== undefined && dataId !== undefined) edges.push({ domId, dataId });
	}
	return edges;
}

/**
 * Parses each rendered edge label's `data-id` (mermaid's `insertEdgeLabel`
 * sets `<g class="label" data-id="<edgeId>">` on every edge, labelled or
 * not). The containing `g.edgeLabel` carries no id of its own, so this is
 * the only hook for selecting it.
 */
export function extractEdgeLabelDataIds(svg: string): string[] {
	const tags = svg.match(/<g class="label" data-id="[^"]*"[^>]*>/g) ?? [];
	return tags.map((tag) => attr(tag, "data-id")).filter((id): id is string => id !== undefined);
}

/**
 * Resolves an edge's endpoints from its rendered `data-id`
 * (`getEdgeId`'s `L_<from>_<to>_<counter>`), matching against the *known*
 * node ids found in the same rendered SVG rather than re-parsing the
 * Mermaid source text. Source-text parsing shifts out of sync with the
 * rendered edges on anything the regex grammar doesn't cover — chains
 * (`A --> B --> C`), `&` fan-outs, `;`-separated statements, inline edge
 * text (`A -- yes --> B`), `:::class` suffixes — so it is not used here at
 * all. Node ids may themselves contain `_`, so candidates are tried
 * longest-first to avoid a short id swallowing part of a longer one.
 */
export function resolveEdgeEndpoints(
	dataId: string,
	nodeIds: readonly string[],
): { from: string; to: string } | undefined {
	const decoded = decodeHtmlEntities(dataId);
	const body = decoded.startsWith("L_") ? decoded.slice(2) : decoded;
	const candidates = [...new Set(nodeIds)].sort((a, b) => b.length - a.length);
	for (const from of candidates) {
		if (!body.startsWith(`${from}_`)) continue;
		const rest = body.slice(from.length + 1);
		for (const to of candidates) {
			if (!rest.startsWith(`${to}_`)) continue;
			const counter = rest.slice(to.length + 1);
			if (/^\d+$/.test(counter)) return { from, to };
		}
	}
	return undefined;
}

/**
 * Builds the CSS for the active beat: focused nodes get the accent stroke
 * and a glow; nodes no beat up to `beatIndex` has mentioned are
 * dimmed, and so are edges (and their labels) whose endpoints aren't
 * revealed yet. Once the last beat starts, every node and edge is revealed
 * regardless of whether any beat ever focused it — by the end of the
 * explanation the whole diagram should read normally, not stay dimmed
 * forever because, say, a branch was only ever shown, never narrated.
 * Produces no rules at all for a scene with no beats, before the first beat
 * starts (`beatIndex < 0`), or when no beat in the scene focuses any node
 * (nothing to dim against) — Mermaid's own styling applies unchanged.
 */
export function buildBeatFocusCss(svg: string, beats: Beat[] | undefined, beatIndex: number): string {
	if (!beats || beats.length === 0) return "";
	if (beatIndex < 0) return "";
	const anyFocusNodes = beats.some((beat) => (beat.focus?.nodes?.length ?? 0) > 0);
	if (!anyFocusNodes) return "";

	const nodes = extractSvgNodes(svg);
	const nodeIds = nodes.map((node) => node.nodeId).filter((id): id is string => id !== undefined);
	const rootId = extractSvgRootId(svg);
	const scope = rootId ? `#${escapeCssId(rootId)} ` : "";
	const isLastBeat = beatIndex === beats.length - 1;

	const revealed = new Set<string>();
	for (let i = 0; i <= beatIndex; i++) {
		for (const id of beats[i]?.focus?.nodes ?? []) revealed.add(id);
	}
	const focused = new Set(beats[beatIndex]?.focus?.nodes ?? []);

	const rules: string[] = [];
	for (const node of nodes) {
		const isRevealed = isLastBeat || node.nodeId === undefined || revealed.has(node.nodeId);
		const isFocused = node.nodeId !== undefined && focused.has(node.nodeId);
		const selector = `${scope}#${escapeCssId(node.domId)}`;
		if (isFocused) {
			// No scaling: dagre packs nodes tightly, so a scaled node covers its neighbours'
			// edges and labels. The accent stroke and glow mark focus without moving geometry.
			rules.push(
				`${selector}{opacity:1;filter:drop-shadow(0 0 14px ${FOCUS_ACCENT});}`,
				`${selector} rect,${selector} polygon,${selector} circle,${selector} path{stroke:${FOCUS_ACCENT} !important;stroke-width:3px !important;}`,
			);
		} else if (!isRevealed) {
			rules.push(`${selector}{opacity:${DIMMED_NODE_OPACITY};}`);
		}
	}

	const isEdgeRevealed = (dataId: string) => {
		if (isLastBeat) return true;
		const endpoints = resolveEdgeEndpoints(dataId, nodeIds);
		return !endpoints || (revealed.has(endpoints.from) && revealed.has(endpoints.to));
	};

	for (const edge of extractSvgEdges(svg)) {
		if (!isEdgeRevealed(edge.dataId))
			rules.push(`${scope}#${escapeCssId(edge.domId)}{opacity:${DIMMED_EDGE_OPACITY};}`);
	}

	for (const dataId of extractEdgeLabelDataIds(svg)) {
		if (!isEdgeRevealed(dataId)) {
			rules.push(`${scope}g.label[data-id="${escapeCssAttrValue(dataId)}"]{opacity:${DIMMED_EDGE_OPACITY};}`);
		}
	}

	return rules.join("");
}
