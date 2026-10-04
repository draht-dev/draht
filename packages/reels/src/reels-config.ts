/**
 * `.reels.json` schema and loader. This task (T1) only implements the keys
 * that `walkMainline` needs: `tagPattern`, `historyFloor`, `overrides`,
 * `upstream`, and `story`. Later tasks extend {@link ALLOWED_TOP_LEVEL_KEYS}
 * for `releases`, `docs`, `code`, and `prose` — until then those keys are
 * rejected like any other unknown key, so a config written against a newer
 * README does not silently no-op on an older build.
 */

import { readFile } from "node:fs/promises";

export type MergeOverride = "skip" | "feature" | "upstream-sync" | "back-merge";

const MERGE_OVERRIDES: ReadonlySet<string> = new Set(["skip", "feature", "upstream-sync", "back-merge"]);

export interface UpstreamConfig {
	/** Regex strings (case-insensitive) matched against a merge subject. */
	subjectPatterns: string[];
	/** Paths that, when touched by a merge's diff, mark it as an upstream sync. */
	markerPaths: string[];
	/** Share of foreign-author branch commits (of at least 20 sampled) that marks a merge as an upstream sync. */
	foreignAuthorRatio: number;
}

export interface StoryConfig {
	/** Conventional-commit types that make a direct mainline commit its own story. */
	directCommitTypes: string[];
	/** Branch commit count above which a non-sync merge is "oversized" rather than "feature". */
	maxBranchCommits: number;
}

export interface ReelsConfig {
	/** Regex string (anchored, case-sensitive unless the string embeds flags) matched against tag names. */
	tagPattern: string;
	/** A tag or sha that stops the mainline walk; history before it never yields stories. */
	historyFloor?: string;
	overrides: Readonly<Record<string, MergeOverride>>;
	upstream: UpstreamConfig;
	story: StoryConfig;
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
};

export const DEFAULT_REELS_CONFIG: ReelsConfig = {
	tagPattern: DEFAULT_TAG_PATTERN,
	overrides: {},
	upstream: DEFAULT_UPSTREAM_CONFIG,
	story: DEFAULT_STORY_CONFIG,
};

const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
	"tagPattern",
	"historyFloor",
	"overrides",
	"upstream",
	"story",
]);
const ALLOWED_UPSTREAM_KEYS: ReadonlySet<string> = new Set(["subjectPatterns", "markerPaths", "foreignAuthorRatio"]);
const ALLOWED_STORY_KEYS: ReadonlySet<string> = new Set(["directCommitTypes", "maxBranchCommits"]);

export class ReelsConfigError extends Error {}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			throw new ReelsConfigError(`unknown config key "${key}" in ${where}`);
		}
	}
}

function assertValidRegexString(pattern: string, where: string): void {
	try {
		// eslint-disable-next-line no-new
		new RegExp(pattern);
	} catch (err) {
		throw new ReelsConfigError(`invalid regular expression for ${where}: ${(err as Error).message}`);
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

	return { directCommitTypes, maxBranchCommits };
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
