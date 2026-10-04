/**
 * Runs every evidence rule against a shape-checked writer response and
 * either returns a valid {@link ReelScript} (with `beats` and `focus`
 * resolved to real sources) or a list of rule violations the writer can be
 * asked to repair. Pure: no git, no network. See contract.ts's evidence
 * rule and the plan's "Validation and the evidence rule" section.
 */

import type { AnchorContext } from "./anchored-diagram.ts";
import { validateAndEmitDiagram } from "./anchored-diagram.ts";
import type { CodeRef, HeadFileContent, ResolveCodeRefContext } from "./code-ref.ts";
import { resolveCodeRef } from "./code-ref.ts";
import type { Beat, CodeScene, DiagramScene, FileChange, Focus, ReelScript, Scene } from "./contract.ts";
import { redactText } from "./privacy.ts";
import type { SourceRegistry } from "./sources.ts";
import { getSource, isSourceAvailable, quoteOccursIn } from "./sources.ts";
import type { ClaimKind, RawBeat, RawScene, RawWriterResponse } from "./story-protocol.ts";
import { normalizeBeats } from "./tts.ts";

export interface ValidationError {
	path: string;
	rule: string;
	detail: string;
}

export interface ValidationContext {
	files: FileChange[];
	headFiles: ReadonlyMap<string, HeadFileContent>;
	sources: SourceRegistry;
	anchors: AnchorContext;
	headSha: string;
	isDeepDive: boolean;
	/** Short: 18 lines; deep dive: 30 (per the plan). */
	maxCodeLines: number;
	/** `prose.denyPatterns` (customer names, internal codenames); matches reject the whole script. */
	denyPatterns?: RegExp[];
}

export interface ValidateStoryScriptResult {
	script?: ReelScript;
	errors: ValidationError[];
	/** Non-blocking removals: dropped diagram node ids, stripped focus. */
	dropped: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

function stripUrls(text: string): string {
	return text
		.replace(URL_RE, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

const UNKNOWN_REASON_RE =
	/\b(does not|doesn't|do not|don't)\s+(say|record|explain)\b|\bnot recorded\b|\bisn't recorded\b|\bno recorded reason\b/i;

function admitsUnknownReason(text: string): boolean {
	return UNKNOWN_REASON_RE.test(text);
}

function proseViolatesDenyPatterns(text: string, denyPatterns: RegExp[] | undefined): boolean {
	if (!denyPatterns || denyPatterns.length === 0) return false;
	return denyPatterns.some((pattern) => pattern.test(text));
}

/** `redactText`, then owner decision Q7: URLs are always stripped from narration and prose fields. */
function cleanProse(text: string): string {
	return stripUrls(redactText(text));
}

function toCodeRef(code: RawScene["code"]): CodeRef | undefined {
	if (!code) return undefined;
	if (code.ref === "diff") return { path: code.path, ref: "diff", hunkIndex: code.hunk, lines: code.lines };
	return { path: code.path, ref: "head", lines: code.lines };
}

interface SceneValidation {
	scene?: Scene;
	errors: ValidationError[];
	dropped: string[];
}

function validateCitations(beat: RawBeat, beatPath: string, sources: SourceRegistry): { errors: ValidationError[] } {
	const errors: ValidationError[] = [];
	for (const id of beat.cites) {
		if (!isSourceAvailable(sources, id)) {
			errors.push({
				path: `${beatPath}.cites`,
				rule: "citations",
				detail: `cite ${id} does not exist in the source registry, or was truncated before the model saw it`,
			});
		}
	}

	const needsGrounding: ClaimKind[] = ["why", "impact"];
	if (needsGrounding.includes(beat.claim) && !admitsUnknownReason(beat.text)) {
		if (beat.cites.length === 0) {
			errors.push({ path: beatPath, rule: "citations", detail: `a "${beat.claim}" beat needs at least one cite` });
		} else if (!beat.quote) {
			errors.push({ path: beatPath, rule: "citations", detail: `a "${beat.claim}" beat needs a quote` });
		} else {
			const matches = beat.cites.some((id) => {
				const record = getSource(sources, id);
				return record !== undefined && record.included !== false && quoteOccursIn(beat.quote ?? "", record.text);
			});
			if (!matches) {
				errors.push({
					path: `${beatPath}.quote`,
					rule: "citations",
					detail: "quote does not occur in any cited source's text",
				});
			}
		}
	}

	return { errors };
}

function resolveFocus(
	raw: RawBeat["focus"],
	scenePath: string,
	kind: Scene["kind"],
	codeLineCount: number | undefined,
	diagramIdMap: ReadonlyMap<string, string> | undefined,
	dropped: string[],
): Focus | undefined {
	if (!raw) return undefined;
	if (raw.lines) {
		if (kind !== "code" || codeLineCount === undefined) {
			dropped.push(`${scenePath}.beats[].focus.lines (scene kind "${kind}" has no lines)`);
			return undefined;
		}
		const [a, b] = raw.lines;
		if (a < 1 || b < a || b > codeLineCount) {
			dropped.push(`${scenePath}.beats[].focus.lines (out of [1,${codeLineCount}])`);
			return undefined;
		}
		return { lines: [a, b] };
	}
	if (raw.nodes) {
		if (kind !== "diagram" || !diagramIdMap) {
			dropped.push(`${scenePath}.beats[].focus.nodes (scene kind "${kind}" has no diagram)`);
			return undefined;
		}
		const mapped = raw.nodes.map((id) => diagramIdMap.get(id)).filter((id): id is string => id !== undefined);
		if (mapped.length === 0) {
			dropped.push(`${scenePath}.beats[].focus.nodes (none map to a valid diagram node)`);
			return undefined;
		}
		return { nodes: mapped };
	}
	return undefined;
}

function validateScene(raw: RawScene, index: number, ctx: ValidationContext): SceneValidation {
	const scenePath = `scenes[${index}]`;
	const errors: ValidationError[] = [];
	const dropped: string[] = [];

	let codeScene: CodeScene | undefined;
	if (raw.code) {
		const codeRef = toCodeRef(raw.code);
		const resolveCtx: ResolveCodeRefContext = { files: ctx.files, headFiles: ctx.headFiles };
		const result = resolveCodeRef(
			codeRef as CodeRef,
			resolveCtx,
			{ maxLines: ctx.maxCodeLines, allowContextOnlyHead: ctx.isDeepDive },
			ctx.headSha,
		);
		if (!result.ok) {
			errors.push({ path: `${scenePath}.code`, rule: "code", detail: result.error });
		} else {
			codeScene = {
				kind: "code",
				path: result.code.path,
				language: languageForPath(result.code.path),
				hunkHeader: result.code.hunkHeader,
				lines: result.code.lines,
				origin: result.code.origin,
				...(result.code.startLine !== undefined ? { startLine: result.code.startLine } : {}),
				...(result.code.origin === "head" ? { ref: ctx.headSha.slice(0, 12) } : {}),
				narration: "",
			};
		}
	}

	let diagramScene: DiagramScene | undefined;
	let diagramIdMap: ReadonlyMap<string, string> | undefined;
	if (raw.diagram) {
		const result = validateAndEmitDiagram(raw.diagram, ctx.anchors);
		dropped.push(...result.droppedIds.map((id) => `${scenePath}.diagram.nodes[id=${id}]`));
		if (!result.ok) {
			errors.push(...result.errors.map((detail) => ({ path: `${scenePath}.diagram`, rule: "anchors", detail })));
		} else {
			diagramIdMap = result.idMap;
			diagramScene = { kind: "diagram", mermaid: result.mermaid, narration: "" };
		}
	}

	if (raw.heading !== undefined && proseViolatesDenyPatterns(raw.heading, ctx.denyPatterns)) {
		errors.push({ path: `${scenePath}.heading`, rule: "prose", detail: "heading matches a deny pattern" });
	}

	const beats: Beat[] = [];
	raw.beats.forEach((rawBeat, beatIndex) => {
		const beatPath = `${scenePath}.beats[${beatIndex}]`;
		if (proseViolatesDenyPatterns(rawBeat.text, ctx.denyPatterns)) {
			errors.push({ path: beatPath, rule: "prose", detail: "beat text matches a deny pattern" });
			return;
		}
		const { errors: citeErrors } = validateCitations(rawBeat, beatPath, ctx.sources);
		errors.push(...citeErrors);

		const focus = resolveFocus(
			rawBeat.focus,
			scenePath,
			codeScene ? "code" : diagramScene ? "diagram" : raw.code || raw.diagram ? "code" : "title",
			codeScene?.lines.length,
			diagramIdMap,
			dropped,
		);

		beats.push({ text: cleanProse(rawBeat.text), ...(focus ? { focus } : {}), cites: rawBeat.cites });
	});

	if (errors.length > 0) return { errors, dropped };

	const baseScene: Scene = codeScene ??
		diagramScene ?? { kind: "title", title: raw.heading ?? "", subtitle: "", narration: "" };
	const withBeats = { ...baseScene, beats, section: raw.section, narration: "" } as Scene;
	const normalized = normalizeBeats(withBeats);

	return { scene: normalized, errors: [], dropped };
}

const EXTENSION_LANGUAGE: Record<string, string> = {
	ts: "ts",
	tsx: "tsx",
	js: "js",
	jsx: "jsx",
	json: "json",
	md: "md",
	py: "python",
	go: "go",
	rs: "rust",
	java: "java",
	rb: "ruby",
	yml: "yaml",
	yaml: "yaml",
	css: "css",
	html: "html",
	sh: "bash",
};

function languageForPath(path: string): string {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return "text";
	return EXTENSION_LANGUAGE[path.slice(dot + 1).toLowerCase()] ?? "text";
}

/**
 * Validates a shape-checked writer response and either returns a valid
 * {@link ReelScript}, or a non-empty `errors` list (and no `script`) usable
 * as repair feedback. `dropped` always lists non-blocking removals (invalid
 * diagram nodes, stripped focus) regardless of whether the script was
 * otherwise valid.
 */
export function validateStoryScript(
	raw: RawWriterResponse,
	ctx: ValidationContext,
	headSha: string,
): ValidateStoryScriptResult {
	const errors: ValidationError[] = [];
	const dropped: string[] = [];

	if (
		proseViolatesDenyPatterns(raw.title, ctx.denyPatterns) ||
		proseViolatesDenyPatterns(raw.subtitle, ctx.denyPatterns)
	) {
		errors.push({ path: "title", rule: "prose", detail: "title or subtitle matches a deny pattern" });
	}

	for (const id of raw.summary.cites) {
		if (!isSourceAvailable(ctx.sources, id)) {
			errors.push({
				path: "summary.cites",
				rule: "citations",
				detail: `cite ${id} does not exist or was truncated`,
			});
		}
	}

	const scenes: Scene[] = [];
	raw.scenes.forEach((rawScene, index) => {
		const result = validateScene(rawScene, index, ctx);
		dropped.push(...result.dropped);
		errors.push(...result.errors);
		if (result.scene) scenes.push(result.scene);
	});

	if (raw.scenes.length === 0) {
		errors.push({ path: "scenes", rule: "arc", detail: "a script needs at least one scene" });
	}

	if (errors.length > 0) return { errors, dropped };

	const script: ReelScript = { changeSetId: headSha, writer: "llm", scenes };
	return { script, errors: [], dropped };
}
