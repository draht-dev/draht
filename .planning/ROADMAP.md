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

## Phase 13: Model Router — `in-progress`
**Goal:** Role-based model routing with direct API calls, auto-fallback, and cost tracking in `packages/router/`.
**Requirements:** R13-RT.1 (router config schema), R13-RT.2 (role→model mapping with fallback chains), R13-RT.3 (CLI commands: set/show/test), R13-RT.4 (auto-fallback on error/rate-limit/timeout), R13-RT.5 (cost tracking per role/session), R13-RT.6 (coding-agent extension for automatic model selection)
**Acceptance:** `draht router show` displays config, fallback works on simulated errors, cost log written to `.draht/cost-log.jsonl`.

## Phase 14: TDD-First Core — `complete`
**Goal:** Embed TDD into every part of the Draht workflow — plan templates, hooks, agents, CI.
**Requirements:** R14-TDD.1 (task template: test→action→refactor), R14-TDD.2 (commit-task warns on missing tests), R14-TDD.3 (post-task hook runs tests), R14-TDD.4 (quality gate coverage threshold), R14-TDD.5 (AGENTS.md templates TDD section), R14-TDD.6 (workflow files enforce test-first), R14-TDD.7 (coding-agent TDD mode)
**Acceptance:** `create-plan` generates test blocks first, hooks reject on test failure, coverage gate at 80%.

## Phase 15: DDD-First Core — `planned`
**Goal:** Embed DDD into project initialization — domain model, bounded contexts, ubiquitous language.
**Requirements:** R15-DDD.1 (create-project domain model section), R15-DDD.2 (create-requirements bounded context mapping), R15-DDD.3 (create-domain-model command), R15-DDD.4 (map-codebase domain extraction), R15-DDD.5 (knowledge base domain glossary), R15-DDD.6 (CI domain naming checks), R15-DDD.7 (AGENTS.md DDD section)
**Acceptance:** `create-project` includes domain model, `create-domain-model` generates from PROJECT.md, CI flags naming violations.

## Phase 16: Invoice Generator — `planned`
**Goal:** Lexoffice API integration for German freelancer invoicing with time tracking in `packages/invoice/`.
**Requirements:** R16-INV.1 (Lexoffice API client), R16-INV.2 (invoice templates hourly/fixed), R16-INV.3 (Toggl time tracking integration), R16-INV.4 (coding-agent extension /invoice commands), R16-INV.5 (auto-generate from project data)
**Acceptance:** Invoice CRUD works against Lexoffice API, Toggl hours imported, coding agent commands registered.

## Phase 17: Compliance Checker — `planned`
**Goal:** GDPR and EU AI Act compliance checking with German legal templates in `packages/compliance/`.
**Requirements:** R17-CMP.1 (GDPR PII scanner), R17-CMP.2 (EU AI Act documentation validator), R17-CMP.3 (coding-agent compliance extension), R17-CMP.4 (German legal templates), R17-CMP.5 (compliance report generator)
**Acceptance:** PII scanner catches test cases, legal templates generated, report passes sample audit.

## Phase 18: draht.dev Website Content — `planned`
**Goal:** Full content for the Astro landing page — features, architecture, getting started, blog scaffold, SEO.
**Requirements:** R18-WEB.1 (feature descriptions), R18-WEB.2 (architecture diagram), R18-WEB.3 (getting started guide), R18-WEB.4 (pricing/positioning), R18-WEB.5 (blog scaffold), R18-WEB.6 (SEO meta/OG/sitemap)
**Acceptance:** Landing page has real content, all sections filled, sitemap.xml generated, OG images present.
