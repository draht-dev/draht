# Phase 17, Plan 1 Summary

## Completed Tasks
| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | Package scaffold with types | ✅ Done | 9097214c |
| 2 | GDPR PII scanner with tests | ✅ Done | 9097214c |
| 3 | EU AI Act checker | ✅ Done | 9097214c |

## Files Changed
- `packages/compliance/package.json` - package scaffold (`@draht/compliance`, `build`/`test` scripts, `@draht/coding-agent` workspace dep)
- `packages/compliance/src/types.ts` - `ComplianceFinding`, report, and PII-pattern types
- `packages/compliance/src/gdpr-scanner.ts` - `GdprScanner` class with `PII_PATTERNS` (email, IBAN, credit card, `console.log`-with-PII) and a directory walker that excludes `node_modules`/`.git`/`dist`/`build`/`.next`/`coverage` and skips `.test.`/`.spec.` files
- `packages/compliance/test/gdpr-scanner.test.ts` - 5 tests: detects email, detects IBAN, detects `console.log` with PII, skips test files, skips `node_modules`
- `packages/compliance/src/eu-ai-act.ts` - `EuAiActChecker` class with `AI_DOC_REQUIREMENTS` (Article 11 documentation requirements)
- `packages/compliance/src/index.ts`, `packages/compliance/tsconfig.json` - package entry point and TS project config
- `tsconfig.json` (root) - added compliance package to the TS project references

## Verification Results
- ✅ `bun test` in `packages/compliance` — `test/gdpr-scanner.test.ts` passes 5/5 (5 `expect()` calls), re-run against current HEAD during this backfill. The file's assertions are unchanged since this commit; only whitespace/formatting was later collapsed by the repo-wide biome pass in `3a71136e` ("fix: pre-commit hooks").
- ✅ `bun run build` (`tsgo --noEmit`) passes clean for `packages/compliance` as of this backfill (2026-07-11).
- No test output was captured in the original commit message or in `.planning/phase-17-report.md` at execution time (see Notes) — the pass/fail numbers above come from re-running the suite now, not from a preserved 2026-02-28 log.

## Notes
- All 3 tasks in this plan — plus both tasks from Plan 2 (legal templates, report generator) — landed together in a single commit, `9097214c` ("feat: add compliance checker with GDPR scanner and EU AI Act", 2026-02-28 21:08:50 +0100 = 20:08:50 UTC), rather than one commit per task as the plan's task table implies. There is no per-task commit to cite individually, so all rows above point to the same hash.
- `.planning/phase-17-report.md`, generated in that same commit, recorded 0 passed / 0 failed / 0 skipped and an empty execution-log table — the mechanical report generator ran before per-task results were ever filled in, which is the same unfilled-template problem this backfill is now fixing for the SUMMARY files.
- A later commit, `aea2e210` ("fix: address code review findings and fix router stream types", 2026-02-28 22:04:14 +0100, about an hour after `9097214c`), rewrote `EuAiActChecker`'s requirement-matching logic in `eu-ai-act.ts` (heading/ID/article/key-phrase matching instead of single-keyword substring matching). This plausibly belongs to Phase 17 as a code-review follow-up, but the commit also touches `packages/router`, `packages/invoice`, and several unrelated `package.json` files under one generic message, so it is **not** attributed here as a Phase 17 commit — flagging the ambiguity rather than guessing.
- Two additional test files now exist in `packages/compliance/test/` (`eu-ai-act.test.ts`, `gdpr-scanner-german-corpus.test.ts`). These were added much later by Phase 24 ("Invoice/Compliance Tests", commits `f7040db4` and `2b1796e0`, dated 2026-07-11) and are unrelated to this phase's original scope, so they are excluded from this plan's verification and task attribution.

---
Completed: 2026-02-28 20:08:56
