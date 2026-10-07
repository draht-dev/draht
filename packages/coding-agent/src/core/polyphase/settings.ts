import { availableParallelism } from "os";
import type { PolyphaseSettings } from "../settings-manager.ts";

export interface ResolvedPolyphaseSettings {
	maxConcurrency: number;
	maxAgentsPerRun: number;
	maxItemsPerCall: number;
	workflowTool: "keyword" | "always" | "off";
	keyword: string;
	defaultBudgetTokens: number | null;
	resultChars: number;
	dock: boolean;
	maxDepth: number;
	liveUpdateMs: number;
	retainRuns: number;
	workflowTimeoutMs: number;
	warnings: string[];
}

const DEFAULT_KEYWORD = "polyphase";
const KEYWORD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{2,31}$/;
const WORKFLOW_TOOL_VALUES = new Set(["keyword", "always", "off"]);
const MIN_DEFAULT_BUDGET_TOKENS = 1000;
// Node's setTimeout silently truncates any larger delay to 1ms (TimeoutOverflowWarning).
const MAX_SET_TIMEOUT_MS = 2_147_483_647;

// Settings files are untyped JSON at runtime; a field declared `number` in PolyphaseSettings can
// still arrive as a string, null or NaN from a hand-edited settings.json.
function resolveClampedInt(
	raw: unknown,
	fieldName: string,
	fallback: number,
	min: number,
	max: number,
	warnings: string[],
): number {
	if (raw === undefined) return fallback;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		warnings.push(`Invalid polyphase.${fieldName} ${JSON.stringify(raw)}; falling back to ${fallback}.`);
		return fallback;
	}
	const floored = Math.floor(raw);
	const clamped = Math.min(max, Math.max(min, floored));
	if (clamped !== floored) {
		warnings.push(`polyphase.${fieldName} ${raw} is outside ${min}-${max}; using ${clamped}.`);
	}
	return clamped;
}

function resolveDefaultBudgetTokens(raw: unknown, warnings: string[]): number | null {
	if (raw === undefined) return null;
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		warnings.push(`Invalid polyphase.defaultBudgetTokens ${JSON.stringify(raw)}; falling back to unlimited.`);
		return null;
	}
	const floored = Math.floor(raw);
	const clamped = Math.min(Number.MAX_SAFE_INTEGER, Math.max(MIN_DEFAULT_BUDGET_TOKENS, floored));
	if (clamped !== floored) {
		warnings.push(
			`polyphase.defaultBudgetTokens ${raw} is outside ${MIN_DEFAULT_BUDGET_TOKENS}-${Number.MAX_SAFE_INTEGER}; using ${clamped}.`,
		);
	}
	return clamped;
}

export function resolvePolyphaseSettings(
	raw: PolyphaseSettings | undefined,
	cpuCount: number = availableParallelism(),
): ResolvedPolyphaseSettings {
	const warnings: string[] = [];
	const defaultMaxConcurrency = Math.min(8, Math.max(2, cpuCount - 2));

	const maxConcurrency = resolveClampedInt(
		raw?.maxConcurrency,
		"maxConcurrency",
		defaultMaxConcurrency,
		1,
		16,
		warnings,
	);
	const maxAgentsPerRun = resolveClampedInt(raw?.maxAgentsPerRun, "maxAgentsPerRun", 200, 1, 1000, warnings);
	const maxItemsPerCall = resolveClampedInt(raw?.maxItemsPerCall, "maxItemsPerCall", 1024, 1, 4096, warnings);
	const resultChars = resolveClampedInt(raw?.resultChars, "resultChars", 64_000, 8_000, 400_000, warnings);
	const maxDepth = resolveClampedInt(raw?.maxDepth, "maxDepth", 2, 1, 4, warnings);
	const liveUpdateMs = resolveClampedInt(raw?.liveUpdateMs, "liveUpdateMs", 250, 100, 2000, warnings);
	const retainRuns = resolveClampedInt(raw?.retainRuns, "retainRuns", 20, 1, 100, warnings);
	const workflowTimeoutMs = resolveClampedInt(
		raw?.workflowTimeoutMs,
		"workflowTimeoutMs",
		0,
		0,
		MAX_SET_TIMEOUT_MS,
		warnings,
	);

	const defaultBudgetTokens = resolveDefaultBudgetTokens(raw?.defaultBudgetTokens, warnings);

	let workflowTool: "keyword" | "always" | "off" = "keyword";
	if (raw?.workflowTool !== undefined) {
		if (WORKFLOW_TOOL_VALUES.has(raw.workflowTool)) {
			workflowTool = raw.workflowTool;
		} else {
			warnings.push(`Invalid polyphase.workflowTool "${raw.workflowTool}"; falling back to "keyword".`);
		}
	}

	let keyword = DEFAULT_KEYWORD;
	if (raw?.keyword !== undefined) {
		if (typeof raw.keyword === "string" && KEYWORD_PATTERN.test(raw.keyword)) {
			keyword = raw.keyword;
		} else {
			warnings.push(
				`Invalid polyphase.keyword ${JSON.stringify(raw.keyword)}; falling back to "${DEFAULT_KEYWORD}".`,
			);
		}
	}

	let dock = true;
	if (raw?.dock !== undefined) {
		if (typeof raw.dock === "boolean") {
			dock = raw.dock;
		} else {
			warnings.push(`Invalid polyphase.dock ${JSON.stringify(raw.dock)}; falling back to true.`);
		}
	}

	return {
		maxConcurrency,
		maxAgentsPerRun,
		maxItemsPerCall,
		workflowTool,
		keyword,
		defaultBudgetTokens,
		resultChars,
		dock,
		maxDepth,
		liveUpdateMs,
		retainRuns,
		workflowTimeoutMs,
		warnings,
	};
}
