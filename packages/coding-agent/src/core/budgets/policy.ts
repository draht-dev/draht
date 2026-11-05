import { diffLines } from "diff";
import { countTokens as countCl100kTokens } from "gpt-tokenizer/encoding/cl100k_base";

const MAX_DIFF_EDIT_LENGTH = 4096;
const ORDINARY_TEXT = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() };

export interface BudgetLimits {
	maxFileTokens: number;
	maxDocFileTokens: number;
	maxCodeTokens: number | null;
	maxDocTokens: number | null;
	maxOversizedGrowthTokens: number;
}

export const DEFAULT_BUDGET_LIMITS: Readonly<BudgetLimits> = Object.freeze({
	maxFileTokens: 5000,
	maxDocFileTokens: 1500,
	maxCodeTokens: null,
	maxDocTokens: null,
	maxOversizedGrowthTokens: 250,
});

const LIMIT_KEYS = Object.keys(DEFAULT_BUDGET_LIMITS);

function parseCount(value: unknown, key: keyof BudgetLimits, minimum: 0 | 1): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		const kind = minimum === 0 ? "a non-negative" : "a positive";
		throw new Error(`Invalid budget limit ${key}: expected ${kind} safe integer`);
	}
	return value;
}

function parseTaskLimit(value: unknown, key: "maxCodeTokens" | "maxDocTokens"): number | null {
	return value === null ? null : parseCount(value, key, 1);
}

export function parseBudgetLimits(input: unknown): BudgetLimits {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Budget limits must be an object");
	}
	for (const key of Object.keys(input)) {
		if (!LIMIT_KEYS.includes(key)) throw new Error(`Unknown budget limit: ${key}`);
	}
	return {
		maxFileTokens:
			"maxFileTokens" in input
				? parseCount(input.maxFileTokens, "maxFileTokens", 1)
				: DEFAULT_BUDGET_LIMITS.maxFileTokens,
		maxDocFileTokens:
			"maxDocFileTokens" in input
				? parseCount(input.maxDocFileTokens, "maxDocFileTokens", 1)
				: DEFAULT_BUDGET_LIMITS.maxDocFileTokens,
		maxCodeTokens:
			"maxCodeTokens" in input
				? parseTaskLimit(input.maxCodeTokens, "maxCodeTokens")
				: DEFAULT_BUDGET_LIMITS.maxCodeTokens,
		maxDocTokens:
			"maxDocTokens" in input
				? parseTaskLimit(input.maxDocTokens, "maxDocTokens")
				: DEFAULT_BUDGET_LIMITS.maxDocTokens,
		maxOversizedGrowthTokens:
			"maxOversizedGrowthTokens" in input
				? parseCount(input.maxOversizedGrowthTokens, "maxOversizedGrowthTokens", 0)
				: DEFAULT_BUDGET_LIMITS.maxOversizedGrowthTokens,
	};
}

export function countTokens(text: string): number {
	return countCl100kTokens(text, ORDINARY_TEXT);
}

const DOCUMENTATION = /\.(?:md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;
const TEXT_CODE = /(?:^|\/)(?:CMakeLists|requirements[^/]*|constraints[^/]*)\.txt$/i;

/** Prose files use the documentation limit; build and dependency lists that happen to end in .txt are code. */
export function budgetCategory(path: string): "code" | "docs" {
	return DOCUMENTATION.test(path) && !TEXT_CODE.test(path) ? "docs" : "code";
}

/** Token counts of one change, independent of limits, so they can be cached by content. */
export interface MeasuredTokens {
	addedTokens: number;
	deletedTokens: number;
	fileTokens: number;
	baselineTokens: number;
}

export interface BudgetChange {
	path: string;
	category: "code" | "docs";
	addedTokens: number;
	deletedTokens: number;
	fileTokens: number;
	fileCeiling: number;
	fileLimitExceeded: boolean;
}

/** A file already over its limit at task start may grow by the configured allowance; others keep the limit. */
export function fileCeiling(limit: number, baselineTokens: number, growthTokens: number): number {
	return baselineTokens > limit ? baselineTokens + growthTokens : limit;
}

export function measureTokens(before: string | null, after: string | null): MeasuredTokens {
	const baselineTokens = countTokens(before ?? "");
	const fileTokens = countTokens(after ?? "");
	let addedTokens = before ? 0 : fileTokens;
	let deletedTokens = after ? 0 : baselineTokens;
	if (before && after && before !== after) {
		const changes = diffLines(before, after, { maxEditLength: MAX_DIFF_EDIT_LENGTH });
		if (!changes) {
			// Beyond the bounded search, charge a deterministic whole-file replacement, including unchanged context.
			addedTokens = fileTokens;
			deletedTokens = baselineTokens;
		} else {
			for (const change of changes) {
				if (change.added) addedTokens += countTokens(change.value);
				if (change.removed) deletedTokens += countTokens(change.value);
			}
		}
	}
	return { addedTokens, deletedTokens, fileTokens, baselineTokens };
}

export function budgetChange(path: string, measured: MeasuredTokens, limits: BudgetLimits): BudgetChange {
	const category = budgetCategory(path);
	const limit = category === "docs" ? limits.maxDocFileTokens : limits.maxFileTokens;
	const ceiling = fileCeiling(limit, measured.baselineTokens, limits.maxOversizedGrowthTokens);
	return {
		path,
		category,
		addedTokens: measured.addedTokens,
		deletedTokens: measured.deletedTokens,
		fileTokens: measured.fileTokens,
		fileCeiling: ceiling,
		fileLimitExceeded: measured.fileTokens > ceiling,
	};
}

export function measureChange(options: {
	path: string;
	before: string | null;
	after: string | null;
	limits: BudgetLimits;
}): BudgetChange {
	return budgetChange(options.path, measureTokens(options.before, options.after), options.limits);
}
