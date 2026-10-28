/**
 * Workflow token-budget and time-limit directives (D-B): a `+500k`/`+30min`-style token the user
 * types in their own prompt, else a tool/command parameter, else config, else none. See
 * docs/polyphase.md "Limits" for the full grammar and precedence.
 */

import { MAX_SET_TIMEOUT_MS } from "../settings.ts";
import type { LimitSource } from "../types.ts";

/** Extra wall-clock time the hard sandbox deadline keeps past a resolved graceful time limit, so
 * agents already in flight when the limit fires have a window to wind down before the sandbox
 * itself is killed. */
export const TIME_LIMIT_BACKSTOP_MS = 60_000;

/** The longest time limit that still fits one `setTimeout` together with its backstop. Node turns
 * any longer delay into 1ms, so an over-long limit would cancel every agent the moment it started;
 * longer requests are capped here instead. */
export const MAX_TIME_LIMIT_MS = MAX_SET_TIMEOUT_MS - TIME_LIMIT_BACKSTOP_MS;

export interface ParsedDirectives {
	budgetTokens: number | null;
	timeLimitMs: number | null;
}

export interface ResolvedLimit {
	value: number | null;
	source: LimitSource;
}

export interface ResolvedWorkflowLimits {
	budgetTokens: ResolvedLimit;
	timeLimitMs: ResolvedLimit;
}

const MIN_DIRECTIVE_BUDGET_TOKENS = 1000;

/** A `+`-prefixed token standing alone as a word: `+` immediately followed by a digit (so `+abc`,
 * `+-5` and a bare `+` never match), bounded by whitespace or the start/end of the string on both
 * sides. One bounded character class per side, no nested quantifiers: linear in the input length. */
const DIRECTIVE_TOKEN_PATTERN = /(?<=^|\s)\+[0-9][0-9A-Za-z.]*(?=$|\s)/g;

type Classified = { kind: "budget"; tokens: number } | { kind: "time"; ms: number };

/** A zero duration is no time limit at all, so it is not a time directive either (it would show as
 * "time limit 0s" while the run ignored it); anything longer than {@link MAX_TIME_LIMIT_MS} is
 * capped to it. */
function timeDirective(ms: number): Classified | undefined {
	if (!(ms > 0)) return undefined;
	return { kind: "time", ms: Math.min(ms, MAX_TIME_LIMIT_MS) };
}

/** `rest` is the token's text after the leading `+` (e.g. "500k", "1.5M", "30min", "1h30min"). */
function classifyDirectiveBody(rest: string): Classified | undefined {
	const compoundHourMinute = /^(\d+)(?:h|hr)(\d+)min$/i.exec(rest);
	if (compoundHourMinute) {
		const hours = Number(compoundHourMinute[1]);
		const minutes = Number(compoundHourMinute[2]);
		return timeDirective((hours * 3600 + minutes * 60) * 1000);
	}

	// "m"/"M" alone is excluded here on purpose: a bare "m" suffix means "million tokens" (the
	// budget grammar below), never "minutes" — only the full words "min"/"sec"/"hr" (or "s"/"h")
	// are time units.
	const simpleTime = /^(\d+)(h|hr|min|sec|s)$/i.exec(rest);
	if (simpleTime) {
		const amount = Number(simpleTime[1]);
		const unit = simpleTime[2].toLowerCase();
		const seconds = unit === "h" || unit === "hr" ? amount * 3600 : unit === "min" ? amount * 60 : amount;
		return timeDirective(seconds * 1000);
	}

	const budget = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(rest);
	if (budget) {
		const amount = Number.parseFloat(budget[1]);
		const suffix = budget[2]?.toLowerCase();
		const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
		const tokens = Math.round(amount * multiplier);
		if (Number.isSafeInteger(tokens) && tokens >= MIN_DIRECTIVE_BUDGET_TOKENS) return { kind: "budget", tokens };
	}

	return undefined;
}

interface DirectiveMatch {
	token: string;
	index: number;
	classified: Classified;
}

function findDirectives(text: string): DirectiveMatch[] {
	const matches: DirectiveMatch[] = [];
	for (const match of text.matchAll(DIRECTIVE_TOKEN_PATTERN)) {
		const classified = classifyDirectiveBody(match[0].slice(1));
		if (classified && match.index !== undefined) matches.push({ token: match[0], index: match.index, classified });
	}
	return matches;
}

/** The first `+500k`/`+1.5M`/`+200000`-style token (min 1000 tokens) and the first
 * `+30min`/`+2h`/`+90s`/`+1h30min`-style token anywhere in `text`, each independent of the other. */
export function parsePromptDirectives(text: string): ParsedDirectives {
	const result: ParsedDirectives = { budgetTokens: null, timeLimitMs: null };
	for (const match of findDirectives(text)) {
		if (match.classified.kind === "budget" && result.budgetTokens === null)
			result.budgetTokens = match.classified.tokens;
		if (match.classified.kind === "time" && result.timeLimitMs === null) result.timeLimitMs = match.classified.ms;
		if (result.budgetTokens !== null && result.timeLimitMs !== null) break;
	}
	return result;
}

/** Removes every recognized directive token from `text` (e.g. command args) by cutting out the
 * matched positions, not by a substring replace: a glued, non-standalone occurrence (e.g. the
 * `+500k` inside `v+500k`) was never matched by `findDirectives` and is left untouched, and a
 * standalone token that happens to be a textual prefix of another standalone token (e.g. `+1000`
 * inside `+10000`) only removes its own matched span. Collapses the whitespace immediately next to
 * each removed span, not every run of whitespace in `text`. A `+`-token that didn't classify (too
 * small, malformed unit) is left untouched — it was never a directive. */
export function stripPromptDirectives(text: string): string {
	const matches = findDirectives(text).sort((a, b) => b.index - a.index);
	if (matches.length === 0) return text;
	let result = text;
	for (const match of matches) {
		const before = result.slice(0, match.index);
		const after = result.slice(match.index + match.token.length);
		const beforeTrimmed = before.replace(/[ \t]+$/, "");
		const afterTrimmed = after.replace(/^[ \t]+/, "");
		const hadAdjacentSpace = beforeTrimmed.length !== before.length || afterTrimmed.length !== after.length;
		const joiner = beforeTrimmed.length === 0 || afterTrimmed.length === 0 ? "" : hadAdjacentSpace ? " " : "";
		result = beforeTrimmed + joiner + afterTrimmed;
	}
	return result.trim();
}

/** Same grammar as the budget/time directive bodies, without the leading `+`: used for the
 * `timeLimit` tool parameter. `undefined` when `text` is not a valid duration. */
export function parseDurationMs(text: string): number | undefined {
	const classified = classifyDirectiveBody(text);
	return classified?.kind === "time" ? classified.ms : undefined;
}

function resolve(
	prompt: number | null | undefined,
	tool: number | null | undefined,
	config: number | null,
): ResolvedLimit {
	if (prompt !== null && prompt !== undefined) return { value: prompt, source: "prompt" };
	if (tool !== null && tool !== undefined) return { value: tool, source: "tool" };
	if (config !== null) return { value: config, source: "config" };
	return { value: null, source: "none" };
}

/** A steer or follow-up typed while a turn runs (`streamingBehavior` set) only adds what it states:
 * `update`'s limits over `base`'s, keeping `base`'s where `update` names none. A prompt that starts a
 * turn replaces the directives instead (the caller decides which). */
export function mergePromptDirectives(base: ParsedDirectives | undefined, update: ParsedDirectives): ParsedDirectives {
	return {
		budgetTokens: update.budgetTokens ?? base?.budgetTokens ?? null,
		timeLimitMs: update.timeLimitMs ?? base?.timeLimitMs ?? null,
	};
}

export interface ResolveWorkflowLimitsOptions {
	prompt?: ParsedDirectives;
	tool?: { budgetTokens?: number | null; timeLimitMs?: number | null };
	config: { budgetTokens: number | null; timeLimitMs: number | null };
}

/** Same cap as a directive's, for a time limit from config, whose own clamp allows the full
 * `setTimeout` range and leaves no room for the backstop. */
function capTimeLimit(ms: number | null | undefined): number | null | undefined {
	return typeof ms === "number" ? Math.min(ms, MAX_TIME_LIMIT_MS) : ms;
}

/** Precedence, independently for the token budget and the time limit: prompt directive, else tool
 * parameter, else config, else none. */
export function resolveWorkflowLimits(options: ResolveWorkflowLimitsOptions): ResolvedWorkflowLimits {
	return {
		budgetTokens: resolve(options.prompt?.budgetTokens, options.tool?.budgetTokens, options.config.budgetTokens),
		timeLimitMs: resolve(
			capTimeLimit(options.prompt?.timeLimitMs),
			capTimeLimit(options.tool?.timeLimitMs),
			capTimeLimit(options.config.timeLimitMs) ?? null,
		),
	};
}

/** The sandbox's own hard deadline: `timeLimitMs + 60s` when a time limit resolved, else disabled
 * (0). There is no separate "config" hard-timeout concept anymore — `polyphase.workflowTimeoutMs`
 * is itself one of the possible sources of the graceful time limit above. Never past what one
 * `setTimeout` can wait. */
export function hardSandboxTimeoutMs(resolvedTimeLimitMs: number | null): number {
	return resolvedTimeLimitMs !== null ? Math.min(resolvedTimeLimitMs + TIME_LIMIT_BACKSTOP_MS, MAX_SET_TIMEOUT_MS) : 0;
}

function trimDecimal(value: number): string {
	return Number(value.toFixed(1)).toString();
}

function formatApproxTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}m`;
	if (tokens >= 1_000) {
		const kilos = trimDecimal(tokens / 1_000);
		// toFixed(1) can round up to "1000.0", which would display as "1000k" instead of "1m".
		if (Number(kilos) >= 1000) return `${trimDecimal(tokens / 1_000_000)}m`;
		return `${kilos}k`;
	}
	return `${tokens}`;
}

/** `1h30min`, `30min`, `90s` → `1min30s`: the one spelling of a limit's duration, wherever it
 * is shown (approval, log lines, result text, tool row). */
export function formatLimitDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}min`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return parts.join("");
}

function sourceText(source: LimitSource): string | undefined {
	switch (source) {
		case "prompt":
			return "from your prompt";
		case "tool":
			return "set by the model";
		case "config":
			return "from settings";
		case "none":
			return undefined;
	}
}

/** `budget 500k tokens (from your prompt)`, or `no token budget` when absent. */
export function formatBudgetLimitText(limit: ResolvedLimit): string {
	if (limit.value === null) return "no token budget";
	const source = sourceText(limit.source);
	return `budget ${formatApproxTokens(limit.value)} tokens${source ? ` (${source})` : ""}`;
}

/** `time limit 30min (from your prompt)`, or `no time limit` when absent. */
export function formatTimeLimitText(limit: ResolvedLimit): string {
	if (limit.value === null) return "no time limit";
	const source = sourceText(limit.source);
	return `time limit ${formatLimitDuration(limit.value)}${source ? ` (${source})` : ""}`;
}

const NO_LIMITS_DISCLAIMER =
	"no token budget and no time limit: runs until the workflow reaches its goal (add +500k or +30min to your prompt, or set polyphase.defaultBudgetTokens / polyphase.workflowTimeoutMs)";
const NO_BUDGET_DISCLAIMER = "no token budget (add +500k to your prompt, or set polyphase.defaultBudgetTokens)";
const NO_TIME_LIMIT_DISCLAIMER = "no time limit (add +30min to your prompt, or set polyphase.workflowTimeoutMs)";

/** The disclaimer shown (in the approval prompt, the start narrator line, and the final result
 * text) when one or both limits are absent, naming only the missing one(s) and how to add them.
 * "Runs until the workflow reaches its goal" is only said with neither limit: a time limit alone
 * still ends the run. `undefined` when both are set. */
export function formatMissingLimitsDisclaimer(limits: ResolvedWorkflowLimits): string | undefined {
	const budgetMissing = limits.budgetTokens.value === null;
	const timeMissing = limits.timeLimitMs.value === null;
	if (budgetMissing && timeMissing) return NO_LIMITS_DISCLAIMER;
	if (budgetMissing) return NO_BUDGET_DISCLAIMER;
	if (timeMissing) return NO_TIME_LIMIT_DISCLAIMER;
	return undefined;
}

/** One line summarizing both limits, used identically by the approval prompt, the start narrator
 * log line, and the final result text's `Limits:` line. Each limit is named exactly once: by its
 * value and source when set, by its disclaimer when not. */
export function formatWorkflowLimitsLine(limits: ResolvedWorkflowLimits): string {
	const budgetMissing = limits.budgetTokens.value === null;
	const timeMissing = limits.timeLimitMs.value === null;
	if (budgetMissing && timeMissing) return NO_LIMITS_DISCLAIMER;
	const budget = budgetMissing ? NO_BUDGET_DISCLAIMER : formatBudgetLimitText(limits.budgetTokens);
	const time = timeMissing ? NO_TIME_LIMIT_DISCLAIMER : formatTimeLimitText(limits.timeLimitMs);
	return `${budget} · ${time}`;
}
