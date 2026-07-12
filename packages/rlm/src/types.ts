/**
 * Types for `@draht/rlm`'s root loop (`RlmSession`).
 *
 * See .planning/phases/26-rlm-core-primitives/26-01-PLAN.md, Architecture
 * section 4, for the authoritative spec this mirrors.
 */

/**
 * One root-LLM turn recorded in the session's history.
 *
 * Deliberately constant-size (R26-RLM.7): the full `context` string is never
 * appended here, only short metadata about what happened in this step. This
 * is what gets fed back into `rootLlm` on the next turn, so it must stay
 * small regardless of how large `context` or the REPL's real output is.
 */
export interface RlmHistoryEntry {
	/** 1-indexed step number. */
	step: number;
	/** The Python source that was executed this step (post fence-extraction). */
	code: string;
	/**
	 * Captured stdout, truncated to `stdoutTruncateChars` with a marker.
	 * Enforced incrementally on the Python side (`repl_driver.py`'s
	 * `_TruncatingStdout`, Phase 28 Architecture section 5) -- the value here
	 * already carries the cap and marker; `RlmSession` no longer re-truncates
	 * it Node-side (Phase 26's original design did, post-hoc, which is exactly
	 * the OOM-via-print gap Phase 28 closes).
	 */
	truncatedStdout: string;
	/** Traceback/message if the executed code raised, else null. */
	error: string | null;
	/** ISO 8601 timestamp of when this step's exec_result was received. */
	timestamp: string;
}

/**
 * Why `RlmSession.run()` stopped. Per R28-SBX.6:
 * - `timeout`: the Node-side wall-clock per-step timeout fired and the
 *   driver subprocess was hard-killed (Phase 28 Architecture section 3).
 * - `budget_exhausted`: a `maxSubCalls`/`maxTotalCostUsd` pre-check failed
 *   before dispatch (Phase 28 Architecture section 6).
 * - `sandbox_violation`: the OS-level sandbox itself failed to establish or
 *   its runtime startup self-test didn't confirm both network and
 *   out-of-workdir file access are actually denied (Phase 28 Architecture
 *   section 1) -- this means "the sandbox itself intervened/failed", never
 *   "resource exhaustion" (see `error` below for that).
 * - `error` also covers an RSS-ceiling kill (Phase 28 Architecture section
 *   3) -- R28-SBX.6's enum is fixed and has no dedicated value for OOM, and
 *   it deliberately isn't folded into `sandbox_violation` -- see the `value`
 *   message for which ceiling was hit.
 */
export type RlmResultKind =
	| "final"
	| "final_var"
	| "max_iterations"
	| "budget_exhausted"
	| "timeout"
	| "sandbox_violation"
	| "error";

/** Outcome of a full `RlmSession.run()` loop. */
export interface RlmResult {
	kind: RlmResultKind;
	/**
	 * The resolved final value. Present for "final" and "final_var". See
	 * `pythonReprToValue` in `session.ts` for how a `FINAL_VAR` repr string is
	 * turned back into this.
	 */
	value?: unknown;
	/** Number of `step()` calls executed before stopping. */
	steps: number;
	/** Full step-by-step history accumulated during the run. */
	history: RlmHistoryEntry[];
}

export interface RlmSessionOptions {
	/** Becomes the `context` variable inside the REPL. */
	prompt: string;
	/**
	 * Called each `step()` with history-so-far; must return a response
	 * containing Python source, optionally fenced in ```repl or ```python.
	 */
	rootLlm: (history: RlmHistoryEntry[]) => Promise<string>;
	/**
	 * Answers `llm_query(prompt)` calls made from inside the REPL. Injectable
	 * so Phase 26 tests (and later, non-production callers) can mock it;
	 * production wiring through `@draht/router` lands in Phase 27.
	 */
	llmQuery?: (prompt: string) => Promise<string>;
	/**
	 * Soft cap on the number of `step()` iterations `run()` will perform
	 * before giving up with `{ kind: "max_iterations" }`. Not a hard safety
	 * limit — that's Phase 28's job.
	 */
	maxIterations?: number;
	/**
	 * Max chars of stdout kept per step before truncation. Default 2000.
	 * Sent to the driver as a `configure` message at session startup and
	 * enforced incrementally there (Phase 28 Architecture section 5) -- not
	 * applied a second time Node-side.
	 */
	stdoutTruncateChars?: number;

	/**
	 * Node-side wall-clock timeout (ms) for one full step round trip (from
	 * sending `exec` to receiving `exec_result`, including any `llm_query`
	 * sub-call round trips in between). This -- not any Python-level
	 * `RLIMIT_CPU`/timer -- is the real enforcement mechanism (Phase 28
	 * Architecture section 3, R28-SBX.3): exceeding it hard-kills the driver
	 * subprocess and `run()` resolves with `{ kind: "timeout" }`. The whole
	 * session ends -- there is no partial-step rollback for a hard kill (see
	 * `RlmHistoryEntry`/`repl_driver.py`'s rollback docs). Default 30_000.
	 */
	stepTimeoutMs?: number;
	/**
	 * RSS ceiling (bytes) for the driver subprocess, polled Node-side roughly
	 * every `rssPollIntervalMs` (Phase 28 Architecture section 3). Exceeding
	 * it hard-kills the subprocess; `run()` resolves with `{ kind: "error" }`
	 * (R28-SBX.6 has no dedicated enum value for OOM -- see `RlmResultKind`).
	 * Default 256 MiB (`256 * 1024 * 1024`).
	 */
	maxRssBytes?: number;
	/** How often (ms) to poll the driver subprocess's RSS. Default 250. */
	rssPollIntervalMs?: number;

	/**
	 * Hard cap on the total number of `llm_query` sub-calls this session will
	 * ever forward to `llmQuery`. Checked *before* each sub-call is
	 * dispatched (Phase 28 Architecture section 6, R28-SBX.5) -- the
	 * (budget+1)th attempted call never reaches `llmQuery`; the driver
	 * subprocess is killed instead and `run()` resolves with
	 * `{ kind: "budget_exhausted" }`. `undefined` (default) means unlimited.
	 */
	maxSubCalls?: number;
	/**
	 * Hard cap on accumulated cost (USD), compared against
	 * `getAccumulatedCostUsd()`'s return value before dispatching each step
	 * and before each sub-call (Phase 28 Architecture section 6). Has no
	 * effect unless `getAccumulatedCostUsd` is also supplied -- there being
	 * nothing to compare against, the check is skipped entirely rather than
	 * guessing "already exhausted" or "never exhausted".
	 */
	maxTotalCostUsd?: number;
	/**
	 * Returns the session's accumulated real-money cost so far (USD) -- e.g.
	 * `createRouterBackedSession` (Phase 27) can wire this to a running sum of
	 * its logged `CostEntry.estimatedCostUsd` values. `RlmSession` itself has
	 * no notion of "provider" or "cost"; it only ever compares this callback's
	 * return value against `maxTotalCostUsd`.
	 */
	getAccumulatedCostUsd?: () => number;
}
