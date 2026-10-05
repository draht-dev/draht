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
import type { RawBeat, RawCode, RawScene, RawWriterResponse } from "./story-protocol.ts";
import { normalizeBeats } from "./tts.ts";

export interface ValidationError {
	path: string;
	rule: string;
	detail: string;
}

export interface ValidationContext {
	/** M1: must be the story's *policed* files (`AssembledStoryContext.files`), never the raw, unpoliced `Story.files` — a code ref is resolved against exactly what the model was allowed to see. */
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
	/** M1/M2: `AssembledStoryContext.isBlocked` — true when a path may never back a code scene (code deny, `docs.deny`, or the unlisted `.planning/**` rule), even if its hunk happens not to be withheld. */
	isBlocked: (path: string) => boolean;
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
/** M4: a scene heading is published prose too (cleaned and deny-checked like any other), with its own length cap. */
const MAX_HEADING_CHARS = 80;

function capHeading(text: string): string {
	return text.length > MAX_HEADING_CHARS ? text.slice(0, MAX_HEADING_CHARS) : text;
}

/** What grounds a `what`/`how` beat without a cite: the scene's own shown code lines or diagram labels. */
export type GroundedSceneKind = "code" | "diagram" | "other";

const GROUNDING_STOPWORDS = new Set([
	"the",
	"and",
	"that",
	"this",
	"with",
	"from",
	"have",
	"your",
	"here",
	"into",
	"line",
	"lines",
]);

function groundingWords(text: string): Set<string> {
	const words = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
	return new Set(words.filter((w) => !GROUNDING_STOPWORDS.has(w)));
}

function groundingIdentifiers(text: string): string[] {
	return text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)?.filter((id) => id.length >= 3 && /[A-Z_]/.test(id)) ?? [];
}

/** M3: true when `beatText` shares a content word (>=3 chars, after a tiny stopword list) or an identifier-shaped token with `groundingText`. */
export function sharesGroundingWord(beatText: string, groundingText: string): boolean {
	if (groundingText.trim().length === 0) return false;
	const haystack = groundingWords(groundingText);
	for (const word of groundingWords(beatText)) {
		if (haystack.has(word)) return true;
	}
	const lowerGrounding = groundingText.toLowerCase();
	return groundingIdentifiers(beatText).some((id) => lowerGrounding.includes(id.toLowerCase()));
}

/** M3: a `meta` beat may only be a short, fact-free transition — never a vehicle for an uncited claim. */
const META_MAX_WORDS = 12;
const META_FORBIDDEN_VERBS = [
	"ships",
	"fixes",
	"adds",
	"removes",
	"certified",
	"encrypts",
	"uploads",
	"disables",
	"enables",
];
const META_FORBIDDEN_VERB_RE = new RegExp(`\\b(${META_FORBIDDEN_VERBS.join("|")})\\b`, "i");

function titleWordSet(title: string): ReadonlySet<string> {
	return new Set((title.match(/[A-Za-z0-9_]+/g) ?? []).map((w) => w.toLowerCase()));
}

/** A word is a "proper noun beyond the title" when it is capitalized, not the beat's first word (sentence-initial capitals are not proper nouns), and absent from the story title's own words. */
function hasExtraProperNoun(text: string, titleWords: ReadonlySet<string>): boolean {
	const words = text.match(/[A-Za-z0-9_]+/g) ?? [];
	return words.some((word, i) => {
		if (i === 0) return false;
		if (!/^[A-Z]/.test(word)) return false;
		return !titleWords.has(word.toLowerCase());
	});
}

function validateMetaBeat(text: string, titleWords: ReadonlySet<string>): string | undefined {
	if (isReasonNotRecorded(text)) return undefined;
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length > META_MAX_WORDS)
		return `a "meta" beat must be at most ${META_MAX_WORDS} words, got ${words.length}`;
	if (/\d/.test(text)) return 'a "meta" beat must not contain a digit (it may not carry a number as a fact)';
	if (META_FORBIDDEN_VERB_RE.test(text)) {
		return `a "meta" beat must not use a claim verb (${META_FORBIDDEN_VERBS.join(", ")})`;
	}
	if (hasExtraProperNoun(text, titleWords)) {
		return 'a "meta" beat must not name a proper noun beyond the story title\'s own words';
	}
	return undefined;
}

function validateCitations(
	beat: RawBeat,
	beatPath: string,
	sources: SourceRegistry,
	sceneKind: GroundedSceneKind,
	groundingText: string,
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

	if (beat.claim === "meta") return { errors };

	const isWhatHow = beat.claim === "what" || beat.claim === "how";
	const needsQuoteGrounding = beat.claim === "why" || beat.claim === "effect" || (isWhatHow && sceneKind === "other");

	if (needsQuoteGrounding) {
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
		return { errors };
	}

	// what/how in a code or diagram scene: no cite required, but the text must be about what is actually shown.
	if (!sharesGroundingWord(beat.text, groundingText)) {
		errors.push({
			path: beatPath,
			rule: "citations",
			detail: `a "${beat.claim}" beat in a ${sceneKind} scene must share a content word or identifier with the scene's shown ${sceneKind === "code" ? "code lines" : "diagram labels"}`,
		});
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

function validateScene(
	raw: RawScene,
	index: number,
	ctx: ValidationContext,
	titleWords: ReadonlySet<string>,
): SceneValidation {
	const scenePath = `scenes[${index}]`;
	const errors: ValidationError[] = [];
	const dropped: string[] = [];

	let codeScene: CodeScene | undefined;
	if (raw.code && ctx.isBlocked(raw.code.path)) {
		errors.push({
			path: `${scenePath}.code`,
			rule: "code",
			detail: `code: path is blocked by the context's privacy policy: ${raw.code.path}`,
		});
	} else if (raw.code) {
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

	const sceneKind: GroundedSceneKind = codeScene ? "code" : diagramScene ? "diagram" : "other";
	const groundingText =
		sceneKind === "code"
			? (codeScene?.lines.map((l) => l.slice(1)).join(" ") ?? "")
			: sceneKind === "diagram" && raw.diagram && diagramIdMap
				? raw.diagram.nodes
						.filter((n) => diagramIdMap?.has(n.id))
						.map((n) => `${n.caption} ${n.anchor.value}`)
						.join(" ")
				: "";

	const beats: Beat[] = [];
	raw.beats.forEach((rawBeat, beatIndex) => {
		const beatPath = `${scenePath}.beats[${beatIndex}]`;
		const cleanedText = cleanProse(rawBeat.text);
		if (proseViolatesDenyPatterns(cleanedText, ctx.denyPatterns)) {
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

		if (rawBeat.claim === "meta") {
			// Checked against the cleaned (redacted) text: a secret-shaped value that happens to contain a digit is
			// never a real "fact" the meta rule needs to catch — it becomes "[redacted]" before this check runs.
			const metaError = validateMetaBeat(cleanedText, titleWords);
			if (metaError) errors.push({ path: beatPath, rule: "citations", detail: metaError });
		}

		const { errors: citeErrors } = validateCitations(rawBeat, beatPath, ctx.sources, sceneKind, groundingText);
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

		beats.push({ text: cleanedText, ...(focus ? { focus } : {}), cites });
	});

	if (errors.length > 0) return { errors, dropped };

	const baseScene: Scene = codeScene ??
		diagramScene ?? { kind: "title", title: capHeading(cleanProse(raw.heading ?? "")), subtitle: "", narration: "" };
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

	const titleWords = titleWordSet(raw.title);
	const scenes: Scene[] = [];
	raw.scenes.forEach((rawScene, index) => {
		const result = validateScene(rawScene, index, ctx, titleWords);
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
