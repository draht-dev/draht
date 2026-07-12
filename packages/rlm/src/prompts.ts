/**
 * Prompt tier selection and templating for `@draht/rlm`'s root loop.
 *
 * Three tuned system-prompt templates (`packages/rlm/prompts/*.md`) mirror
 * the technique's documented mechanics (root LM writes Python that peeks,
 * chunks, and searches `context`, calls `llm_query` for recursive sub-calls,
 * terminates via `FINAL`/`FINAL_VAR` — see R26-RLM.4-7) at three levels of
 * verbosity, auto-selected from the resolved root model's context window per
 * R27-SLM.1/.4. See .planning/phases/27-sub-llm-integration/27-01-PLAN.md,
 * Architecture sections 3-4.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

export type PromptTier = "frontier" | "coder-mid" | "small-context";

/** Substitution variables for {@link renderPrompt}. */
export interface PromptVars {
	/** What kind of content `context` holds (e.g. "text", "code", "logs", "json"). */
	contextType: string;
	/** Total character length of the full `context` string. */
	contextTotalLength: number;
	/** Suggested chunk boundary sizes (characters), in order. */
	chunkLengths: number[];
	/** Max number of `llm_query` sub-calls allowed this session. */
	maxSubCallBudget: number;
	/** Max characters per `llm_query` sub-call prompt. */
	subCallCharBudget: number;
}

const TIER_FILENAMES: Record<PromptTier, string> = {
	frontier: "frontier.md",
	"coder-mid": "coder-mid.md",
	"small-context": "small-context.md",
};

// Templates are static files on disk; read once per tier and cache rather
// than re-reading on every renderPrompt() call.
const templateCache = new Map<PromptTier, string>();

function loadTemplate(tier: PromptTier): string {
	const cached = templateCache.get(tier);
	if (cached !== undefined) return cached;
	const path = join(PROMPTS_DIR, TIER_FILENAMES[tier]);
	const template = readFileSync(path, "utf8");
	templateCache.set(tier, template);
	return template;
}

/**
 * Picks a prompt tier from the resolved root model's `contextWindow`
 * (per @draht/ai's `Model.contextWindow`).
 *
 * Thresholds (chosen to track real-world context-window tiers rather than
 * arbitrary round numbers):
 *  - `>= 500_000`: "frontier" — models with genuinely huge (500k-2M token)
 *    windows (e.g. 1M-context Claude/Gemini variants) that can afford a
 *    terser prompt because they have ample headroom even after the
 *    constant-size history metadata (R26-RLM.7) accumulates over many
 *    steps.
 *  - `>= 128_000`: "coder-mid" — 128k-500k is the most common modern
 *    context ceiling (GPT-4-class, Claude default, DeepSeek-V3, etc.);
 *    plenty of room for a step-by-step prompt but not so much that
 *    verbosity is free.
 *  - below `128_000`: "small-context" — constrained-window models need the
 *    most explicit scaffolding and the smallest suggested chunk/peek sizes,
 *    since the prompt itself is a proportionally larger share of their
 *    budget.
 */
export function selectTier(contextWindow: number): PromptTier {
	if (contextWindow >= 500_000) return "frontier";
	if (contextWindow >= 128_000) return "coder-mid";
	return "small-context";
}

/** Simple `{{token}}` substitution -- no templating engine dependency needed. */
export function renderPrompt(tier: PromptTier, vars: PromptVars): string {
	const template = loadTemplate(tier);
	return template
		.replaceAll("{{context_type}}", vars.contextType)
		.replaceAll("{{context_total_length}}", String(vars.contextTotalLength))
		.replaceAll("{{chunk_lengths}}", JSON.stringify(vars.chunkLengths))
		.replaceAll("{{max_sub_call_budget}}", String(vars.maxSubCallBudget))
		.replaceAll("{{sub_call_char_budget}}", String(vars.subCallCharBudget));
}
