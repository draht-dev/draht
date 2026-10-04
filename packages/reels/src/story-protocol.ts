/**
 * Shape of the LLM writer's JSON response for `--unit story`, and
 * hand-written guards that parse it (in the style of `script.ts`'s
 * `parseLlmResponse`; no schema-validation dependency). A short and a deep
 * dive use the same shape, with more sections and code scenes allowed. The
 * model supplies line *numbers* and anchor *values*, never code or diagram
 * text itself — `code-ref.ts` and `anchored-diagram.ts` resolve those
 * against real sources.
 */

import type { DiagramEdge, DiagramNode } from "./anchored-diagram.ts";
import type { Section } from "./contract.ts";

export type ClaimKind = "why" | "what" | "how" | "impact" | "meta";

export interface RawFocus {
	lines?: [number, number];
	nodes?: string[];
}

export interface RawBeat {
	text: string;
	focus?: RawFocus;
	claim: ClaimKind;
	cites: string[];
	quote?: string;
}

export interface RawDiffCode {
	path: string;
	ref: "diff";
	hunk: number;
	lines: [number, number];
}

export interface RawHeadCode {
	path: string;
	ref: "head";
	lines: [number, number];
}

export type RawCode = RawDiffCode | RawHeadCode;

export interface RawDiagram {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
}

export interface RawScene {
	section: Section;
	heading?: string;
	code?: RawCode;
	diagram?: RawDiagram;
	beats: RawBeat[];
}

export interface RawSummary {
	text: string;
	cites: string[];
}

export interface RawWriterResponse {
	title: string;
	subtitle: string;
	summary: RawSummary;
	theme?: string;
	scenes: RawScene[];
}

const SECTIONS: ReadonlySet<Section> = new Set([
	"hook",
	"problem",
	"idea",
	"mechanism",
	"code",
	"impact",
	"tradeoffs",
	"alternatives",
	"edge-cases",
	"overview",
	"theme",
	"outro",
]);

const CLAIMS: ReadonlySet<ClaimKind> = new Set(["why", "what", "how", "impact", "meta"]);

class ShapeError extends Error {}

function fail(detail: string): never {
	throw new ShapeError(`story writer: ${detail}`);
}

/** Models often wrap JSON in a Markdown code fence despite being told not to. */
export function stripCodeFence(raw: string): string {
	const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
	return fenced ? fenced[1] : raw;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
	return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string {
	if (typeof value !== "string") fail(`${where} must be a string`);
	return value;
}

function asStringArray(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) fail(`${where} must be an array of strings`);
	return value as string[];
}

function asLineRange(value: unknown, where: string): [number, number] {
	if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "number")) {
		fail(`${where} must be a [number, number] range`);
	}
	return [value[0] as number, value[1] as number];
}

function parseFocus(value: unknown, where: string): RawFocus | undefined {
	if (value === undefined) return undefined;
	const obj = asRecord(value, where);
	if (obj.lines !== undefined) return { lines: asLineRange(obj.lines, `${where}.lines`) };
	if (obj.nodes !== undefined) return { nodes: asStringArray(obj.nodes, `${where}.nodes`) };
	return undefined;
}

function parseBeat(value: unknown, where: string): RawBeat {
	const obj = asRecord(value, where);
	const claim = asString(obj.claim, `${where}.claim`);
	if (!CLAIMS.has(claim as ClaimKind)) fail(`${where}.claim must be one of ${[...CLAIMS].join("|")}, got ${claim}`);
	return {
		text: asString(obj.text, `${where}.text`),
		focus: parseFocus(obj.focus, `${where}.focus`),
		claim: claim as ClaimKind,
		cites: obj.cites === undefined ? [] : asStringArray(obj.cites, `${where}.cites`),
		quote: obj.quote === undefined ? undefined : asString(obj.quote, `${where}.quote`),
	};
}

function parseCode(value: unknown, where: string): RawCode | undefined {
	if (value === undefined) return undefined;
	const obj = asRecord(value, where);
	const path = asString(obj.path, `${where}.path`);
	const ref = asString(obj.ref, `${where}.ref`);
	const lines = asLineRange(obj.lines, `${where}.lines`);
	if (ref === "diff") {
		if (typeof obj.hunk !== "number") fail(`${where}.hunk must be a number for a diff ref`);
		return { path, ref: "diff", hunk: obj.hunk, lines };
	}
	if (ref === "head") return { path, ref: "head", lines };
	fail(`${where}.ref must be "diff" or "head", got ${ref}`);
}

function parseAnchor(value: unknown, where: string): DiagramNode["anchor"] {
	const obj = asRecord(value, where);
	const kind = asString(obj.kind, `${where}.kind`);
	if (kind !== "path" && kind !== "symbol" && kind !== "component") {
		fail(`${where}.kind must be "path", "symbol", or "component", got ${kind}`);
	}
	return { kind, value: asString(obj.value, `${where}.value`) };
}

function parseDiagramNode(value: unknown, where: string): DiagramNode {
	const obj = asRecord(value, where);
	return {
		id: asString(obj.id, `${where}.id`),
		anchor: parseAnchor(obj.anchor, `${where}.anchor`),
		caption: asString(obj.caption, `${where}.caption`),
	};
}

function parseDiagramEdge(value: unknown, where: string): DiagramEdge {
	const obj = asRecord(value, where);
	return {
		from: asString(obj.from, `${where}.from`),
		to: asString(obj.to, `${where}.to`),
		label: obj.label === undefined ? undefined : asString(obj.label, `${where}.label`),
	};
}

function parseDiagram(value: unknown, where: string): RawDiagram | undefined {
	if (value === undefined) return undefined;
	const obj = asRecord(value, where);
	if (!Array.isArray(obj.nodes)) fail(`${where}.nodes must be an array`);
	if (!Array.isArray(obj.edges)) fail(`${where}.edges must be an array`);
	return {
		nodes: obj.nodes.map((n, i) => parseDiagramNode(n, `${where}.nodes[${i}]`)),
		edges: obj.edges.map((e, i) => parseDiagramEdge(e, `${where}.edges[${i}]`)),
	};
}

function parseScene(value: unknown, where: string): RawScene {
	const obj = asRecord(value, where);
	const section = asString(obj.section, `${where}.section`);
	if (!SECTIONS.has(section as Section)) fail(`${where}.section is not a known section: ${section}`);
	if (!Array.isArray(obj.beats)) fail(`${where}.beats must be an array`);
	return {
		section: section as Section,
		heading: obj.heading === undefined ? undefined : asString(obj.heading, `${where}.heading`),
		code: parseCode(obj.code, `${where}.code`),
		diagram: parseDiagram(obj.diagram, `${where}.diagram`),
		beats: obj.beats.map((b, i) => parseBeat(b, `${where}.beats[${i}]`)),
	};
}

function parseSummary(value: unknown, where: string): RawSummary {
	const obj = asRecord(value, where);
	return {
		text: asString(obj.text, `${where}.text`),
		cites: obj.cites === undefined ? [] : asStringArray(obj.cites, `${where}.cites`),
	};
}

/** Parses and shape-checks the writer's raw JSON text. Throws a descriptive `Error` on any shape violation. */
export function parseWriterResponse(raw: string): RawWriterResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(raw));
	} catch (error) {
		fail(`response was not valid JSON: ${(error as Error).message}`);
	}
	const obj = asRecord(parsed, "response");
	if (!Array.isArray(obj.scenes)) fail("response.scenes must be an array");
	return {
		title: asString(obj.title, "response.title"),
		subtitle: asString(obj.subtitle, "response.subtitle"),
		summary: parseSummary(obj.summary, "response.summary"),
		theme: obj.theme === undefined ? undefined : asString(obj.theme, "response.theme"),
		scenes: obj.scenes.map((s, i) => parseScene(s, `response.scenes[${i}]`)),
	};
}
