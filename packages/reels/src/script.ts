/**
 * Turns a {@link ChangeSet} into a {@link ReelScript}. Both writers may only
 * pick which hunks to show and write narration text; the code a reel
 * displays always comes verbatim from the real diff (see contract.ts).
 */

import type { ChangeSet, CodeScene, FileChange, Hunk, ReelScript, Scene } from "./contract.ts";
import { buildChangeDiagram } from "./diagram.ts";
import { redactText } from "./privacy.ts";

export type Lang = "en" | "de";

export interface ScriptWriterOptions {
	lang?: Lang;
	maxCodeScenes?: number;
}

export type ScriptWriter = (changeSet: ChangeSet, options?: ScriptWriterOptions) => Promise<ReelScript>;

const DEFAULT_MAX_CODE_SCENES = 4;

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

export function languageForPath(path: string): string {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return "text";
	return EXTENSION_LANGUAGE[path.slice(dot + 1).toLowerCase()] ?? "text";
}

function hunkChurn(hunk: Hunk): number {
	return hunk.lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
}

/** Picks the hunks most worth narrating: largest churn first, across distinct files. */
function rankHunks(files: FileChange[]): Array<{ file: FileChange; hunk: Hunk; hunkIndex: number }> {
	const ranked: Array<{ file: FileChange; hunk: Hunk; hunkIndex: number; churn: number }> = [];
	for (const file of files) {
		file.hunks.forEach((hunk, hunkIndex) => {
			if (hunk.withheld) return;
			ranked.push({ file, hunk, hunkIndex, churn: hunkChurn(hunk) });
		});
	}
	ranked.sort((a, b) => b.churn - a.churn);
	return ranked;
}

interface NarrationText {
	filesChanged: (n: number) => string;
	added: (n: number) => string;
	removed: (n: number) => string;
	inFile: (path: string) => string;
	diagramIntro: (n: number) => string;
	outro: string;
}

const TEXT: Record<Lang, NarrationText> = {
	en: {
		filesChanged: (n) => `This change touches ${n} file${n === 1 ? "" : "s"}.`,
		added: (n) => `It adds ${n} line${n === 1 ? "" : "s"}.`,
		removed: (n) => `It removes ${n} line${n === 1 ? "" : "s"}.`,
		inFile: (path) => `Here is ${path}.`,
		diagramIntro: (n) => `The change spans ${n} directories.`,
		outro: "That is the full change.",
	},
	de: {
		filesChanged: (n) => `Diese Änderung betrifft ${n} Datei${n === 1 ? "" : "en"}.`,
		added: (n) => `Sie fügt ${n} Zeile${n === 1 ? "" : "n"} hinzu.`,
		removed: (n) => `Sie entfernt ${n} Zeile${n === 1 ? "" : "n"}.`,
		inFile: (path) => `Hier ist ${path}.`,
		diagramIntro: (n) => `Die Änderung umfasst ${n} Verzeichnisse.`,
		outro: "Das war die ganze Änderung.",
	},
};

function textFor(lang: Lang): NarrationText {
	return TEXT[lang];
}

function totalAdditions(files: FileChange[]): number {
	return files.reduce((sum, f) => sum + f.additions, 0);
}

function totalDeletions(files: FileChange[]): number {
	return files.reduce((sum, f) => sum + f.deletions, 0);
}

function buildCodeScene(
	file: FileChange,
	hunk: Hunk,
	narration: string,
	range?: { startLine?: number; endLine?: number },
): CodeScene {
	const start = range?.startLine ?? 0;
	const end = range?.endLine ?? hunk.lines.length;
	const lines = hunk.lines.slice(Math.max(0, start), Math.min(hunk.lines.length, end || hunk.lines.length));
	return {
		kind: "code",
		path: file.path,
		language: languageForPath(file.path),
		hunkHeader: redactText(hunk.header),
		lines: lines.length > 0 ? lines : hunk.lines,
		narration,
	};
}

const EMPTY_SUBJECT_FALLBACK: Record<Lang, string> = {
	en: "(no commit message)",
	de: "(keine Commit-Nachricht)",
};

/** Caps a title-like string so a pathological commit subject cannot inflate TTS cost or overflow the title card. */
const MAX_TITLE_CHARS = 200;
function capTitle(text: string): string {
	return text.length <= MAX_TITLE_CHARS ? text : `${text.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
}

export const templateWriter: ScriptWriter = async (changeSet, options = {}) => {
	const lang = options.lang ?? "en";
	const maxCodeScenes = options.maxCodeScenes ?? DEFAULT_MAX_CODE_SCENES;
	const t = textFor(lang);
	const scenes: Scene[] = [];

	// Never send empty narration: an empty commit subject would otherwise
	// produce a silent/zero-length TTS request for the title scene.
	// Redact before capping: a cap that cuts a token in half would leave a prefix the patterns no longer match.
	const title = capTitle(redactText(changeSet.title.trim() || EMPTY_SUBJECT_FALLBACK[lang]));
	const subtitle = redactText(changeSet.authors.join(", "));

	scenes.push({
		kind: "title",
		title,
		subtitle,
		narration: title,
	});

	scenes.push({
		kind: "stats",
		files: changeSet.files.map((f) => ({
			path: f.path,
			status: f.status,
			additions: f.additions,
			deletions: f.deletions,
		})),
		narration: `${t.filesChanged(changeSet.files.length)} ${t.added(totalAdditions(changeSet.files))} ${t.removed(totalDeletions(changeSet.files))}`,
	});

	const ranked = rankHunks(changeSet.files).slice(0, maxCodeScenes);
	for (const { file, hunk } of ranked) {
		scenes.push(buildCodeScene(file, hunk, t.inFile(file.path)));
	}

	const dirs = new Set(
		changeSet.files.map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : ".")),
	);
	if (dirs.size > 1) {
		const { mermaid } = buildChangeDiagram(changeSet.files);
		scenes.push({ kind: "diagram", mermaid, narration: t.diagramIntro(dirs.size) });
	}

	scenes.push({ kind: "outro", narration: t.outro });

	return { changeSetId: changeSet.id, writer: "template", scenes };
};

export interface HunkRef {
	path: string;
	hunkIndex: number;
	startLine?: number;
	endLine?: number;
}

export interface LlmScriptResponse {
	title: string;
	subtitle: string;
	titleNarration: string;
	statsNarration: string;
	scenes: Array<{ ref: HunkRef; narration: string }>;
	diagramNarration?: string;
	outroNarration: string;
}

export interface ModelCompletionRequest {
	/** System instructions, separate from the user `prompt` (see `ai-completer.lazy.ts`'s `Context.systemPrompt`). */
	systemPrompt?: string;
	prompt: string;
	maxTokens: number;
}

export interface ModelCompletionUsage {
	input: number;
	output: number;
	costUsd: number;
}

export interface ModelCompletionResult {
	text: string;
	/** Absent for completers (tests, the faux queue) that do not track usage. */
	usage?: ModelCompletionUsage;
}

/**
 * A completer always resolves to a finished response; an adapter maps a
 * failed stop reason (`"error"`/`"aborted"`) to a rejected promise instead of
 * surfacing it here, so callers never have to re-check `stopReason`.
 */
export type ModelCompleter = (request: ModelCompletionRequest) => Promise<ModelCompletionResult>;

/** Upper bound per narration string, so a runaway model response cannot inflate TTS cost. */
const MAX_NARRATION_CHARS = 300;

/** `--unit commit`'s `llmWriter` output is small (one title/stats/outro plus a few scene narrations). */
const DEFAULT_COMMIT_MAX_TOKENS = 2048;

const PROMPT_LANGUAGE: Record<Lang, string> = { en: "English", de: "German" };

function capNarration(text: string): string {
	return text.length <= MAX_NARRATION_CHARS ? text : `${text.slice(0, MAX_NARRATION_CHARS).trimEnd()}…`;
}

/** Models often wrap JSON in a Markdown code fence despite being told not to. */
function stripCodeFence(raw: string): string {
	const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
	return fenced ? fenced[1] : raw;
}

/** Upper bounds on prompt size, so a change set with a huge body/file/hunk count cannot inflate LLM request cost or exceed its context window. */
const MAX_PROMPT_BODY_CHARS = 4096;
const MAX_PROMPT_FILES = 50;
const MAX_PROMPT_HUNKS_PER_FILE = 10;

function capPromptBody(text: string): string {
	return text.length <= MAX_PROMPT_BODY_CHARS ? text : `${text.slice(0, MAX_PROMPT_BODY_CHARS).trimEnd()}…`;
}

function buildPrompt(changeSet: ChangeSet, lang: Lang): string {
	const files = changeSet.files.slice(0, MAX_PROMPT_FILES);
	const extraFiles = changeSet.files.length - files.length;

	const fileSummaries = files
		.map((f, fi) => {
			const hunks = f.hunks.slice(0, MAX_PROMPT_HUNKS_PER_FILE);
			const extraHunks = f.hunks.length - hunks.length;
			const hunkSummaries = hunks
				.map((h, hi) =>
					h.withheld
						? `  hunk ${hi} (withheld)`
						: `  hunk ${hi} ${redactText(h.header)} (${h.lines.length} lines)`,
				)
				.join("\n");
			const moreHunksNote = extraHunks > 0 ? `\n  ... ${extraHunks} more hunk${extraHunks === 1 ? "" : "s"}` : "";
			return `file ${fi} ${f.path} [${f.status}, +${f.additions}/-${f.deletions}]\n${hunkSummaries}${moreHunksNote}`;
		})
		.join("\n");
	const moreFilesNote = extraFiles > 0 ? `\n... ${extraFiles} more file${extraFiles === 1 ? "" : "s"}` : "";

	return [
		"You are narrating a short vertical video that explains a git change set.",
		`Title: ${redactText(changeSet.title)}`,
		`Body: ${redactText(capPromptBody(changeSet.body))}`,
		"Files and hunks (choose only from these, by exact path and hunkIndex):",
		`${fileSummaries}${moreFilesNote}`,
		"",
		"Respond with strict JSON matching this shape, and nothing else:",
		'{"title": string, "subtitle": string, "titleNarration": string, "statsNarration": string,',
		' "scenes": [{"ref": {"path": string, "hunkIndex": number, "startLine"?: number, "endLine"?: number}, "narration": string}],',
		' "diagramNarration"?: string, "outroNarration": string}',
		`Write every narration and the title fields in ${PROMPT_LANGUAGE[lang]}.`,
		"Narration rules: short plain sentences, max about 20 words each, active voice, one idea per sentence.",
	].join("\n");
}

function parseLlmResponse(raw: string): LlmScriptResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripCodeFence(raw));
	} catch (error) {
		throw new Error(`llm writer: response was not valid JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("llm writer: response must be a JSON object");
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.title !== "string") throw new Error("llm writer: missing string field 'title'");
	if (typeof obj.subtitle !== "string") throw new Error("llm writer: missing string field 'subtitle'");
	if (typeof obj.titleNarration !== "string") throw new Error("llm writer: missing string field 'titleNarration'");
	if (typeof obj.statsNarration !== "string") throw new Error("llm writer: missing string field 'statsNarration'");
	if (typeof obj.outroNarration !== "string") throw new Error("llm writer: missing string field 'outroNarration'");
	if (!Array.isArray(obj.scenes)) throw new Error("llm writer: missing array field 'scenes'");

	const scenes = obj.scenes.map((entry, i) => {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`llm writer: scenes[${i}] must be an object`);
		}
		const e = entry as Record<string, unknown>;
		const ref = e.ref as Record<string, unknown> | undefined;
		if (!ref || typeof ref.path !== "string" || typeof ref.hunkIndex !== "number") {
			throw new Error(`llm writer: scenes[${i}].ref must have string path and number hunkIndex`);
		}
		if (typeof e.narration !== "string") {
			throw new Error(`llm writer: scenes[${i}].narration must be a string`);
		}
		return {
			ref: {
				path: ref.path,
				hunkIndex: ref.hunkIndex,
				startLine: typeof ref.startLine === "number" ? ref.startLine : undefined,
				endLine: typeof ref.endLine === "number" ? ref.endLine : undefined,
			},
			narration: capNarration(e.narration),
		};
	});

	return {
		title: capTitle(redactText(obj.title)),
		subtitle: capTitle(redactText(obj.subtitle)),
		titleNarration: capNarration(obj.titleNarration),
		statsNarration: capNarration(obj.statsNarration),
		scenes,
		diagramNarration: typeof obj.diagramNarration === "string" ? capNarration(obj.diagramNarration) : undefined,
		outroNarration: capNarration(obj.outroNarration),
	};
}

function resolveHunkRef(changeSet: ChangeSet, ref: HunkRef): { file: FileChange; hunk: Hunk } | undefined {
	const file = changeSet.files.find((f) => f.path === ref.path);
	if (!file) return undefined;
	const hunk = file.hunks[ref.hunkIndex];
	if (!hunk || hunk.withheld) return undefined;
	return { file, hunk };
}

/** Builds a writer that asks `complete` for scene choices, then rejects any hunk reference that does not exist. */
export function llmWriter(complete: ModelCompleter): ScriptWriter {
	return async (changeSet, options = {}) => {
		const lang = options.lang ?? "en";
		const completion = await complete({
			prompt: buildPrompt(changeSet, lang),
			maxTokens: DEFAULT_COMMIT_MAX_TOKENS,
		});
		const response = parseLlmResponse(completion.text);

		const scenes: Scene[] = [];
		scenes.push({
			kind: "title",
			title: redactText(response.title),
			subtitle: redactText(response.subtitle),
			narration: redactText(response.titleNarration),
		});
		scenes.push({
			kind: "stats",
			files: changeSet.files.map((f) => ({
				path: f.path,
				status: f.status,
				additions: f.additions,
				deletions: f.deletions,
			})),
			narration: redactText(response.statsNarration),
		});

		const maxCodeScenes = options.maxCodeScenes ?? DEFAULT_MAX_CODE_SCENES;
		for (const entry of response.scenes) {
			if (scenes.filter((s) => s.kind === "code").length >= maxCodeScenes) break;
			const resolved = resolveHunkRef(changeSet, entry.ref);
			if (!resolved) continue; // skip hunk refs that do not exist, per contract
			scenes.push(buildCodeScene(resolved.file, resolved.hunk, redactText(entry.narration), entry.ref));
		}

		if (response.diagramNarration) {
			const { mermaid } = buildChangeDiagram(changeSet.files);
			scenes.push({ kind: "diagram", mermaid, narration: redactText(response.diagramNarration) });
		}

		scenes.push({ kind: "outro", narration: redactText(response.outroNarration) });

		return { changeSetId: changeSet.id, writer: "llm", scenes };
	};
}

/**
 * Falls back to {@link templateWriter} for a change set whose primary writer
 * fails (network error, malformed or invalid model output), so one bad
 * response does not abort a run that has already paid for earlier reels.
 */
export function withTemplateFallback<T extends ChangeSet>(
	writer: (changeSet: T, options?: ScriptWriterOptions) => Promise<ReelScript>,
	onFallback: (changeSet: T, error: Error) => void,
): (changeSet: T, options?: ScriptWriterOptions) => Promise<ReelScript> {
	return async (changeSet, options) => {
		try {
			return await writer(changeSet, options);
		} catch (error) {
			onFallback(changeSet, error instanceof Error ? error : new Error(String(error)));
			return templateWriter(changeSet, options);
		}
	};
}
