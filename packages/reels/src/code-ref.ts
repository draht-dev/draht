/**
 * Resolves a writer-chosen code reference into verbatim lines. The model
 * only ever supplies a path and a line range (and, for a diff ref, a hunk
 * index) — never the code text itself — so a "fabricated" code line is
 * structurally impossible: every returned line comes from {@link FileChange}
 * (the real diff) or {@link HeadFileContent} (the file at the story's head
 * commit, already policed by `privacy.ts`), never from the model's response.
 */

import type { FileChange, Hunk } from "./contract.ts";

export interface DiffCodeRef {
	path: string;
	ref: "diff";
	hunkIndex: number;
	/** 1-based, inclusive, within the hunk's own `lines` array. */
	lines: [number, number];
}

export interface HeadCodeRef {
	path: string;
	ref: "head";
	/** 1-based, inclusive, file line numbers. */
	lines: [number, number];
}

export type CodeRef = DiffCodeRef | HeadCodeRef;

/** The file's content at the story's head commit, already privacy-policed (see `privacy.ts`'s `policeHeadFile`). */
export interface HeadFileContent {
	path: string;
	/** `lines[0]` is file line 1. */
	lines: string[];
}

export interface ResolvedCode {
	path: string;
	origin: "diff" | "head";
	hunkHeader: string;
	/** Verbatim lines, each kept to its original diff marker (`" "`/`"+"`/`"-"`) for a diff ref, or given a computed `" "`/`"+"` marker for a head ref. */
	lines: string[];
	/** 1-based file line number of `lines[0]`. Only meaningful for `origin: "head"`. */
	startLine?: number;
	/** True if the range overlaps at least one line added by this story's diff. */
	overlapsAddedLine: boolean;
}

export type ResolveCodeRefResult = { ok: true; code: ResolvedCode } | { ok: false; error: string };

export interface ResolveCodeRefContext {
	files: FileChange[];
	/** Head file content for every file the writer may reference with `ref: "head"` (changed files and context files alike). */
	headFiles: ReadonlyMap<string, HeadFileContent>;
}

export interface ResolveCodeRefOptions {
	/** Maximum number of lines a single code scene may show (18 short / 30 deep dive, per the plan). */
	maxLines: number;
	/** Deep dives may show a pure-context (no added line) head range; shorts may not. */
	allowContextOnlyHead: boolean;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Maps new-side (post-change) file line numbers to whether that line was
 * added by this hunk, by walking the hunk's own line markers from its
 * declared starting line. Deleted (`-`) lines do not consume a new-side
 * line number and never appear in head content.
 */
function addedLineNumbersInHunk(hunk: Hunk): Set<number> {
	const added = new Set<number>();
	const match = HUNK_HEADER_RE.exec(hunk.header);
	if (!match) return added;
	let lineNo = Number(match[1]);
	for (const line of hunk.lines) {
		const marker = line.charAt(0);
		if (marker === "-") continue;
		if (marker === "+") added.add(lineNo);
		lineNo += 1;
	}
	return added;
}

function addedLineNumbersInFile(file: FileChange | undefined): Set<number> {
	const added = new Set<number>();
	if (!file) return added;
	for (const hunk of file.hunks) {
		if (hunk.withheld) continue;
		for (const n of addedLineNumbersInHunk(hunk)) added.add(n);
	}
	return added;
}

function rangeLength(lines: [number, number]): number {
	return lines[1] - lines[0] + 1;
}

function resolveDiffRef(
	ref: DiffCodeRef,
	ctx: ResolveCodeRefContext,
	options: ResolveCodeRefOptions,
): ResolveCodeRefResult {
	const file = ctx.files.find((f) => f.path === ref.path);
	if (!file) return { ok: false, error: `code: path not in this story's changed files: ${ref.path}` };
	const hunk = file.hunks[ref.hunkIndex];
	if (!hunk || hunk.withheld) {
		return { ok: false, error: `code: hunk ${ref.hunkIndex} of ${ref.path} does not exist or is withheld` };
	}
	const [start, end] = ref.lines;
	if (start < 1 || end < start || end > hunk.lines.length) {
		return { ok: false, error: `code: line range [${start},${end}] is outside hunk ${ref.hunkIndex} of ${ref.path}` };
	}
	if (rangeLength(ref.lines) > options.maxLines) {
		return { ok: false, error: `code: range [${start},${end}] exceeds the ${options.maxLines}-line cap` };
	}
	const lines = hunk.lines.slice(start - 1, end);
	return {
		ok: true,
		code: {
			path: ref.path,
			origin: "diff",
			hunkHeader: hunk.header,
			lines,
			overlapsAddedLine: lines.some((l) => l.startsWith("+")),
		},
	};
}

function resolveHeadRef(
	ref: HeadCodeRef,
	ctx: ResolveCodeRefContext,
	options: ResolveCodeRefOptions,
	headSha: string,
): ResolveCodeRefResult {
	const headFile = ctx.headFiles.get(ref.path);
	if (!headFile) return { ok: false, error: `code: ${ref.path} is not in the context registry at head` };
	const [start, end] = ref.lines;
	if (start < 1 || end < start || end > headFile.lines.length) {
		return {
			ok: false,
			error: `code: line range [${start},${end}] is outside ${ref.path} (${headFile.lines.length} lines)`,
		};
	}
	if (rangeLength(ref.lines) > options.maxLines) {
		return { ok: false, error: `code: range [${start},${end}] exceeds the ${options.maxLines}-line cap` };
	}

	const addedLineNumbers = addedLineNumbersInFile(ctx.files.find((f) => f.path === ref.path));
	let overlapsAddedLine = false;
	const lines: string[] = [];
	for (let n = start; n <= end; n++) {
		const added = addedLineNumbers.has(n);
		if (added) overlapsAddedLine = true;
		lines.push(`${added ? "+" : " "}${headFile.lines[n - 1]}`);
	}

	if (!overlapsAddedLine && !options.allowContextOnlyHead) {
		return {
			ok: false,
			error: `code: head range [${start},${end}] of ${ref.path} has no added line (not allowed in a short)`,
		};
	}

	return {
		ok: true,
		code: {
			path: ref.path,
			origin: "head",
			hunkHeader: `${ref.path}:${start}-${end} @ ${headSha.slice(0, 12)}`,
			lines,
			startLine: start,
			overlapsAddedLine,
		},
	};
}

export function resolveCodeRef(
	ref: CodeRef,
	ctx: ResolveCodeRefContext,
	options: ResolveCodeRefOptions,
	headSha: string,
): ResolveCodeRefResult {
	return ref.ref === "diff" ? resolveDiffRef(ref, ctx, options) : resolveHeadRef(ref, ctx, options, headSha);
}
