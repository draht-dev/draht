# State

## Current Phase: Phase 24: Invoice/Compliance Tests
## Status: complete

## Decisions
- Astro replaces Next.js in all templates and references (Oskar, 2026-02-28)
- Yolo mode — no interactive confirmations needed
- Fork attribution kept in LICENSE
- SST sst.config.ts excluded from tsconfig (types generated at runtime)
- Extension placed in examples/extensions/ following Pi Agent convention
- Phases 5-9: Zvec-based knowledge, GitHub Action CI, Anthropic SDK orchestration, n8n JSON templates, git-based rollback
- Milestone 2 approved: Integration hardening, Phases 19-24 (Oskar, 2026-03-03)
- Milestone 3 approved: Recursive Language Models, Phases 26-30 — inference-time scaffold per Zhang/Kraska/Khattab 2026 (arXiv:2512.24601). Phases 22-25 remain pending backlog, not a blocker. (Oskar, 2026-04-24)

## Completed Phases
- Phase 24: Invoice/Compliance Tests (1 plan, verified 2026-07-11)
- Phase 23: Multi-Agent Layer (1 plan, verified 2026-07-11)
- Phase 22: Router Hardening (3 plans, verified 2026-03-16)
- Phase 21: GSD Integration Tests (complete)
- Phase 20: TDD/DDD Hook Hardening (complete)
- Phase 19: GSD CLI Integration (complete)
- Phase 1: Rebrand (7 commits)
- Phase 2: SST v4 Infrastructure (1 commit)
- Phase 3: SST Resource Manager Extension (1 commit)
- Phase 4: AGENTS.md Template Library (1 commit)
- Phase 5: Client Knowledge Base Extension (1 commit)
- Phase 6: CI/CD AI Review Pipeline (1 commit)
- Phase 7: Multi-Agent Orchestration (1 commit)
- Phase 8: n8n Client Workflows (1 commit)
- Phase 9: Deploy Guardian Extension (1 commit)
- Phase 10: Draht CLI & Branding (complete)
- Phase 11: Testing Infrastructure (complete)
- Phase 12: Documentation & README (complete)
- Phase 13: Model Router (3 commits)
- Phase 14: TDD-First Core (2 commits)
- Phase 15: DDD-First Core (2 commits)
- Phase 16: Invoice Generator (2 commits)
- Phase 17: Compliance Checker (2 commits)
- Phase 18: draht.dev Website Content (2 commits)

## Lessons
- 2026-03-02: GSD tracking drifted silently — phase status and plan files went out of sync until a manual audit; keep STATE/ROADMAP updates in the same commit as the work they describe.

## Blockers
None.

## Audit Log
- 2026-07-11: Phase 24 (Invoice/Compliance Tests) completed and verified: added Lexoffice mock integration tests, Toggl mock integration tests, a realistic German-corpus PII scanner accuracy test, and an EU AI Act documentation-validator test — closing R24-API.1 through R24-API.4. `packages/invoice` 16/16 tests passing across 3 files; `packages/compliance` 18/18 tests passing across 3 files; full monorepo `tsgo --noEmit` clean. No source changes needed (test-coverage phase only). ROADMAP.md and STATE.md updated to `complete`.
- 2026-07-11: Post-verification check on Phase 23 found `core/builtins/subagent.ts` (the module the permission gate was wired into) was never actually loaded by any real session — `discoverAndLoadExtensions` is unused in production and the real settings-driven extension resolution never referenced `core/builtins/`. Traced every call site (cli.ts, main.ts, agent-session.ts, sdk.ts, package-manager.ts) to confirm. Fixed in commit `433e6afbe`: `core/builtins/index.ts` exports `CORE_BUILTIN_EXTENSIONS`, now always included by both `createAgentSessionServices` and `createAgentSession`. Verified empirically via `session.agent.beforeToolCall` on a from-scratch session — a real `.draht/permissions.yml` deny rule now blocks sudo/chaining/command-substitution bypass attempts. Checked Phase 7 (`packages/orchestrator`) for the same class of bug: it's unaffected — that package is a normal opt-in extension (install via `draht install @draht/orchestrator`) working as designed; `core/builtins/` is unrelated, pre-dates the phase system, and just never had a loading mechanism at all.
- 2026-07-11: Phase 23 (Multi-Agent Layer) completed and verified: FSM protocol, teammate mailbox, autonomous task board, worktree isolator, and permission gate all implemented with vitest coverage (6 test files, 70/70 passing) and wired into the subagent builtin. Closes the permission-gate gap (R23-MA.5) identified relative to the Claude Code architecture diagram. ROADMAP.md and STATE.md updated to `complete`.
- 2026-07-11: GSD tracking drift found again (same class of bug as 2026-03-02 lesson): Phase 22 was fully planned, executed, and verified on 2026-03-16 (3 plans, real commits, 71/71 tests passing) but ROADMAP.md still listed it `pending`. Corrected ROADMAP.md and STATE.md to `complete`. Beginning autonomous sweep of Phases 22-30 (Oskar approved full autonomy, direct-to-main, 2026-07-11).
- 2026-03-02: GSD tracking audit performed. All 18 phases verified as code-complete (quality gate passes). Fixed:
  - ROADMAP Phase 13 status corrected from `in-progress` to `complete`
  - Phase 3: Added missing 03-01-PLAN.md and 03-01-SUMMARY.md
  - Phase 4: Created missing phase directory with 04-01-PLAN.md and 04-01-SUMMARY.md
  - Phase 7: Added missing 07-01-SUMMARY.md
  - Phase 8: Added missing 08-01-PLAN.md and 08-01-SUMMARY.md
  - Phase 9: Added missing 09-01-PLAN.md and 09-01-SUMMARY.md
- 2026-03-03: Milestone 2 approved. Phases 19-24 added to ROADMAP. Carried forward incomplete requirements from R14-TDD and R15-DDD.
- 2026-03-16: Phase 21 verification completed. All 31 deliverables passed UAT. 22/22 tests passed. No fix plans required.
- 2026-04-24: Milestone 3 (RLM) planned. Added Phases 26-30 to ROADMAP and R26-R30 requirement blocks. Milestone 2 phases 22-25 deferred to backlog.

## Last Activity: 2026-07-11 22:01:59
