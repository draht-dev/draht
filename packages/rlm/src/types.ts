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
	/** Captured stdout, truncated to `stdoutTruncateChars` with a marker. */
	truncatedStdout: string;
	/** Traceback/message if the executed code raised, else null. */
	error: string | null;
	/** ISO 8601 timestamp of when this step's exec_result was received. */
	timestamp: string;
}

/** Why `RlmSession.run()` stopped. */
export type RlmResultKind = "final" | "final_var" | "max_iterations" | "error";

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
	/** Max chars of stdout kept per step before truncation. Default 2000. */
	stdoutTruncateChars?: number;
}
