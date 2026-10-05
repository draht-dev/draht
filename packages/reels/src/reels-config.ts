/**
 * `.reels.json` schema and loader. This task (T1) only implements the keys
 * that `walkMainline` needs: `tagPattern`, `historyFloor`, `overrides`,
 * `upstream`, and `story`. Later tasks extend {@link ALLOWED_TOP_LEVEL_KEYS}
 * for `releases`, `docs`, `code`, and `prose` — until then those keys are
 * rejected like any other unknown key, so a config written against a newer
 * README does not silently no-op on an older build.
 */

import { readFile } from "node:fs/promises";

export type MergeOverride = "skip" | "feature" | "upstream-sync" | "back-merge" | "branch-sync";

const MERGE_OVERRIDES: ReadonlySet<string> = new Set(["skip", "feature", "upstream-sync", "back-merge", "branch-sync"]);

export interface UpstreamConfig {
	/** Regex strings (case-insensitive) matched against a merge subject. */
	subjectPatterns: string[];
	/** Paths that, when touched by a merge's diff, mark it as an upstream sync. */
	markerPaths: string[];
	/** Share of foreign-author branch commits (of at least 20 sampled) that marks a merge as an upstream sync. */
	foreignAuthorRatio: number;
}

export type AttributionStrength = "strong" | "weak";

export interface StoryConfig {
	/** Conventional-commit types that make a direct mainline commit its own story. */
	directCommitTypes: string[];
	/** Branch commit count above which a non-sync merge is "oversized" rather than "feature". */
	maxBranchCommits: number;
	/** `--unit story`: minimum attribution confidence a changelog (`origin: "commit"`) story needs to be eligible. Branch/PR stories are always eligible, regardless of this setting. */
	minAttribution: AttributionStrength;
	/** `--unit story`'s default model (`"<provider>/<modelId>"`), used when `--model` is absent. */
	model?: string;
}

/** `--unit story` run-wide spend caps and draft output location (T12). */
export interface BuildConfig {
	maxCostUsd: number;
	maxLlmTokens: number;
	maxTtsChars: number;
	/** Overrides the default `<repo>/.reels-drafts` location. */
	draftsDir?: string;
}

/** Doc/prose allowlist for `context.ts` (D8): `deny` always wins over `allow`. */
export interface DocsConfig {
	allow: string[];
	deny: string[];
	/** Cap on the number of ranked doc chunks kept per story (identifier hits plus explicit mentions). */
	maxChunks: number;
}

/** Code deny globs (also applied to doc paths, D8) plus an `--include` override. */
export interface CodeConfig {
	exclude: string[];
	include: string[];
}

/** Customer names and internal codenames: a match drops the source chunk, or rejects narration/title/caption. */
export interface ProseConfig {
	denyPatterns: string[];
}

export interface ReelsConfig {
	/** Regex string (anchored, case-sensitive unless the string embeds flags) matched against tag names. */
	tagPattern: string;
	/** A tag or sha that stops the mainline walk; history before it never yields stories. */
	historyFloor?: string;
	overrides: Readonly<Record<string, MergeOverride>>;
	upstream: UpstreamConfig;
	story: StoryConfig;
	docs: DocsConfig;
	code: CodeConfig;
	prose: ProseConfig;
	build: BuildConfig;
}

export const DEFAULT_TAG_PATTERN = "^v";

export const DEFAULT_UPSTREAM_CONFIG: UpstreamConfig = {
	subjectPatterns: ["sync upstream", "upstream[- ]sync"],
	markerPaths: [],
	foreignAuthorRatio: 0.6,
};

export const DEFAULT_STORY_CONFIG: StoryConfig = {
	directCommitTypes: ["feat"],
	maxBranchCommits: 150,
	minAttribution: "strong",
};

export const DEFAULT_BUILD_CONFIG: BuildConfig = {
	maxCostUsd: 5,
	maxLlmTokens: 2_000_000,
	maxTtsChars: 50_000,
};

/** `.planning/**` is deliberately absent from `allow`: it is readable only when a repo config allowlists specific paths (owner decision Q4). */
export const DEFAULT_DOCS_CONFIG: DocsConfig = {
	allow: ["README.md", "**/README.md", "docs/**", "**/CHANGELOG.md"],
	deny: [
		".planning/CONTINUE-HERE.md",
		".planning/DECISIONS-PENDING.md",
		".planning/STATE.md",
		".planning/execution-log.jsonl",
		".planning/quick/**",
	],
	maxChunks: 8,
};

export const DEFAULT_CODE_CONFIG: CodeConfig = {
	exclude: [],
	include: [],
};

export const DEFAULT_PROSE_CONFIG: ProseConfig = {
	denyPatterns: [],
};

export const DEFAULT_REELS_CONFIG: ReelsConfig = {
	tagPattern: DEFAULT_TAG_PATTERN,
	overrides: {},
	upstream: DEFAULT_UPSTREAM_CONFIG,
	story: DEFAULT_STORY_CONFIG,
	docs: DEFAULT_DOCS_CONFIG,
	code: DEFAULT_CODE_CONFIG,
	prose: DEFAULT_PROSE_CONFIG,
	build: DEFAULT_BUILD_CONFIG,
};

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
	"tagPattern",
	"historyFloor",
	"overrides",
	"upstream",
	"story",
	"docs",
	"code",
	"prose",
	"build",
]);
const ALLOWED_UPSTREAM_KEYS: ReadonlySet<string> = new Set(["subjectPatterns", "markerPaths", "foreignAuthorRatio"]);
const ALLOWED_STORY_KEYS: ReadonlySet<string> = new Set([
	"directCommitTypes",
	"maxBranchCommits",
	"minAttribution",
	"model",
]);
const ALLOWED_DOCS_KEYS: ReadonlySet<string> = new Set(["allow", "deny", "maxChunks"]);
const ALLOWED_CODE_KEYS: ReadonlySet<string> = new Set(["exclude", "include"]);
const ALLOWED_PROSE_KEYS: ReadonlySet<string> = new Set(["denyPatterns"]);
const ALLOWED_BUILD_KEYS: ReadonlySet<string> = new Set(["maxCostUsd", "maxLlmTokens", "maxTtsChars", "draftsDir"]);
const ATTRIBUTION_STRENGTHS: ReadonlySet<string> = new Set(["strong", "weak"]);

export class ReelsConfigError extends Error {}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			throw new ReelsConfigError(`unknown config key "${key}" in ${where}`);
		}
	}
}

/**
 * Defense in depth, not a real guarantee: `.reels.json` comes from repo
 * maintainers, not from an untrusted request, so a determined maintainer
 * could still write a slow regex this conservative, syntax-only check
 * misses. Any text one of these patterns is later matched against (a tag
 * name, commit subject, or prose chunk) must additionally be capped at
 * {@link MAX_USER_REGEX_INPUT_BYTES} by its own call site — this check alone
 * does not bound the cost of a safe-looking pattern against unbounded input.
 */
export const MAX_USER_REGEX_INPUT_BYTES = 4 * 1024;

/** True when `text` (from the position after an unescaped `(`/`)`) opens with a quantifier: `+`, `*`, or `{m,n}`. */
function startsWithQuantifier(text: string): boolean {
	return /^(?:[+*]|\{\d*,?\d*\})/.test(text);
}

/** True when `text` contains an unescaped `+`, `*`, or `{m,n}` quantifier anywhere. */
function containsUnescapedQuantifier(text: string): boolean {
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "+" || ch === "*") return true;
		if (ch === "{" && /^\{\d*,?\d*\}/.test(text.slice(i))) return true;
	}
	return false;
}

/**
 * Conservative, syntax-only catastrophic-backtracking check: true when some
 * unescaped group `(...)` is itself quantified (`)+`, `)*`, `){m,n}`) and
 * also contains its own unescaped quantifier, e.g. `(a+)+` or `(a*)*` — the
 * classic exponential-backtrack shape. May reject some patterns that are
 * actually safe; never claims to catch every ReDoS shape.
 */
function hasNestedQuantifierGroup(pattern: string): boolean {
	const openIndexes: number[] = [];
	let escaped = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "(") {
			openIndexes.push(i);
			continue;
		}
		if (ch !== ")") continue;
		const openIndex = openIndexes.pop();
		if (openIndex === undefined) continue;
		if (!startsWithQuantifier(pattern.slice(i + 1))) continue;
		if (containsUnescapedQuantifier(pattern.slice(openIndex + 1, i))) return true;
	}
	return false;
}

function assertValidRegexString(pattern: string, where: string): void {
	try {
		// eslint-disable-next-line no-new
		new RegExp(pattern);
	} catch (err) {
		throw new ReelsConfigError(`invalid regular expression for ${where}: ${(err as Error).message}`);
	}
	if (hasNestedQuantifierGroup(pattern)) {
		throw new ReelsConfigError(
			`${where} looks like it can cause catastrophic regex backtracking (a quantified group containing its own quantifier): "${pattern}"`,
		);
	}
}

/** `spec` must be `"<provider>/<id>"`: non-empty, with exactly one `/` separating two non-empty parts. */
function assertValidModelSpec(spec: string, where: string): void {
	const parts = spec.split("/");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
		throw new ReelsConfigError(`${where} must be "<provider>/<modelId>", got "${spec}"`);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUpstream(raw: unknown): UpstreamConfig {
	if (raw === undefined) return DEFAULT_UPSTREAM_CONFIG;
	if (!isPlainObject(raw)) throw new ReelsConfigError("upstream must be an object");
	assertNoUnknownKeys(raw, ALLOWED_UPSTREAM_KEYS, "upstream");

	const subjectPatterns =
		raw.subjectPatterns === undefined ? DEFAULT_UPSTREAM_CONFIG.subjectPatterns : raw.subjectPatterns;
	if (!Array.isArray(subjectPatterns) || !subjectPatterns.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("upstream.subjectPatterns must be an array of strings");
	}
	for (const pattern of subjectPatterns) assertValidRegexString(pattern, "upstream.subjectPatterns");

	const markerPaths = raw.markerPaths === undefined ? DEFAULT_UPSTREAM_CONFIG.markerPaths : raw.markerPaths;
	if (!Array.isArray(markerPaths) || !markerPaths.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("upstream.markerPaths must be an array of strings");
	}

	const foreignAuthorRatio =
		raw.foreignAuthorRatio === undefined ? DEFAULT_UPSTREAM_CONFIG.foreignAuthorRatio : raw.foreignAuthorRatio;
	if (typeof foreignAuthorRatio !== "number" || foreignAuthorRatio < 0 || foreignAuthorRatio > 1) {
		throw new ReelsConfigError("upstream.foreignAuthorRatio must be a number between 0 and 1");
	}

	return { subjectPatterns, markerPaths, foreignAuthorRatio };
}

function parseStory(raw: unknown): StoryConfig {
	if (raw === undefined) return DEFAULT_STORY_CONFIG;
	if (!isPlainObject(raw)) throw new ReelsConfigError("story must be an object");
	assertNoUnknownKeys(raw, ALLOWED_STORY_KEYS, "story");

	const directCommitTypes =
		raw.directCommitTypes === undefined ? DEFAULT_STORY_CONFIG.directCommitTypes : raw.directCommitTypes;
	if (!Array.isArray(directCommitTypes) || !directCommitTypes.every((t) => typeof t === "string")) {
		throw new ReelsConfigError("story.directCommitTypes must be an array of strings");
	}

	const maxBranchCommits =
		raw.maxBranchCommits === undefined ? DEFAULT_STORY_CONFIG.maxBranchCommits : raw.maxBranchCommits;
	if (typeof maxBranchCommits !== "number" || maxBranchCommits <= 0) {
		throw new ReelsConfigError("story.maxBranchCommits must be a positive number");
	}

	const minAttribution = raw.minAttribution === undefined ? DEFAULT_STORY_CONFIG.minAttribution : raw.minAttribution;
	if (typeof minAttribution !== "string" || !ATTRIBUTION_STRENGTHS.has(minAttribution)) {
		throw new ReelsConfigError('story.minAttribution must be "strong" or "weak"');
	}

	if (raw.model !== undefined) {
		if (typeof raw.model !== "string") throw new ReelsConfigError("story.model must be a string");
		assertValidModelSpec(raw.model, "story.model");
	}

	return {
		directCommitTypes,
		maxBranchCommits,
		minAttribution: minAttribution as AttributionStrength,
		model: raw.model as string | undefined,
	};
}

function parseDocs(raw: unknown): DocsConfig {
	if (raw === undefined) return DEFAULT_DOCS_CONFIG;
	if (!isPlainObject(raw)) throw new ReelsConfigError("docs must be an object");
	assertNoUnknownKeys(raw, ALLOWED_DOCS_KEYS, "docs");

	const allow = raw.allow === undefined ? DEFAULT_DOCS_CONFIG.allow : raw.allow;
	if (!Array.isArray(allow) || !allow.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("docs.allow must be an array of strings");
	}
	// docs.deny always extends DEFAULT_DOCS_CONFIG.deny, never replaces it: a
	// config author listing their own sensitive paths must not accidentally
	// un-deny .planning's state files by omission.
	const configuredDeny = raw.deny === undefined ? [] : raw.deny;
	if (!Array.isArray(configuredDeny) || !configuredDeny.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("docs.deny must be an array of strings");
	}
	const deny = Array.from(new Set([...DEFAULT_DOCS_CONFIG.deny, ...configuredDeny]));
	const maxChunks = raw.maxChunks === undefined ? DEFAULT_DOCS_CONFIG.maxChunks : raw.maxChunks;
	if (typeof maxChunks !== "number" || maxChunks <= 0) {
		throw new ReelsConfigError("docs.maxChunks must be a positive number");
	}

	return { allow, deny, maxChunks };
}

function parseCode(raw: unknown): CodeConfig {
	if (raw === undefined) return DEFAULT_CODE_CONFIG;
	if (!isPlainObject(raw)) throw new ReelsConfigError("code must be an object");
	assertNoUnknownKeys(raw, ALLOWED_CODE_KEYS, "code");

	const exclude = raw.exclude === undefined ? DEFAULT_CODE_CONFIG.exclude : raw.exclude;
	if (!Array.isArray(exclude) || !exclude.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("code.exclude must be an array of strings");
	}
	const include = raw.include === undefined ? DEFAULT_CODE_CONFIG.include : raw.include;
	if (!Array.isArray(include) || !include.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("code.include must be an array of strings");
	}

	return { exclude, include };
}

function parseProse(raw: unknown): ProseConfig {
	if (raw === undefined) return DEFAULT_PROSE_CONFIG;
	if (!isPlainObject(raw)) throw new ReelsConfigError("prose must be an object");
	assertNoUnknownKeys(raw, ALLOWED_PROSE_KEYS, "prose");

	const denyPatterns = raw.denyPatterns === undefined ? DEFAULT_PROSE_CONFIG.denyPatterns : raw.denyPatterns;
	if (!Array.isArray(denyPatterns) || !denyPatterns.every((p) => typeof p === "string")) {
		throw new ReelsConfigError("prose.denyPatterns must be an array of strings");
	}
	for (const pattern of denyPatterns) assertValidRegexString(pattern, "prose.denyPatterns");

	return { denyPatterns };
}

function parseBuild(raw: unknown): BuildConfig {
	if (raw === undefined) return DEFAULT_BUILD_CONFIG;
	if (!isPlainObject(raw)) throw new ReelsConfigError("build must be an object");
	assertNoUnknownKeys(raw, ALLOWED_BUILD_KEYS, "build");

	const maxCostUsd = raw.maxCostUsd === undefined ? DEFAULT_BUILD_CONFIG.maxCostUsd : raw.maxCostUsd;
	if (typeof maxCostUsd !== "number" || maxCostUsd <= 0) {
		throw new ReelsConfigError("build.maxCostUsd must be a positive number");
	}
	const maxLlmTokens = raw.maxLlmTokens === undefined ? DEFAULT_BUILD_CONFIG.maxLlmTokens : raw.maxLlmTokens;
	if (typeof maxLlmTokens !== "number" || maxLlmTokens <= 0) {
		throw new ReelsConfigError("build.maxLlmTokens must be a positive number");
	}
	const maxTtsChars = raw.maxTtsChars === undefined ? DEFAULT_BUILD_CONFIG.maxTtsChars : raw.maxTtsChars;
	if (typeof maxTtsChars !== "number" || maxTtsChars <= 0) {
		throw new ReelsConfigError("build.maxTtsChars must be a positive number");
	}
	if (raw.draftsDir !== undefined && typeof raw.draftsDir !== "string") {
		throw new ReelsConfigError("build.draftsDir must be a string");
	}

	return { maxCostUsd, maxLlmTokens, maxTtsChars, draftsDir: raw.draftsDir as string | undefined };
}

function parseOverrides(raw: unknown): Record<string, MergeOverride> {
	if (raw === undefined) return {};
	if (!isPlainObject(raw)) throw new ReelsConfigError("overrides must be an object");
	const overrides: Record<string, MergeOverride> = {};
	for (const [sha, value] of Object.entries(raw)) {
		if (typeof value !== "string" || !MERGE_OVERRIDES.has(value)) {
			throw new ReelsConfigError(`overrides["${sha}"] must be one of ${Array.from(MERGE_OVERRIDES).join(", ")}`);
		}
		overrides[sha] = value as MergeOverride;
	}
	return overrides;
}

/** Validates and normalizes a parsed `.reels.json` object. Pure: no file or git access. */
export function parseReelsConfig(raw: unknown): ReelsConfig {
	if (!isPlainObject(raw)) throw new ReelsConfigError("config must be a JSON object");
	assertNoUnknownKeys(raw, ALLOWED_TOP_LEVEL_KEYS, "config");

	const tagPattern = raw.tagPattern === undefined ? DEFAULT_TAG_PATTERN : raw.tagPattern;
	if (typeof tagPattern !== "string") throw new ReelsConfigError("tagPattern must be a string");
	assertValidRegexString(tagPattern, "tagPattern");

	if (raw.historyFloor !== undefined && typeof raw.historyFloor !== "string") {
		throw new ReelsConfigError("historyFloor must be a string");
	}

	return {
		tagPattern,
		historyFloor: raw.historyFloor as string | undefined,
		overrides: parseOverrides(raw.overrides),
		upstream: parseUpstream(raw.upstream),
		story: parseStory(raw.story),
		docs: parseDocs(raw.docs),
		code: parseCode(raw.code),
		prose: parseProse(raw.prose),
		build: parseBuild(raw.build),
	};
}

/** Reads and validates `.reels.json` (or an equivalent `--config` path). */
export async function loadReelsConfig(path: string): Promise<ReelsConfig> {
	const text = await readFile(path, "utf-8");
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		throw new ReelsConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
	}
	return parseReelsConfig(json);
}
