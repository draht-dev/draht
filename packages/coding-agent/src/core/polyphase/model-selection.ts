/**
 * Model and thinking-level selection for a child run (§7.5, D1).
 *
 * Precedence, first match wins: an explicit override, a workflow phase model, the
 * agent's frontmatter model, the parent session's model (inherited), or the child's
 * own default when nothing else applies.
 */

import type { ThinkingLevel } from "@draht/agent-core";
import type { Api, Model } from "@draht/ai";
import { parseModelPattern } from "../model-resolver.ts";
import { type AgentModelInfo, isThinkingLevel, type ModelSource } from "./types.ts";

export class ModelSelectionError extends Error {}

export interface ChildModelInput {
	/** Tool parameter / `agent()` opts.model. */
	override?: string;
	/** Tool parameter thinking / `agent()` opts.effort. */
	effort?: string;
	/** Workflow meta phase model. */
	phaseModel?: string;
	/** Agent frontmatter model, verbatim (may carry a `:level` suffix). */
	agentModel?: string;
	parentModel?: Model<Api>;
	parentThinking?: ThinkingLevel;
	available: Model<Api>[];
}

export interface ChildModelChoice {
	/** Value to pass with `--model`, when the child should be told which model to use. */
	modelArg?: string;
	thinking?: ThinkingLevel;
	info: AgentModelInfo;
}

/** `"none"` maps to `"off"`; otherwise a `ThinkingLevel`. Throws `ModelSelectionError` for anything else. */
export function normalizeEffort(effort: string): ThinkingLevel {
	if (effort === "none") return "off";
	if (isThinkingLevel(effort)) return effort;
	throw new ModelSelectionError(`unknown thinking level "${effort}"`);
}

interface ParsedPattern {
	provider?: string;
	id?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Strict resolution (no invalid-thinking-level fallback): throws when the pattern matches nothing. */
function resolveStrict(pattern: string, available: Model<Api>[]): ParsedPattern {
	const result = parseModelPattern(pattern, available, { allowInvalidThinkingLevelFallback: false });
	if (!result.model) throw new ModelSelectionError(`unknown model "${pattern}"`);
	return { provider: result.model.provider, id: result.model.id, thinkingLevel: result.thinkingLevel };
}

/** Best-effort resolution for display only: never throws, leaves provider/id undefined when unresolved. */
function resolveForDisplay(pattern: string, available: Model<Api>[]): ParsedPattern {
	const result = parseModelPattern(pattern, available, { allowInvalidThinkingLevelFallback: false });
	return result.model
		? { provider: result.model.provider, id: result.model.id, thinkingLevel: result.thinkingLevel }
		: {};
}

function choiceFor(
	source: ModelSource,
	requested: string | undefined,
	parsed: ParsedPattern,
	thinking: ThinkingLevel | undefined,
	modelArg: string | undefined,
): ChildModelChoice {
	return {
		modelArg,
		thinking,
		info: {
			source,
			requested,
			requestedThinking: thinking,
			provider: parsed.provider,
			id: parsed.id,
			confirmed: false,
		},
	};
}

export function resolveChildModel(input: ChildModelInput): ChildModelChoice {
	const normalizedEffort = input.effort !== undefined ? normalizeEffort(input.effort) : undefined;

	if (input.override !== undefined) {
		const parsed = resolveStrict(input.override, input.available);
		const thinking = normalizedEffort ?? parsed.thinkingLevel;
		return choiceFor("override", input.override, parsed, thinking, `${parsed.provider}/${parsed.id}`);
	}

	if (input.phaseModel !== undefined) {
		const parsed = resolveStrict(input.phaseModel, input.available);
		const thinking = normalizedEffort ?? parsed.thinkingLevel;
		return choiceFor("phase", input.phaseModel, parsed, thinking, `${parsed.provider}/${parsed.id}`);
	}

	if (input.agentModel !== undefined) {
		const parsed = resolveForDisplay(input.agentModel, input.available);
		return choiceFor("frontmatter", input.agentModel, parsed, normalizedEffort, input.agentModel);
	}

	if (input.parentModel !== undefined) {
		const thinking = normalizedEffort ?? input.parentThinking;
		const parsed: ParsedPattern = { provider: input.parentModel.provider, id: input.parentModel.id };
		const requested = `${input.parentModel.provider}/${input.parentModel.id}`;
		return choiceFor("inherited", requested, parsed, thinking, requested);
	}

	return choiceFor("child-default", undefined, {}, normalizedEffort, undefined);
}
