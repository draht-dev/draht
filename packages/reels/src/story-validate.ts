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
import type { Beat, CodeScene, DiagramScene, FileChange, Focus, ReelScript, Scene, Section } from "./contract.ts";
import type { SourceRegistry } from "./sources.ts";
import {
	cleanProse,
	getSource,
	headFileSourceId,
	hunkIndexSourceId,
	isSourceAvailable,
	proseViolatesDenyPatterns,
	quoteIsWellFormed,
	quoteOccursIn,
} from "./sources.ts";
import type { ClaimKind, RawBeat, RawCode, RawScene, RawWriterResponse } from "./story-protocol.ts";
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

/**
 * The ONE fixed sentence a `why`/`effect` beat may use, verbatim and alone, to admit that no source explains the
 * reason, instead of inventing one. A real claim plus a trailing hedge (e.g. "...; the commits don't say why")
 * no longer bypasses grounding — only this exact sentence, making up the whole beat text, does.
 */
export const REASON_NOT_RECORDED_TEXT: Record<"en" | "de", string> = {
	en: "The commits do not record why.",
	de: "Die Commits dokumentieren den Grund nicht.",
};

const REASON_NOT_RECORDED_SET = new Set(Object.values(REASON_NOT_RECORDED_TEXT));

function isReasonNotRecorded(text: string): boolean {
	return REASON_NOT_RECORDED_SET.has(text.trim());
}

function toCodeRef(code: RawScene["code"]): CodeRef | undefined {
	if (!code) return undefined;
	if (code.ref === "diff") return { path: code.path, ref: "diff", hunkIndex: code.hunk, lines: code.lines };
	return { path: code.path, ref: "head", lines: code.lines };
}

/** The source id implicitly behind a shown code scene: the hunk index entry for a diff ref, the head file for a head ref. */
function impliedCodeSourceId(code: RawCode | undefined): string | undefined {
	if (!code) return undefined;
	return code.ref === "diff" ? hunkIndexSourceId(code.path, code.hunk) : headFileSourceId(code.path);
}

interface SceneValidation {
	scene?: Scene;
	errors: ValidationError[];
	dropped: string[];
}

const MAX_BEATS_PER_SCENE = 8;
const MAX_BEAT_WORDS = 40;
const MAX_BEAT_CHARS = 280;

function validateCitations(
	beat: RawBeat,
	beatPath: string,
	sources: SourceRegistry,
	sceneIsGrounded: boolean,
): { errors: ValidationError[] } {
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

	const needsQuoteGrounding: ClaimKind[] = ["why", "effect"];
	if (needsQuoteGrounding.includes(beat.claim)) {
		if (isReasonNotRecorded(beat.text)) return { errors };
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
			} else if (!quoteIsWellFormed(beat.quote, beat.text)) {
				errors.push({
					path: `${beatPath}.quote`,
					rule: "citations",
					detail:
						"quote must be 4-25 words (or at least 20 characters if code-like) and share a content word with the beat text",
				});
			}
		}
	} else if (beat.claim !== "meta" && beat.cites.length === 0 && !sceneIsGrounded) {
		errors.push({ path: beatPath, rule: "citations", detail: `a "${beat.claim}" beat needs at least one cite` });
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
		const result = validateAndEmitDiagram(raw.diagram, ctx.anchors, ctx.denyPatterns);
		dropped.push(...result.droppedIds.map((id) => `${scenePath}.diagram.nodes[id=${id}]`));
		if (!result.ok) {
			errors.push(...result.errors.map((e) => ({ path: `${scenePath}.diagram`, rule: e.rule, detail: e.detail })));
		} else {
			diagramIdMap = result.idMap;
			diagramScene = { kind: "diagram", mermaid: result.mermaid, narration: "" };
		}
	}

	if (raw.heading !== undefined && proseViolatesDenyPatterns(cleanProse(raw.heading), ctx.denyPatterns)) {
		errors.push({ path: `${scenePath}.heading`, rule: "prose", detail: "heading matches a deny pattern" });
	}

	if (raw.beats.length === 0) {
		errors.push({ path: scenePath, rule: "beats", detail: "a scene needs at least one beat" });
	}
	if (raw.beats.length > MAX_BEATS_PER_SCENE) {
		errors.push({
			path: scenePath,
			rule: "beats",
			detail: `at most ${MAX_BEATS_PER_SCENE} beats per scene, got ${raw.beats.length}`,
		});
	}

	const impliedCiteId = codeScene ? impliedCodeSourceId(raw.code) : undefined;
	const sceneIsGrounded = Boolean(codeScene) || Boolean(diagramScene);

	const beats: Beat[] = [];
	raw.beats.forEach((rawBeat, beatIndex) => {
		const beatPath = `${scenePath}.beats[${beatIndex}]`;
		if (proseViolatesDenyPatterns(cleanProse(rawBeat.text), ctx.denyPatterns)) {
			errors.push({ path: beatPath, rule: "prose", detail: "beat text matches a deny pattern" });
			return;
		}

		const words = rawBeat.text.trim().split(/\s+/).filter(Boolean);
		if (words.length > MAX_BEAT_WORDS || rawBeat.text.length > MAX_BEAT_CHARS) {
			errors.push({
				path: beatPath,
				rule: "beats",
				detail: `beat text exceeds the ${MAX_BEAT_WORDS}-word/${MAX_BEAT_CHARS}-char cap`,
			});
		}

		const { errors: citeErrors } = validateCitations(rawBeat, beatPath, ctx.sources, sceneIsGrounded);
		errors.push(...citeErrors);

		const focus = resolveFocus(
			rawBeat.focus,
			scenePath,
			codeScene ? "code" : diagramScene ? "diagram" : raw.code || raw.diagram ? "code" : "title",
			codeScene?.lines.length,
			diagramIdMap,
			dropped,
		);

		const cites =
			rawBeat.cites.length === 0 && impliedCiteId && (rawBeat.claim === "what" || rawBeat.claim === "how")
				? [impliedCiteId]
				: rawBeat.cites;

		beats.push({ text: cleanProse(rawBeat.text), ...(focus ? { focus } : {}), cites });
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

const MAX_CODE_SCENES = { short: 3, deep: 6 };

/**
 * The D7 required arc: optional leading `hook`, then `problem` -> `idea` -> `mechanism` (with a diagram) -> 1-3
 * (short) / 1-6 (deep) `code` scenes -> `impact` -> any number of `tradeoffs` -> (deep only) optional
 * `alternatives`, optional `edge-cases` -> a closing `outro`, which must be the last scene.
 */
function validateArc(scenes: RawScene[], isDeepDive: boolean): ValidationError[] {
	const errors: ValidationError[] = [];
	const sections: (Section | undefined)[] = scenes.map((s) => s.section);
	let i = 0;

	const expect = (section: Section, label: string): boolean => {
		if (sections[i] !== section) {
			errors.push({
				path: `scenes[${i}]`,
				rule: "arc",
				detail: `expected a "${section}" scene (${label}) at position ${i}, got ${sections[i] ?? "end of scenes"}`,
			});
			return false;
		}
		i++;
		return true;
	};

	if (sections[i] === "hook") i++;
	if (!expect("problem", "the problem")) return errors;
	if (!expect("idea", "the idea")) return errors;

	const mechanismIndex = i;
	if (!expect("mechanism", "the mechanism, with a diagram")) return errors;
	if (!scenes[mechanismIndex]?.diagram) {
		errors.push({ path: `scenes[${mechanismIndex}]`, rule: "arc", detail: 'the "mechanism" scene needs a diagram' });
	}

	let codeCount = 0;
	while (sections[i] === "code") {
		codeCount++;
		i++;
	}
	const maxCode = isDeepDive ? MAX_CODE_SCENES.deep : MAX_CODE_SCENES.short;
	if (codeCount < 1) {
		errors.push({ path: "scenes", rule: "arc", detail: 'needs at least 1 "code" scene after "mechanism"' });
	} else if (codeCount > maxCode) {
		errors.push({ path: "scenes", rule: "arc", detail: `at most ${maxCode} "code" scenes, got ${codeCount}` });
	}

	if (!expect("impact", "the impact")) return errors;
	while (sections[i] === "tradeoffs") i++;

	if (isDeepDive) {
		if (sections[i] === "alternatives") i++;
		if (sections[i] === "edge-cases") i++;
	}

	if (sections[i] !== "outro") {
		errors.push({
			path: `scenes[${i}]`,
			rule: "arc",
			detail: `expected the closing "outro" scene at position ${i}, got ${sections[i] ?? "end of scenes"}`,
		});
	} else if (i !== sections.length - 1) {
		errors.push({
			path: "scenes",
			rule: "arc",
			detail: `"outro" must be the last scene; found ${sections.length - 1 - i} scene(s) after it`,
		});
	}

	return errors;
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
		proseViolatesDenyPatterns(cleanProse(raw.title), ctx.denyPatterns) ||
		proseViolatesDenyPatterns(cleanProse(raw.subtitle), ctx.denyPatterns)
	) {
		errors.push({ path: "title", rule: "prose", detail: "title or subtitle matches a deny pattern" });
	}
	if (proseViolatesDenyPatterns(cleanProse(raw.summary.text), ctx.denyPatterns)) {
		errors.push({ path: "summary.text", rule: "prose", detail: "summary matches a deny pattern" });
	}
	if (raw.theme !== undefined && proseViolatesDenyPatterns(cleanProse(raw.theme), ctx.denyPatterns)) {
		errors.push({ path: "theme", rule: "prose", detail: "theme matches a deny pattern" });
	}

	errors.push(...validateArc(raw.scenes, ctx.isDeepDive));

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
