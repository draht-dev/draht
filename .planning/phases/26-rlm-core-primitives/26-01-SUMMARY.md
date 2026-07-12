# Phase 26, Plan 1 Summary

## Completed Tasks
| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | Package scaffold | ✅ Done | 8f00bdc6a |
| 2 | Python REPL driver | ✅ Done | dd60d5d25 |
| 3 | RlmSession root loop | ✅ Done | 030f40d83 |

## Files Changed
- `packages/rlm/package.json` - New `@draht/rlm` workspace package manifest
- `packages/rlm/tsconfig.json` - TS build config (matches `packages/router`'s shape, built via `tsgo`)
- `packages/rlm/vitest.config.ts` - Vitest config (this package uses vitest, not `bun:test`, to match `packages/router` since Phase 27 will consume `@draht/router` types)
- `packages/rlm/src/index.ts` - Barrel export
- `packages/rlm/README.md` - Package README
- `packages/rlm/python/repl_driver.py` - Stdlib-only Python REPL driver: persistent `exec()` globals dict, newline-delimited JSON wire protocol, `FINAL`/`FINAL_VAR` as functions raising an internal `_RlmFinal` exception (caught specifically, not via bare `except Exception`), `llm_query` RPC-over-pipes client (writes `llm_query_request`, blocks reading stdin for the matching `llm_query_response` by `id`)
- `packages/rlm/test/repl-driver.test.ts` - 7 tests spawning the real `python3` driver subprocess (no mocking): variable persistence, seeded `context`, `FINAL`/`FINAL_VAR` reporting, exception-as-`exec_result.error` (not a driver crash), `llm_query` RPC round-trip, and the FINAL-inside-a-string/comment non-detection case
- `packages/rlm/src/session.ts` - `RlmSession` root loop: spawns the driver, seeds `context`, `step()`/`run()`, `llm_query_request`/`llm_query_response` RPC handling, stdout truncation with a `[truncated N chars]` marker, constant-size history entries, ````repl`/`​```python` fence extraction (`extractPythonCode`), and a restricted Python-literal parser (`pythonReprToValue`/`PyReprParser`) that turns a `FINAL_VAR` `repr()` string back into a real JS value
- `packages/rlm/src/types.ts` - `RlmSessionOptions`, `RlmHistoryEntry`, `RlmResult` types
- `packages/rlm/test/session.test.ts` - 8 tests against the real `RlmSession` (mocked `rootLlm`/`llmQuery`, real Python subprocess underneath): needle-in-haystack via `FINAL`, cross-step variable persistence, `context` holds the exact prompt, `llm_query` stub round-trip, `FINAL_VAR` resolving a compound value, `maxIterations` cutoff, both fence languages, and `dispose()` actually terminating the subprocess

## Verification Results
- ✅ `packages/rlm` full vitest suite: 2 test files passed (2), 15 tests passed (15), 0 failed. Per-file: `test/repl-driver.test.ts` = 7/7, `test/session.test.ts` = 8/8. Duration 398ms. (`cd packages/rlm && npx vitest run`; re-confirmed per-test detail via `rtk proxy npx vitest run --reporter=verbose` after the RTK hook compressed the first pass's output to `PASS (15) FAIL (0)`.)
- ✅ Full monorepo typecheck clean — `npx tsgo --noEmit` from repo root. The plain `npx tsgo` invocation was mangled by the RTK Claude Code hook (`npm error Missing script: "tsgo"` plus an "Unknown cli config --noEmit" warning); ran `node_modules/.bin/tsgo --noEmit` directly instead — exit code 0, no output, zero diagnostics across the whole repo (including the many modified files under `packages/ai`, unrelated to this phase).

## Notes
- **FINAL_VAR value-resolution design decision**: the plan asked us to decide and document how `FINAL_VAR`'s `repr()`'d string comes back as a real `RlmResult.value`. We chose a **restricted recursive-descent parser over a raw-string fallback**, not a plain `JSON.parse` after light substitution and not "leave it as a string." `pythonReprToValue` (in `session.ts`) hand-parses the JSON-safe Python literal subset — `None`/`True`/`False`, int/float (including scientific notation), single- or double-quoted strings (with the common backslash escapes: `\n`, `\t`, `\r`, `\\`, `\'`, `\"`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`), lists and tuples (both map to JS arrays — JS has no tuple type), and dicts (map to plain objects, keys coerced via `String(...)`). Anything the parser can't handle — custom object reprs like `<Foo object at 0x...>`, Python sets (no JS equivalent), `NaN`/`Infinity`, malformed input — falls back to returning the **raw repr string** rather than throwing, so a `FINAL_VAR` result is never lost even for a repr the parser doesn't understand. `FINAL(answer)` by contrast needs no such parsing: the driver already sends `str(answer)`, which `resolveFinal` uses as-is. This keeps `FINAL_VAR("some_dict")` in a test coming back as a real JS object (matching R26-RLM.6's "value" framing) while still being safe against non-literal reprs, since the parser only recognizes a fixed literal grammar and never calls `eval`/`Function`.
- The `FINAL`/`FINAL_VAR` "brittleness safeguard" (R26-RLM.6) is implemented as a real Python function call raising a driver-internal exception class the exec wrapper catches by type — not text-pattern matching over stdout. `repl-driver.test.ts` test 7 proves this directly: `print("not FINAL(x) really")  # FINAL(nope)` reports `exec_result.final === null`, because the string never actually calls the `FINAL` function.
- `llm_query` is fully injectable per the plan's explicit Phase-26/27 split: `RlmSessionOptions.llmQuery` is an optional TypeScript callback. Phase 26's tests supply a mock; calling `llm_query(...)` from Python with no `llmQuery` configured throws a clear error (`"REPL code called llm_query(...) but no \`llmQuery\` callback was provided"`) rather than hanging or silently producing garbage. Real `@draht/router` wiring is explicitly deferred to Phase 27 and was not touched here.
- No sandboxing or resource limits were added (correctly out of scope for this phase, owned by Phase 28) — the REPL subprocess remains a plain, unsandboxed `python3` child process. `stdoutTruncateChars` truncation uses the `[truncated N chars]` format Phase 28 will enforce as a hard cap, but here it is just a formatting rule with a soft default (2000 chars), not an enforced safety limit. Likewise `maxIterations` (default 24) is a soft cap that ends `run()` cleanly with `{ kind: "max_iterations" }`, not a hard-enforced budget.
- History entries are constant-size per `step()` (R26-RLM.7): `{ step, code, truncatedStdout, error, timestamp }`. The full `context` string is seeded once into the Python REPL's globals and is never re-appended into the history the root LLM sees on subsequent turns — only the code it wrote and the (truncated) stdout it produced.
- All 3 tasks from `26-01-PLAN.md` landed as independent, atomically-committed commits (scaffold → driver → session), matching the plan's task-by-task structure. No fix plans were required; verification was report-only and no source was modified during the verification pass.

---
Completed: 2026-07-11
