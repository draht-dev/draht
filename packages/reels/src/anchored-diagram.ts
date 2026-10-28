/**
 * Validates a writer-chosen diagram against the real anchors it is allowed
 * to name, then emits Mermaid itself. The model never writes raw Mermaid
 * (which could carry `click`/`style`/init-block injection): it returns
 * structured nodes and edges, and only the pipeline turns those into text,
 * using pipeline-generated node ids rather than the model's own id strings.
 */

import { escapeMermaidLabel } from "./diagram.ts";
import { cleanProse, proseViolatesDenyPatterns } from "./sources.ts";

export type AnchorKind = "path" | "symbol" | "component";

export interface DiagramAnchor {
	kind: AnchorKind;
	value: string;
}

export interface DiagramNode {
	id: string;
	anchor: DiagramAnchor;
	caption: string;
}

export interface DiagramEdge {
	from: string;
	to: string;
	label?: string;
}

export interface RawDiagram {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
}

/** What a node's `anchor` is checked against. All sets hold exact, case-sensitive values. */
export interface AnchorContext {
	/** Paths changed by this story. */
	changedPaths: ReadonlySet<string>;
	/** Paths of context files available to the writer (docs, key files) but not changed. */
	contextPaths: ReadonlySet<string>;
	/** Non-withheld diff text (any marker) and head content, concatenated per path, searched for `symbol` anchors. */
	textByPath: ReadonlyMap<string, string>;
	/** Workspace package names, e.g. `@draht/reels`, from a changed `packages/x/package.json` or path prefix `packages/x/`. */
	packageNames: ReadonlySet<string>;
	/** Top-level directories of changed paths. */
	topLevelDirs: ReadonlySet<string>;
}

const MAX_NODES = 9;
const MIN_NODES = 3;
const MAX_CAPTION_WORDS = 5;
const MAX_EDGE_LABEL_WORDS = 4;
/** More than this fraction of nodes dropped rejects the whole diagram. */
const MAX_DROPPED_FRACTION = 1 / 3;

function capWords(text: string, maxWords: number): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	return words.length <= maxWords ? words.join(" ") : words.slice(0, maxWords).join(" ");
}

/**
 * Matches `value` as a whole token: `\b` fails for a value starting or ending with `-` or `/` (CLI flags,
 * `/commands`), since those are not word characters, so the boundary is instead "not another token character"
 * (`[\w\-/]`) on each side rather than a strict `\b`.
 */
function symbolPattern(value: string): RegExp {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\w\\-/])${escaped}(?![\\w\\-/])`);
}

const SYMBOL_KEYWORDS = new Set([
	"const",
	"function",
	"return",
	"class",
	"def",
	"import",
	"export",
	"if",
	"else",
	"for",
	"while",
	"true",
	"false",
	"null",
	"none",
	"self",
	"this",
	"let",
	"var",
	"async",
	"await",
]);

export function isAnchorValid(anchor: DiagramAnchor, ctx: AnchorContext): boolean {
	switch (anchor.kind) {
		case "path":
			return ctx.changedPaths.has(anchor.value) || ctx.contextPaths.has(anchor.value);
		case "component":
			return ctx.packageNames.has(anchor.value) || ctx.topLevelDirs.has(anchor.value);
		case "symbol": {
			if (anchor.value.length < 3 || SYMBOL_KEYWORDS.has(anchor.value)) return false;
			const pattern = symbolPattern(anchor.value);
			for (const text of ctx.textByPath.values()) {
				if (pattern.test(text)) return true;
			}
			return false;
		}
		default:
			return false;
	}
}

export interface AnchoredDiagramAccepted {
	ok: true;
	mermaid: string;
	/** Maps the model's original node id to the pipeline-generated id used in the emitted Mermaid, for every surviving node. */
	idMap: ReadonlyMap<string, string>;
	/** Model node ids dropped for an invalid anchor (not an error; the diagram still rendered). */
	droppedIds: string[];
}

export interface DiagramError {
	rule: "anchors" | "prose";
	detail: string;
}

export interface AnchoredDiagramRejected {
	ok: false;
	errors: DiagramError[];
	droppedIds: string[];
}

export type AnchoredDiagramResult = AnchoredDiagramAccepted | AnchoredDiagramRejected;

/**
 * Drops nodes with an invalid anchor (and the edges touching them); rejects
 * the whole diagram when more than {@link MAX_NODES} nodes were offered,
 * fewer than {@link MIN_NODES} valid nodes remain, or more than a third of
 * the original nodes were dropped. Every caption, edge label, and anchor
 * value used as a label goes through `cleanProse` and `denyPatterns` before
 * being emitted; a deny-pattern match rejects the whole diagram. On success,
 * emits `graph TD` Mermaid from only the validated nodes/edges, with ids the
 * pipeline generates (`n0`, `n1`, ...), never the model's own id strings.
 */
export function validateAndEmitDiagram(
	diagram: RawDiagram,
	ctx: AnchorContext,
	denyPatterns?: RegExp[],
): AnchoredDiagramResult {
	const totalNodes = diagram.nodes.length;
	if (totalNodes > MAX_NODES) {
		return {
			ok: false,
			errors: [{ rule: "anchors", detail: `diagram: ${totalNodes} nodes exceeds the ${MAX_NODES}-node cap` }],
			droppedIds: [],
		};
	}

	const seenIds = new Set<string>();
	const validNodes: DiagramNode[] = [];
	const droppedIds: string[] = [];

	for (const node of diagram.nodes) {
		if (seenIds.has(node.id)) {
			droppedIds.push(node.id);
			continue;
		}
		seenIds.add(node.id);
		if (isAnchorValid(node.anchor, ctx)) {
			validNodes.push(node);
		} else {
			droppedIds.push(node.id);
		}
	}

	const droppedFraction = totalNodes === 0 ? 1 : droppedIds.length / totalNodes;
	if (validNodes.length < MIN_NODES || droppedFraction > MAX_DROPPED_FRACTION) {
		return {
			ok: false,
			errors: [
				{
					rule: "anchors",
					detail: `diagram: only ${validNodes.length}/${totalNodes} node(s) have a valid anchor (minimum ${MIN_NODES}, at most ${Math.floor(MAX_DROPPED_FRACTION * 100)}% may be dropped)`,
				},
			],
			droppedIds,
		};
	}

	const proseErrors: DiagramError[] = [];
	function label(text: string, where: string): string {
		const cleaned = cleanProse(text);
		if (proseViolatesDenyPatterns(cleaned, denyPatterns)) {
			proseErrors.push({ rule: "prose", detail: `${where} matches a deny pattern: ${JSON.stringify(text)}` });
		}
		return cleaned;
	}

	const idMap = new Map<string, string>();
	validNodes.forEach((node, i) => {
		idMap.set(node.id, `n${i}`);
	});

	const lines: string[] = ["graph TD"];
	for (const node of validNodes) {
		const pipelineId = idMap.get(node.id);
		const caption = escapeMermaidLabel(
			capWords(label(node.caption, `diagram node ${node.id} caption`), MAX_CAPTION_WORDS),
		);
		const anchorValue = escapeMermaidLabel(label(node.anchor.value, `diagram node ${node.id} anchor value`));
		lines.push(`${pipelineId}["${caption}\n${anchorValue}"]`);
	}
	for (const edge of diagram.edges) {
		const from = idMap.get(edge.from);
		const to = idMap.get(edge.to);
		if (!from || !to) continue;
		if (edge.label) {
			const edgeLabel = capWords(label(edge.label, `edge ${edge.from}->${edge.to} label`), MAX_EDGE_LABEL_WORDS);
			lines.push(`${from} -->|${escapeMermaidLabel(edgeLabel)}| ${to}`);
		} else {
			lines.push(`${from} --> ${to}`);
		}
	}

	if (proseErrors.length > 0) {
		return { ok: false, errors: proseErrors, droppedIds };
	}

	return { ok: true, mermaid: lines.join("\n"), idMap, droppedIds };
}

export { MAX_NODES as MAX_DIAGRAM_NODES, MIN_NODES as MIN_DIAGRAM_NODES };
