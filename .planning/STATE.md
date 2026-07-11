# State

## Current Phase: Phase 33: M1 — Pairing + Voice Wire
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
- Milestone 4 approved: geist, Phases 31-40 — a harness-agnostic ACP-client spatial ADE for Quest 3, spec locked at `.planning/specs/geist-spec.md` (rev 7). Phase 31 is foundation/scaffold work the spec doesn't name; Phases 32-40 map 1:1 to the spec's M0-M8. Phases 22-25 and 26-30 remain pending backlog, not a blocker (same precedent as Milestone 3). Every phase's H-gate (hardware/voice demo on Oskar's physical Quest 3) is recorded as evidence debt, never auto-certified by this loop — this sandbox has no Quest headset, no gradle/kotlinc on PATH, and no Meta Spatial SDK Maven access, so `quest/` (Kotlin) work is scaffolded structurally, not build-verified, until Oskar runs it on his machine. (autonomous /loop session, 2026-07-11, per Oskar's directive to complete the spec via ultracode multi-agent orchestration — fable-5 advisor consult, sonnet/opus workers)

## Completed Phases
- Phase 33: M1 — Pairing + Voice Wire (commit 60a3339cb; H1 evidence logged as debt, requires Oskar's Quest 3 + a real DE/turbo whisper model)
- Phase 32: M0 — Spike: Panel + Ray (commit 2cc48c9d8; H0 hover-coords evidence logged as debt, requires Oskar's Quest 3)
- Phase 31: Geist Foundation & Repo Scaffold (commit 62b5945a2)
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
- 2026-07-11: Milestone 4 (geist) planned from the locked spec. Added Phases 31-40 to ROADMAP, R31-FOUND through R40-M8 requirement blocks to REQUIREMENTS.md, and a geist bounded context (Tier F) to DOMAIN.md. Advisor (fable-5) sanity-checked the phase mapping and confirmed draht-tools has no sequential phase-completion gating, so a hardware-blocked phase (32/M0) cannot stall 33+.
- 2026-07-11: Phase 31 executed via a 6-agent ultracode Workflow (4 parallel `draht:implementer` on sonnet, 1 opus verifier, 1 opus reviewer). Both the verifier and reviewer independently found the same single blocker — `packages/geist-protocol/test/**/*` wasn't added to root `tsconfig.json`'s `exclude`, unlike the router/invoice/compliance bun:test precedent — fixed with the one-line addition both had already verified. Landed as commit 62b5945a2. All R31-FOUND.1-6 requirements confirmed with quoted command evidence (boundary script genuinely blocks/allows the right imports under injected-violation tests, config schema validates geist.yaml.example, quest/ confirmed not a workspace, full-repo `tsgo --noEmit` clean).

- 2026-07-11: Phase 32 (M0) executed via a 2-agent ultracode Workflow (sonnet implementer, opus reviewer). Panel scaffold + real ray-plane intersection math + both panel-alpha code paths landed as commit 2cc48c9d8; reviewer traced the ray-plane derivation by hand and confirmed no fabricated Spatial SDK API. H0 recorded as evidence debt (needs Oskar's Quest 3) rather than blocking phase completion.
- 2026-07-11: Phase 33 (M1) executed via two ultracode Workflow passes (3 parallel sonnet implementers + opus verify/review, then an opus fix-and-reverify pass). First pass found the same tsconfig-exclude gap as Phase 31 (recurring pattern — new packages need explicit root `tsconfig.json` exclude entries; established convention is a per-package `test/` dir, not co-located `*.test.ts`) plus a real bug in the pairing state machine (`disconnect()` could silently reset the 60s grace clock on a stray reconnect attempt, letting a session stay "paired" indefinitely). Fix pass resolved both with red/green proof of the bug fix; independent re-verify confirmed all 9 checks green before commit 60a3339cb. H1 recorded as evidence debt.

## Last Activity: 2026-07-11
