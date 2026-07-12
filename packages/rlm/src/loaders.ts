/**
 * Input loaders -- turn a raw `--input`/`/rlm <input>` argument into loaded
 * text content ready to become an `RlmSession`'s `prompt`. Covers four kinds
 * of source: a single file, a glob pattern, an `http(s)://` URL, and a named
 * client knowledge base (via `@draht/knowledge`). See
 * .planning/phases/29-agent-cli-integration/29-01-PLAN.md, Architecture
 * section 1.
 *
 * `parseInputArg` classifies the raw string; `loadInput` does the actual
 * I/O. Kept as two functions so callers (CLI, `/rlm` command, `rlm_query`
 * tool) can validate/echo back what kind of source they resolved before
 * paying the cost of loading it.
 */

import { glob, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { SearchResult } from "@draht/knowledge";

export type InputSource =
	| { type: "file"; path: string }
	| { type: "glob"; pattern: string; cwd: string }
	| { type: "url"; url: string }
	| { type: "knowledge"; clientSlug: string };

export interface LoadedInput {
	/** The loaded/concatenated text content. */
	content: string;
	/** What kind of content `content` holds (e.g. "text", "code", "logs", "json") -- see `PromptVars.contextType`. */
	contextType: string;
}

/**
 * Recognized prefix for the knowledge-base input syntax: `knowledge:<client-slug>`
 * (e.g. `knowledge:acme-corp`), where `<client-slug>` matches `ClientConfig.slug`
 * from `@draht/knowledge`'s `client-config.ts`.
 */
const KNOWLEDGE_PREFIX = "knowledge:";

/** Characters that mark an `--input` string as a glob pattern rather than a literal file path. */
const GLOB_CHARS = /[*?{}[\]!]/;

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".c",
	".cc",
	".cpp",
	".h",
	".hpp",
	".rb",
	".sh",
	".swift",
	".kt",
]);

/**
 * Classifies a raw `--input`/`/rlm` argument into an {@link InputSource}:
 * - `knowledge:<client-slug>` -> `{ type: "knowledge", clientSlug }`.
 * - `http://...` / `https://...` -> `{ type: "url", url }`.
 * - anything containing glob metacharacters (`* ? { } [ ] !`) -> `{ type: "glob", pattern, cwd }`.
 * - everything else -> `{ type: "file", path }`, resolved against `cwd` if relative.
 */
export function parseInputArg(input: string, cwd: string): InputSource {
	const trimmed = input.trim();

	if (trimmed.startsWith(KNOWLEDGE_PREFIX)) {
		const clientSlug = trimmed.slice(KNOWLEDGE_PREFIX.length).trim();
		return { type: "knowledge", clientSlug };
	}

	if (/^https?:\/\//i.test(trimmed)) {
		return { type: "url", url: trimmed };
	}

	if (GLOB_CHARS.test(trimmed)) {
		return { type: "glob", pattern: trimmed, cwd };
	}

	return { type: "file", path: path.isAbsolute(trimmed) ? trimmed : path.join(cwd, trimmed) };
}

/** Loads the given {@link InputSource}, returning its content and the context type to advertise to the RLM root loop. */
export async function loadInput(source: InputSource): Promise<LoadedInput> {
	switch (source.type) {
		case "file":
			return loadFile(source.path);
		case "glob":
			return loadGlob(source.pattern, source.cwd);
		case "url":
			return loadUrl(source.url);
		case "knowledge":
			return loadKnowledge(source.clientSlug);
		default: {
			// Exhaustiveness check -- widen InputSource, forget a branch, get a compile error here.
			const _never: never = source;
			throw new Error(`loadInput: unknown source type "${(_never as InputSource).type}"`);
		}
	}
}

async function loadFile(filePath: string): Promise<LoadedInput> {
	const content = await readFile(filePath, "utf-8");
	return { content, contextType: inferContextType(filePath) };
}

async function loadGlob(pattern: string, cwd: string): Promise<LoadedInput> {
	const matches: string[] = [];
	for await (const match of glob(pattern, { cwd })) {
		matches.push(match);
	}
	matches.sort();

	if (matches.length === 0) {
		throw new Error(`loadInput: glob pattern "${pattern}" matched no files (cwd: ${cwd})`);
	}

	const contextTypes = new Set<string>();
	const parts = await Promise.all(
		matches.map(async (relPath) => {
			const absPath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);
			const content = await readFile(absPath, "utf-8");
			contextTypes.add(inferContextType(absPath));
			return `--- source: ${absPath} ---\n${content}`;
		}),
	);

	// A single matched file's context type carries through; a mixed match falls back to "text".
	const contextType = contextTypes.size === 1 ? [...contextTypes][0] : "text";
	return { content: parts.join("\n\n"), contextType };
}

async function loadUrl(url: string): Promise<LoadedInput> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`loadInput: fetching "${url}" failed with status ${response.status}`);
	}
	const content = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	return { content, contextType: contentType.includes("json") ? "json" : "text" };
}

/** Chunks per section pulled from the client's knowledge store -- generous enough to cover most real stores. */
const KNOWLEDGE_SEARCH_LIMIT = 20;

async function loadKnowledge(clientSlug: string): Promise<LoadedInput> {
	const { KnowledgeManager } = await import("@draht/knowledge");
	const manager = new KnowledgeManager(clientSlug);
	try {
		const [conventions, decisions] = await Promise.all([
			manager.searchKnowledge("project conventions and AGENTS.md guidance", "general", KNOWLEDGE_SEARCH_LIMIT),
			manager.searchKnowledge("past decisions and rationale", "decide", KNOWLEDGE_SEARCH_LIMIT),
		]);

		const sections = [
			formatKnowledgeSection("AGENTS.md / conventions", conventions),
			formatKnowledgeSection("Past decisions", decisions),
		].filter((section): section is string => section !== null);

		if (sections.length === 0) {
			throw new Error(`loadInput: no knowledge found for client "${clientSlug}"`);
		}

		return { content: sections.join("\n\n"), contextType: "text" };
	} finally {
		manager.close();
	}
}

function formatKnowledgeSection(title: string, results: SearchResult[]): string | null {
	if (results.length === 0) return null;
	const body = results.map((r) => r.content).join("\n\n");
	return `## ${title}\n\n${body}`;
}

function inferContextType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".json") return "json";
	if (ext === ".log") return "logs";
	if (CODE_EXTENSIONS.has(ext)) return "code";
	return "text";
}
