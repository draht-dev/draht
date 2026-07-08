# Concerns

Generated: 2026-07-08 · Filled in during `/map-codebase`, drawing on parallel `architect` and `verifier` subagent analysis.

## Technical Debt

- **`coding-agent` is a god-context.** `src/index.ts` has 114 dependents and mixes the extension-host platform API, the interactive TUI application, session persistence, the built-in tool suite, and the entire GSD planning sub-domain. GSD (`src/gsd/`) is a coherent, unrelated sub-domain and the clearest extraction candidate `(inferred)`.
- **Duplicated vocabulary across kernels** — `ThinkingLevel` is independently defined in both `ai/src/types.ts` and `agent/src/types.ts` with slightly different unions; `Session`/`SessionManager` is independently redefined in `coding-agent` and `gateway`; `EventBus` is independently redefined in `gateway` and `mom`. These are not a shared vocabulary despite the shared name — confirm which definition (if any) should be canonical before treating them as one concept.
- **Cross-kernel test coupling** — `ai/test` imports from `coding-agent/src/core/auth-storage.ts`, and `coding-agent/test` imports from `ai/src/api/openai-codex-responses.ts`. Test-only, but it means these two packages can't be cleanly split without touching both test suites.
- **Split test runners** (Vitest vs. Bun test) across packages with no documented rule for which new packages should use which — see TEST-STRATEGY.md.
- **`scripts/verify.sh` has a stale exclusion**: a comment claims `ci`/`knowledge` have "empty test suite files that vitest treats as errors" and skips them from local verification. Both were run directly during this analysis and pass cleanly (4 and 7 tests respectively) — local `verify.sh` currently diverges from what CI's `bun run test` actually exercises.
- **`tui`'s `vitest.config.ts` only wires in 1 of 27 test files** (`include: ["test/wrap-ansi.test.ts"]`); the rest run only via `bun test test/*.test.ts` through `scripts/verify.sh`, not through `npm test` at the package level — fragile, easy to silently regress.

## Test Gaps

- **No coverage instrumentation anywhere in the monorepo** — no `@vitest/coverage-v8`, no `bun test --coverage`, no thresholds, no CI reporting.
- **7 of 22 workspace packages have zero automated tests**: `infra`, `landing`, `mom`, `pods`, `templates`, `web-ui`, `workflows`. `web-ui` notably has no component/rendering tests at all.
- **TUI end-to-end behavior is manual only** — `docs/tui-testing.md` describes a `tmux`-based procedure that is not automated or run in CI.
- **`draht-tools`, `draht-claude`, `draht-codex`** report a passing `"test"` script that only checks `--help` doesn't crash — effectively no regression coverage for these CLI packages.
- Full detail in `.planning/TEST-STRATEGY.md`.

## Live Defect (found during this analysis, not yet fixed)

- **`router`'s test suite is currently broken**: `packages/router/test/fallback.test.ts` imports `clearApiProviders` from `@draht/ai/compat`, but `packages/ai/src/compat.ts:150` defines `clearApiProviders` without an `export` keyword (confirmed in both source and `dist/compat.js` — not a stale-build artifact). `resetApiProviders` (which *is* exported) calls `clearApiProviders()` internally, suggesting a refactor exported the wrapper but forgot the underlying primitive the router test still depends on directly. Since `router` is included in CI's workspace-wide `bun run test`, **this currently fails CI**. Recommend a follow-up `/fix`.

## Security Concerns

Not deeply audited in this pass (`/map-codebase` is a documentation/architecture pass, not a security audit — use the `security-auditor` agent or `/security-review` for that). One structural note worth flagging for a dedicated audit: `mom`, `gateway`, and `pods` all manage credentials/session state in filesystem/JSON stores (`credential-store.ts`, session stores) rather than a secrets manager — worth a dedicated look given they're internet-facing (Slack bot, session gateway) or handle SSH credentials (pods).

## Tooling Note

`.planning/codebase/DOMAIN-HINTS.md` (the auto-generated grep sweep behind `.planning/DOMAIN.md`) is polluted by vendored third-party code under `packages/landing/.sst/platform/**` and `packages/landing/.astro/**` (SST/Astro framework internals, not draht domain code). Recommend `draht-tools map-codebase` add `**/.sst/**`, `**/.astro/**`, and `**/dist/**` to its ignore set so future domain-hint sweeps don't require manual filtering.
