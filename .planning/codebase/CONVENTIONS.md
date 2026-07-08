# Conventions

Generated: 2026-07-08 · Filled in during `/map-codebase`.

## Code Style

- Enforced entirely by **Biome** (`2.3.5`, `biome.json`) — no ESLint/Prettier in the repo.
  - Formatter: tab indentation, indent width 3, line width 120.
  - Linter: `recommended` rule set with explicit relaxations — `noExplicitAny: off`, `noNonNullAssertion: off`, `noControlCharactersInRegex: off`, `noEmptyInterface: off`, `useNodejsImportProtocol: off`; `useConst: error` is the one rule tightened above recommended.
  - Biome only lints `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts`, plus a few explicit extras — generated files (`models.generated.ts`, `test-sessions.ts`) and `node_modules` are excluded.
- TypeScript `strict: true` repo-wide (`tsconfig.base.json`), target `ES2022`, decorators enabled. No package deviates from the base config in a way that loosens strictness (not independently verified per-package, but no overrides found at the root).

## Extension Pattern

Business-capability packages (router, orchestrator, knowledge, invoice, compliance, deploy-guardian, ci) each expose a `src/extension.ts` that registers into `@draht/coding-agent`'s Extension API (commands/tools/hooks) rather than being imported directly by other packages. New business capabilities should follow this same shape instead of reaching into `coding-agent` internals or another extension package.

## Commit Conventions

- **Conventional Commits** with scope, e.g. `feat(gsd): ...`, `fix(coding-agent): ...`, `chore(deps): ...`, `docs: ...` (observed directly in `git log`).
- Within GSD task execution specifically, an additional TDD-cycle prefix convention layers on top: `red:` (failing test only), `green:` (minimal implementation), `refactor:` (cleanup, tests still green) — see `.planning/DOMAIN.md` Domain Events (`TDDViolation`) for how this is enforced.
- Root project constraint: atomic git commits per task (from GSD state, not inferred).

## Pre-commit Gate

`.husky/pre-commit` runs `npm run check` before every commit:
1. `biome check --write --error-on-warnings .`
2. `tsgo --noEmit` (fast native TypeScript check)
3. `check:browser-smoke` (`scripts/check-browser-smoke.mjs`)
4. `check:mirrors` (`scripts/check-plugin-mirrors.mjs` — verifies `draht-claude`/`draht-codex` mirrors of `draht-tools` haven't drifted)
5. `check:draht-tools` (`scripts/sync-draht-tools.mjs --check`)
6. `packages/web-ui`'s own `check` script

Staged files are restaged after formatting so the commit includes Biome's fixes.

## Testing Patterns

Two test runners coexist (Vitest and Bun test) with no single repo-wide convention — full detail in `.planning/TEST-STRATEGY.md`. The dominant directory convention is a `test/` folder at each package root (one outlier: `gateway` uses `src/__tests__/`). No inline co-located `*.test.ts` files were found. Integration tests are not separated from unit tests — both live in the same `test/` directory per package.

## Error Handling

No repo-wide error-handling convention was identified during this pass — standard `throw new Error(...)` is used ad hoc where checked (e.g. `coding-agent/src/config.ts`, `ai/src/compat.ts`) rather than a shared error-class hierarchy or Result/Either pattern `(inferred gap — confirm before relying on a specific error-handling style across packages)`.

## Versioning & Release

- Calendar-style version at the root (`2026.7.7-1`), synced across workspaces via `scripts/sync-versions.js` and `npm run version:*` scripts.
- Release automation: `scripts/release.mjs` (`npm run release` / `release:dry`).
