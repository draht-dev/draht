// @draht/rlm — Recursive Language Models core primitives.
//
// The root loop (`RlmSession`) and its Python REPL driver
// (`python/repl_driver.py`) implement the inference-time scaffold from
// Zhang, Kraska, Khattab (2026), *Recursive Language Models*
// (arXiv:2512.24601). Real `@draht/router` wiring for `llmQuery`/the root
// LLM, sandboxing, and CLI integration land in later phases (27-29); see
// .planning/phases/26-rlm-core-primitives/26-01-PLAN.md.

// Input loaders -- turn a raw `--input`/`/rlm <input>` argument (file, glob,
// URL, or `knowledge:<client-slug>`) into loaded prompt content. See
// .planning/phases/29-agent-cli-integration/29-01-PLAN.md, Architecture
// section 1. Re-exported from the package root so consumers outside this
// package (e.g. `@draht/rlm-agent`, the `draht rlm` CLI) can import them via
// the public `@draht/rlm` entry point instead of reaching into `src/`.
export type { InputSource, LoadedInput } from "./loaders.js";
export { loadInput, parseInputArg } from "./loaders.js";
export type { PromptTier, PromptVars } from "./prompts.js";
export { renderPrompt, selectTier } from "./prompts.js";
export type { CreateRouterBackedSessionOptions } from "./router-session.js";
export { createRouterBackedSession } from "./router-session.js";
export { extractPythonCode, pythonReprToValue, RlmSession, truncateStdout } from "./session.js";
// Trajectory JSONL logging/replay (Phase 30) -- see
// .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
// section 1. Re-exported from the package root so consumers outside this
// package (e.g. `draht rlm replay`) can import via the public `@draht/rlm`
// entry point instead of reaching into `src/`.
export type { TrajectoryFinalEntry, TrajectoryStepEntry } from "./trajectory.js";
export { appendTrajectoryEntry, readTrajectory } from "./trajectory.js";
export type { RlmHistoryEntry, RlmResult, RlmResultKind, RlmSessionOptions } from "./types.js";
