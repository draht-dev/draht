/**
 * Cost-comparison harness: RLM trajectory cost vs. a truncate-and-single-call
 * baseline for the same task.
 *
 * `rlmCostUsd` is the real, already-incurred cost of a trajectory recovered
 * from `@draht/router`'s cost log (every root + sub call `createRouterBackedSession`
 * logs is tagged with one `trajectoryId` -- see router-session.ts). There is
 * nothing to "compare" about that half; it's just a sum-and-filter over
 * already-logged `CostEntry` rows.
 *
 * `baselineCostUsd` is necessarily an *estimate*, not a measurement: it models
 * the cost of the simplest plausible non-RLM alternative for an oversize
 * task -- truncate the context down to whatever fits the target model's
 * context window, then make one single call -- and prices that hypothetical
 * call via `@draht/router`'s `estimateCost`. The specific truncation strategy
 * modeled here is deliberately the crudest one: keep the first N characters
 * of the context that fit the window (a `CHARS_PER_TOKEN` heuristic converts
 * the token-denominated `contextWindow` into a character budget). A smarter
 * baseline (e.g. picking the *most relevant* N characters via embedding
 * search, or summarizing before truncating) would likely produce different
 * numbers -- that's out of scope here. This harness answers "what would the
 * cheapest naive single-call alternative have cost", not "what is the best
 * possible non-RLM approach". See
 * .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
 * section 3, and its Risks section.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { estimateCost, readCostLog } from "@draht/router";

/** Which target model the truncate-and-single-call baseline is priced against. */
export interface BaselineModel {
	provider: string;
	modelName: string;
	/** Context window, in tokens -- used to compute how much of the context the baseline call could fit after truncation. */
	contextWindow: number;
}

/** Result of comparing one RLM trajectory's real cost against a truncate-and-single-call baseline for the same task. */
export interface CostComparisonResult {
	/**
	 * Identifies which task/trajectory this comparison covers. There is no
	 * separate task-name concept tracked elsewhere in this codebase, so this
	 * is the `trajectoryId` itself -- callers that want a human-readable label
	 * should track that mapping themselves.
	 */
	task: string;
	/** Sum of every cost-log entry (root call + every `llm_query` sub-call) tagged with this trajectoryId. */
	rlmCostUsd: number;
	/**
	 * Estimated cost of truncating the context to fit `model`'s window and
	 * making one single call instead (see the module doc for the exact
	 * truncation approach modeled).
	 */
	baselineCostUsd: number;
	/** Number of root-LLM steps the RLM trajectory took (one "rlm-root"-role cost entry per step -- see router-session.ts's `rootLlm`). */
	rlmSteps: number;
	/** The full (untruncated) context length, in characters, the RLM trajectory operated over. */
	contextLengthChars: number;
}

/**
 * Rough heuristic: ~4 characters per token for English-ish text. This is the
 * same order-of-magnitude approximation used broadly across LLM tooling when
 * an exact tokenizer isn't wired in for a given model -- it is NOT
 * model-exact, and the `baselineCostUsd` this produces should be read as
 * "same ballpark", not "precise". See the module doc above and the Risks
 * section of the phase 30 plan.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Fixed assumed output length (tokens) for the baseline's single call -- a
 * plausible "here's the answer" response size. Deliberately not modeled
 * per-task: this harness needs a reasonable, explicitly-documented constant,
 * not a task-specific prediction of how long an answer would be.
 */
const BASELINE_OUTPUT_TOKENS = 500;

/** Default path the "eval report" JSON is written to/read from, relative to `process.cwd()`. */
const DEFAULT_REPORT_PATH = ".draht/rlm/cost-comparison-report.json";

/**
 * Compares an already-run RLM trajectory's real cost (read back from the
 * cost log at `costLogPath`, filtered by `trajectoryId`) against the
 * estimated cost of a truncate-and-single-call baseline for the same task:
 * truncate `contextLengthChars` down to whatever fits `model.contextWindow`
 * (first-N-characters, converted via `CHARS_PER_TOKEN`), then price one call
 * to `model` via `@draht/router`'s `estimateCost`.
 *
 * Doesn't run anything itself -- the RLM trajectory must already have run
 * (via `createRouterBackedSession`, logging its cost entries under
 * `costLogPath`) before calling this; the baseline call is hypothetical and
 * never actually dispatched. This function is pure arithmetic over its
 * inputs plus the cost log, and makes no claim about which side is cheaper --
 * that depends entirely on the task.
 */
export function compareCost(
	trajectoryId: string,
	contextLengthChars: number,
	model: BaselineModel,
	costLogPath?: string,
): CostComparisonResult {
	const entries = readCostLog(costLogPath).filter((entry) => entry.trajectoryId === trajectoryId);
	const rlmCostUsd = entries.reduce((sum, entry) => sum + entry.estimatedCostUsd, 0);
	// Exactly one "rlm-root"-role cost entry is logged per root-LLM step (see
	// router-session.ts's `logRouterCall("rlm-root", ...)` inside `rootLlm`) --
	// sub-calls (role "rlm-sub") don't count as separate steps.
	const rlmSteps = entries.filter((entry) => entry.role === "rlm-root").length;

	const truncatedInputTokens = Math.min(model.contextWindow, Math.ceil(contextLengthChars / CHARS_PER_TOKEN));
	const baselineCostUsd = estimateCost(
		model.provider,
		model.modelName,
		truncatedInputTokens,
		BASELINE_OUTPUT_TOKENS,
		0,
	);

	return {
		task: trajectoryId,
		rlmCostUsd,
		baselineCostUsd,
		rlmSteps,
		contextLengthChars,
	};
}

/**
 * Writes a `CostComparisonResult` to disk as the "eval report" R30-EVAL.3
 * asks for, creating parent directories as needed. Defaults to
 * `.draht/rlm/cost-comparison-report.json` (relative to `process.cwd()`),
 * mirroring `trajectory.ts`'s `DEFAULT_LOG_DIR` convention -- callers that
 * don't want to touch that real location (e.g. tests) should pass an
 * explicit `reportPath` instead.
 */
export function writeCostComparisonReport(result: CostComparisonResult, reportPath?: string): void {
	const path = resolve(reportPath ?? DEFAULT_REPORT_PATH);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}
