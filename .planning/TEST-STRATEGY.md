# Test Strategy

_Inferred from code via `/map-codebase` on 2026-07-08. Not confirmed by the user — mark decisions here as tentative until validated._

## Test Framework

Two frameworks coexist across the 22 workspace packages, split by which packages migrated to Bun runtime:

- **Vitest** (`3.2.4`) — `agent`, `ai`, `ci`, `coding-agent`, `deploy-guardian`, `knowledge`, `orchestrator`. `vitest.config.ts` present in each.
- **Bun test** (`1.4.0-canary.1`) — `compliance`, `gateway`, `invoice`, `router`, `tui` (partial). `"test": "bun test"`, no vitest config.
- **Smoke-check only** — `draht-tools`, `draht-claude`, `draht-codex`: `"test"` script runs `node bin/... --help > /dev/null`, verifying the CLI doesn't crash rather than running assertions.
- **No test script** — `infra`, `landing`, `mom`, `pods`, `templates`, `web-ui`, `workflows`.

Root `package.json` runs `npm run test --workspaces --if-present`, invoked by CI as `bun run test` (`.github/workflows/ci.yml`).

`(inferred, unresolved)`: no documented rule for which runner new packages should adopt. Recommend standardizing — Bun test is already required at runtime for install/CI, so Vitest packages are the outlier unless they rely on vitest-specific features (e.g. `vi.mock`).

## Directory Conventions

Two patterns observed, not unified:

- **`test/` at package root** (dominant) — `agent`, `ai`, `ci`, `coding-agent`, `compliance`, `deploy-guardian`, `invoice`, `knowledge`, `orchestrator`, `router`, `tui`.
- **`src/__tests__/` co-located** (one outlier) — `gateway`, 29 files under `packages/gateway/src/__tests__/`.

No package uses inline co-location (`*.test.ts` beside source outside a dedicated dir). No top-level `e2e/` directory exists anywhere — integration tests live in the same `test/` folders as unit tests (e.g. `gateway/src/__tests__/sessions-integration.test.ts`, `router/test/fallback.test.ts`).

`coding-agent/test/` has the most structure: `test-utils/`, `fixtures/` (with subfixtures like `empty-cwd`, `domain-fixture`, `skills-collision`), and `test/suite/regressions/` for regression tests.

## Coverage

**No coverage configuration exists anywhere in the monorepo** — confirmed via grep across all `package.json`/`vitest.config.ts` for `coverage`/`@vitest/coverage`, and no `nyc`/`c8`/threshold config found. No coverage step in CI.

**Coverage Goals**: none currently set. `(inferred recommendation)`: instrument at least the higher-risk packages (`gateway`, `router`, `coding-agent`, `ai`) with a baseline threshold before expanding repo-wide.

## Testing Levels

| Layer | Status |
|---|---|
| Unit | Present, dominant style — small focused `*.test.ts` files. Coverage is light even where present (some packages have only 1 test file). |
| Integration | Present but blended into `test/`, not separated — mainly `gateway` (`sessions-integration.test.ts`, `concurrent-sessions.test.ts`) and `router` (`fallback.test.ts`). |
| E2E / TUI | Documented but **not automated** — `docs/tui-testing.md` describes a manual `tmux`-based procedure; not run in CI. |
| Credential-dependent | `ai` (95 test files) and `agent` (16 test files) require API credentials; `scripts/verify.sh` skips them locally but CI's blanket `bun run test` includes them, risking silent reliance on secrets being present. |
| Smoke | `draht-tools`, `draht-claude`, `draht-codex` — CLI `--help` invocation only, effectively no regression coverage. |

Test file counts (observed): `coding-agent` 177, `ai` 95, `gateway` 30, `tui` 27, `agent` 16, `router` 6, `ci` 2, `knowledge` 2, `compliance` 1, `deploy-guardian` 1, `invoice` 1, `orchestrator` 1. Zero in `infra`, `landing`, `mom`, `pods`, `templates`, `web-ui`, `workflows`, `draht-tools`, `draht-claude`, `draht-codex`.

## Excluded

- 7 of 22 workspace packages have no automated tests at all: `infra`, `landing`, `mom`, `pods`, `templates`, `web-ui`, `workflows`. `web-ui` notably has no component/rendering tests (no `@testing-library/*`, no Playwright/Cypress in the repo).
- TUI end-to-end behavior is excluded from automation — manual tmux procedure only.
- `tui`'s own `vitest.config.ts` only wires in 1 of 27 test files (`include: ["test/wrap-ansi.test.ts"]`); the rest run only via `bun test test/*.test.ts` through `scripts/verify.sh`, not through `npm test` at the package level.

## Known Issues Found During Analysis

- **`router` test suite is currently broken**: `test/fallback.test.ts` imports `clearApiProviders` from `@draht/ai/compat`, but `packages/ai/src/compat.ts:150` defines it without an `export` keyword (confirmed in both source and `dist/compat.js`). This fails in CI today since `router` is part of the workspace-wide `bun run test`. Not fixed as part of this mapping pass — flag for a follow-up `/fix`.
- **`scripts/verify.sh` has a stale exclusion**: a comment claims `ci`/`knowledge` have "empty test suite files that vitest treats as errors" and excludes them from local verification. Both packages were run directly and pass cleanly (4 and 7 tests respectively) — the comment is stale, and local `verify.sh` currently diverges from what CI actually runs. It also silently skips `gateway`, `router`, and `ai` entirely, so it would not have caught 3 of the 4 additional failures below.
- **`tui` — `test/terminal.test.ts:156,175`**: calls `mock.timers.enable({ apis: ["setTimeout"] })` from `node:test`. Bun's `node:test` shim doesn't implement `mock.timers.enable`, so this throws under the package's actual `bun test` runner — a Node/Bun API compatibility gap, not flakiness.
- **`gateway` — `src/__tests__/ws-auth.test.ts:135`**: expects `result.closeCode` to be `1000` for "correct token, stopped session" but observes `1001`, deterministically across reruns — a genuine close-code/expectation mismatch.
- **`ai` — `test/supports-xhigh.test.ts`** (9 failing assertions): expected thinking-level arrays don't include `"max"`, but `EXTENDED_THINKING_LEVELS` (`models.ts:397`) and `ThinkingLevel` (`types.ts:74`) both added `"max"` since this fixture was last updated — a stale test fixture.
- **`coding-agent` — 88 failures across 20 files**, reproducing identically in isolated single-file runs with sanitized env (so not order-dependent flakiness): a settings/theme scope-resolution cluster (`test/settings-manager.test.ts`, `test/theme-export.test.ts` — project vs. global scope resolving to the wrong values) plus failures in `test/config.test.ts`, `test/extensions-discovery.test.ts`, `test/package-manager.test.ts`, `test/resource-loader.test.ts`, `test/trust-manager.test.ts`, and three named regression tests (`2781-skill-collision-precedence`, `2791-fswatch-error-crash`, `2860-replaced-session-context`). Root cause not traced past the settings/theme cluster — this is `/fix` follow-up work, not a mapping-pass fix.
