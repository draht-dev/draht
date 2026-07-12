/**
 * The subagent recognizer — spec §6/§7: "typed lanes are a recognizer, not an
 * import". Upgrading a generic tool-call lane into a typed one is a
 * DATA-DRIVEN lookup, not a dependency on any harness's package. This module
 * imports zero `@draht/*` and zero ACP types; it matches on the ACP-free
 * {@link GenericToolCallEvent} fields (spec §17.1 boundary).
 *
 * The recognizer is a lookup TABLE ({@link SUBAGENT_RECOGNIZERS}), not a
 * hardcoded switch: adding a harness convention is a new table row, and every
 * row is golden-tested (spec §18: "recognizer goldens updated with recognizer
 * changes").
 */

import { type GenericToolCallEvent, type Lane, toLane, toToolLaneBase } from "./lane.js";

/**
 * One data-driven recognizer entry: a predicate over an ACP-free tool-call
 * event plus the best-effort subagent descriptor to pull from it when matched.
 * Adding a harness convention = adding a row to {@link SUBAGENT_RECOGNIZERS}.
 */
export interface SubagentRecognizer {
	/** Stable id recorded on the upgraded lane as `recognizedBy`. */
	readonly id: string;
	/** True when the event looks like this convention's sub-agent-spawning call. */
	readonly matches: (event: GenericToolCallEvent) => boolean;
	/**
	 * Best-effort subagent descriptor extracted from the event (only the
	 * `title` is available — geist-core has no ACP payload), or `undefined`.
	 */
	readonly subagentType: (event: GenericToolCallEvent) => string | undefined;
}

/**
 * draht's `subagent` tool (packages/coding-agent/src/core/builtins/subagent.ts:
 * `name: "subagent"`, `label: "Subagent"`, TUI titles "subagent chain" /
 * "subagent parallel"). Matched case-insensitively as the bare word or a
 * `subagent <mode>` title, so a tool merely *starting* with "subagent…"
 * (e.g. "subagentmanager") is NOT a false positive.
 */
function matchesDrahtSubagent(event: GenericToolCallEvent): boolean {
	const title = event.title?.trim().toLowerCase() ?? "";
	return title === "subagent" || title.startsWith("subagent ");
}

/** Pulls draht's dispatch mode (`single`/`parallel`/`chain`) from the title. */
function drahtSubagentType(event: GenericToolCallEvent): string | undefined {
	const rest = (event.title?.trim().toLowerCase() ?? "").slice("subagent".length).trim();
	if (rest.startsWith("parallel")) return "parallel";
	if (rest.startsWith("chain")) return "chain";
	if (rest.startsWith("single")) return "single";
	return undefined;
}

/**
 * Claude Code's `Task` tool (the "Claude-Task-style" call spec §6 names), whose
 * `subagent_type` param typically surfaces in the title as `Task(<type>)`.
 * Matched on a leading `Task` word so "Taskbar"-style titles don't false-match.
 */
function matchesClaudeTask(event: GenericToolCallEvent): boolean {
	return /^Task\b/.test(event.title?.trim() ?? "");
}

/** Pulls the parenthesized subagent type from a `Task(<type>)` title. */
function claudeTaskType(event: GenericToolCallEvent): string | undefined {
	const paren = event.title?.match(/\(([^)]+)\)/);
	return paren ? paren[1].trim() : undefined;
}

/**
 * The recognizer table. Ordered: the first matching row wins (draht's
 * `subagent` and Claude's `Task` are disjoint, so order is not load-bearing
 * today, but a first-match rule keeps future rows predictable).
 */
export const SUBAGENT_RECOGNIZERS: readonly SubagentRecognizer[] = [
	{ id: "draht", matches: matchesDrahtSubagent, subagentType: drahtSubagentType },
	{ id: "claude-task", matches: matchesClaudeTask, subagentType: claudeTaskType },
];

/**
 * Runs the generic {@link toLane} first, then consults the recognizer table:
 * returns a typed "subagent" {@link Lane} if a row matches, else the generic
 * lane unchanged. This is the whole contract of spec §7's "a recognizer that
 * upgrades a generic lane into a typed one".
 */
export function recognizeSubagentLane(event: GenericToolCallEvent): Lane {
	for (const recognizer of SUBAGENT_RECOGNIZERS) {
		if (!recognizer.matches(event)) continue;
		const subagentType = recognizer.subagentType(event);
		return {
			kind: "subagent",
			...toToolLaneBase(event),
			recognizedBy: recognizer.id,
			...(subagentType !== undefined && { subagentType }),
		};
	}
	return toLane(event);
}
