# Phase 25 Verification

All 1 plan executed.

- R25-CI.1 (PR check workflow runs lint + test): confirmed already satisfied by pre-existing `.github/workflows/ci.yml` — no new workflow needed.
- R25-CI.2 (AI review dogfooding): `.github/workflows/ai-review.yml` added, using `packages/ci`'s composite action. Inert until Oskar adds the `ANTHROPIC_API_KEY` repository secret — the `review` job is guarded by a job-level `if` on a `check-secret` job's output, so it skips (not fails) until then.
- R25-DOC.1 (Phase 14-18 summaries): all 11 placeholder summary files replaced with real content reconstructed from git history; two Phase 14 tasks had no corresponding in-repo commit (`~/bin/draht` target) and are documented as such rather than fabricated.
- R25-DOC.2 (hooks.json single source of truth): `scripts/generate-hooks-json.mjs` added, generating both `packages/draht-claude/hooks/hooks.json` and `packages/draht-codex/hooks/hooks.json` from one canonical template; `check:hooks` wired into `npm run check`.

`npm run check` passes in full: biome, `tsgo --noEmit`, `check:browser-smoke`, `check:mirrors`, `check:draht-tools`, `check:hooks`, and `packages/web-ui`'s own check all succeeded. `node scripts/generate-hooks-json.mjs --check` passes standalone.

Verified: 2026-07-11
