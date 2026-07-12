# Phase 28 Verification

All 1 plan executed.

Tests: `packages/rlm` full vitest suite — 7 test files, 61/61 tests passing
(`prompts.test.ts` 11/11, `repl-driver.test.ts` 7/7, `sandbox.test.ts` 7/7,
`repl-driver-guardrails.test.ts` 18/18, `router-session.test.ts` 4/4,
`session.test.ts` 8/8, `resource-limits.test.ts` 6/6). Duration 1.50s.

Security: reviewed by a Fable 5 security advisor. Initial verdict was
`needs-fix` — the OS sandbox boundary itself (macOS `sandbox-exec` +
`macos.sb`) was independently confirmed to genuinely enforce (process-exec
denied, out-of-workdir reads denied, network denied), but `test/sandbox.test.ts`
was red (6/7 failing) because the tests were being routed through
`repl_driver.py`'s Python-level guardrails, which intercepted every vector
before it reached the OS layer — proving nothing about the real boundary —
and the plan's required runtime startup self-test was missing entirely.
Both were fixed in commit `9d2397e98`: the sandbox tests now drive
guardrail-free scripts directly through `spawnSandboxed`, and `RlmSession`
now runs a real `self_test` wire round-trip (network connect + out-of-workdir
read, both asserted blocked) immediately after spawn, refusing to run
(`sandbox_violation`) otherwise. The same commit also stopped handing the
sandboxed child the full parent process environment. Full findings and
dispositions are recorded in `28-01-SUMMARY.md`.

Typecheck: clean (`tsgo --noEmit` across the monorepo, exit 0, zero
diagnostics).

Linux namespace path (`unshare`/`bwrap`) is implemented per spec but could
not be empirically exercised on this macOS dev machine — needs real
coverage from `ci.yml`'s `ubuntu-latest` runner on the next push.

Verified: 2026-07-12
