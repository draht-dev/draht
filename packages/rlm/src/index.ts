// @draht/rlm — Recursive Language Models core primitives.
//
// The root loop (`RlmSession`) and its Python REPL driver
// (`python/repl_driver.py`) implement the inference-time scaffold from
// Zhang, Kraska, Khattab (2026), *Recursive Language Models*
// (arXiv:2512.24601). Real `@draht/router` wiring for `llmQuery`/the root
// LLM, sandboxing, and CLI integration land in later phases (27-29); see
// .planning/phases/26-rlm-core-primitives/26-01-PLAN.md.

export { extractPythonCode, pythonReprToValue, RlmSession, truncateStdout } from "./session.js";
export type { RlmHistoryEntry, RlmResult, RlmResultKind, RlmSessionOptions } from "./types.js";
