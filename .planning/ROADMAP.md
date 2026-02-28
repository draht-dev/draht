# Roadmap

## Phase 1: Rebrand — `complete`
**Goal:** All packages renamed to @draht/ namespace, docs updated, builds pass.
**Requirements:** R1.1, R1.2, R1.3, R1.4, R1.5, R5.1, R5.2, R5.3
**Acceptance:** `npm run build` succeeds, all references to @mariozechner removed from package names.

## Phase 2: SST v4 Infrastructure — `complete`
**Goal:** `packages/infra/` exists with SST v4 config defining Lambda, API Gateway, DynamoDB.
**Requirements:** R2.1, R2.2, R2.3, R2.4, R2.5, R2.6
**Acceptance:** Package compiles, sst.config.ts is valid SST v4, resources are defined (not deployed).

## Phase 3: SST Resource Manager Extension — `complete`
**Goal:** Working coding-agent extension that provides SST resource query tools.
**Requirements:** R3.1, R3.2, R3.3, R3.4
**Acceptance:** Extension loads in coding-agent, tools are registered, TypeScript compiles.

## Phase 4: AGENTS.md Template Library — `complete`
**Goal:** Three usable AGENTS.md templates for common stacks.
**Requirements:** R4.1, R4.2, R4.3, R4.4, R4.5
**Acceptance:** Templates are well-structured, actionable, and cover stack-specific conventions.

## Phase 5: Client Knowledge Base Extension — `complete`
**Goal:** Vector DB per client for knowledge persistence across projects, with coding agent extension that auto-loads context.
**Requirements:** R5-KB.1, R5-KB.2, R5-KB.3, R5-KB.4, R5-KB.5
**Acceptance:** Extension loads in coding-agent, auto-injects client AGENTS.md + past decisions into context, Zvec integration works for local knowledge search.

## Phase 6: CI/CD AI Review Pipeline — `complete`
**Goal:** GitHub Action that sends PR diffs to Claude with AGENTS.md context for inline review comments.
**Requirements:** R6-CI.1, R6-CI.2, R6-CI.3, R6-CI.4
**Acceptance:** GitHub Action YAML + TypeScript action code in `packages/ci/`, posts inline review comments, blocks merge on critical findings.

## Phase 7: Multi-Agent Orchestration — `complete`
**Goal:** GSD Controller pattern for multi-agent task decomposition and coordination.
**Requirements:** R7-MA.1, R7-MA.2, R7-MA.3, R7-MA.4
**Acceptance:** Controller reads task → creates plan → spawns sub-agents, ticket decomposer breaks work into agent-sized tasks, results are synthesized.

## Phase 8: n8n Client Workflows — `complete`
**Goal:** Workflow JSON templates for client onboarding, daily standup, and invoice/time tracking.
**Requirements:** R8-WF.1, R8-WF.2, R8-WF.3, R8-WF.4
**Acceptance:** Workflow JSON templates in `packages/workflows/`, importable into n8n, cover onboarding → standup → invoicing flows.

## Phase 9: Deploy Guardian Extension — `complete`
**Goal:** Pre-deployment checks, rollback automation, and SST-specific deployment safety.
**Requirements:** R9-DG.1, R9-DG.2, R9-DG.3, R9-DG.4
**Acceptance:** Extension provides pre-deploy checklist, Lighthouse integration, rollback commands, never auto-deploys.

## Phase 10: Draht CLI & Branding — `complete`
**Goal:** Rename CLI entry point from `pi` to `draht`, update all bin entries, create draht.dev landing page scaffold, CLI branding.
**Requirements:** R10-CLI.1 (rename pi→draht bin entries), R10-CLI.2 (update all package.json bin fields), R10-CLI.3 (draht.dev landing page scaffold with Astro+SST), R10-CLI.4 (CLI help text, version command, branding)
**Acceptance:** `draht` command works, all bin references updated, landing page scaffold deploys, `draht --version` and `draht --help` work.

## Phase 11: Testing Infrastructure — `complete`
**Goal:** Add test runners to all new packages, integration tests for extension loading, CI pipeline.
**Requirements:** R11-TEST.1 (vitest/bun:test for knowledge, ci, orchestrator, deploy-guardian), R11-TEST.2 (integration tests for extension loading into coding-agent), R11-TEST.3 (GitHub Actions CI pipeline for automated testing on PR)
**Acceptance:** All new packages have test suites that pass, extensions load correctly in integration tests, CI runs automatically on PR.

## Phase 12: Documentation & README — `complete`
**Goal:** Comprehensive documentation for draht-mono and all packages.
**Requirements:** R12-DOC.1 (full README.md for draht-mono), R12-DOC.2 (per-package README updates for all @draht/* packages), R12-DOC.3 (CONTRIBUTING.md update for Draht workflow)
**Acceptance:** README covers installation, architecture, packages, getting started. Each package has updated README. CONTRIBUTING.md reflects current workflow.
