---
gap_closure: true
fixes_plan: 3
issue: "Restore repo-wide verification baseline after Phase 21 acceptance run"
---

# Fix Plan for Phase 21, Plan 3

## Issue
Restore repo-wide verification baseline after Phase 21 acceptance run

## Reproducing Failures
Run these commands before any implementation changes:
- `npm run test`
- `npx tsc --noEmit`

Current reproducible failures:
1. `packages/ai/test/cross-provider-handoff.test.ts` fails when only one provider context is available (`expected 1 to be greater than or equal to 2`).
2. `packages/ci/test/github.test.ts` is collected by Vitest but contains no suite (`No test suite found in file`).
3. `packages/coding-agent/test/package-manager.test.ts` has three failing offline-mode assertions:
   - installs a missing npm package instead of skipping in offline mode
   - refreshes temporary git sources instead of skipping in offline mode
   - calls fetch / reports update needed in `npmNeedsUpdate()` while offline
4. `packages/knowledge/test/vector-store.test.ts` is collected by Vitest but contains no suite (`No test suite found in file`).
5. `npx tsc --noEmit` fails in `packages/tui/src/utils.ts` because the current regex flags require an `es2024` target or an implementation change.

## Tasks

<task type="auto">
  <n>Reproduce the repo-wide verification failures in tests first</n>
  <files>packages/ai/test/cross-provider-handoff.test.ts, packages/ci/test/github.test.ts, packages/coding-agent/test/package-manager.test.ts, packages/knowledge/test/vector-store.test.ts, packages/tui/src/utils.ts</files>
  <test>Run `npm run test` and `npx tsc --noEmit` and capture the failing suites listed above before changing implementation.</test>
  <action>Do not start implementation until the failing tests and typecheck errors are reproduced locally and mapped to an owner/root cause.</action>
  <verify>Saved command output identifies the same failing suites and the same TypeScript errors seen in UAT.</verify>
  <done>There is a verified baseline showing the failures before any code changes begin.</done>
</task>

<task type="auto">
  <n>Stabilize repo-wide automated checks without regressing Phase 21 coverage</n>
  <files>packages/ai/test/cross-provider-handoff.test.ts, packages/ci/test/github.test.ts, packages/coding-agent/src/core/package-manager.ts, packages/coding-agent/test/package-manager.test.ts, packages/knowledge/test/vector-store.test.ts, packages/tui/src/utils.ts</files>
  <action>Fix the provider-fixture assumption in AI tests, convert empty collected test files into real suites or exclude them intentionally, correct coding-agent offline-mode behavior so no installs/network fetches occur when offline, and resolve the TUI regex target mismatch without downgrading behavior unnecessarily.</action>
  <verify>Run `npm run test`, `npm run check`, and `npx tsc --noEmit` after the fixes. Also rerun the Phase 21 targeted coding-agent tests to ensure the new domain-mapping and lifecycle coverage stay green.</verify>
  <done>Repo-wide test, check, and typecheck commands pass, and Phase 21 targeted tests still pass.</done>
</task>

---
Created: 2026-03-12 21:01:13
