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

## Phase 13: Model Router — `complete`
**Goal:** Role-based model routing with direct API calls, auto-fallback, and cost tracking in `packages/router/`.
**Requirements:** R13-RT.1 (router config schema), R13-RT.2 (role→model mapping with fallback chains), R13-RT.3 (CLI commands: set/show/test), R13-RT.4 (auto-fallback on error/rate-limit/timeout), R13-RT.5 (cost tracking per role/session), R13-RT.6 (coding-agent extension for automatic model selection)
**Acceptance:** `draht router show` displays config, fallback works on simulated errors, cost log written to `.draht/cost-log.jsonl`.

## Phase 14: TDD-First Core — `complete`
**Goal:** Embed TDD into every part of the Draht workflow — plan templates, hooks, agents, CI.
**Requirements:** R14-TDD.1 (task template: test→action→refactor), R14-TDD.2 (commit-task warns on missing tests), R14-TDD.3 (post-task hook runs tests), R14-TDD.4 (quality gate coverage threshold), R14-TDD.5 (AGENTS.md templates TDD section), R14-TDD.6 (workflow files enforce test-first), R14-TDD.7 (coding-agent TDD mode)
**Acceptance:** `create-plan` generates test blocks first, hooks reject on test failure, coverage gate at 80%.

## Phase 15: DDD-First Core — `complete`
**Goal:** Embed DDD into project initialization — domain model, bounded contexts, ubiquitous language.
**Requirements:** R15-DDD.1 (create-project domain model section), R15-DDD.2 (create-requirements bounded context mapping), R15-DDD.3 (create-domain-model command), R15-DDD.4 (map-codebase domain extraction), R15-DDD.5 (knowledge base domain glossary), R15-DDD.6 (CI domain naming checks), R15-DDD.7 (AGENTS.md DDD section)
**Acceptance:** `create-project` includes domain model, `create-domain-model` generates from PROJECT.md, CI flags naming violations.

## Phase 16: Invoice Generator — `complete`
**Goal:** Lexoffice API integration for German freelancer invoicing with time tracking in `packages/invoice/`.
**Requirements:** R16-INV.1 (Lexoffice API client), R16-INV.2 (invoice templates hourly/fixed), R16-INV.3 (Toggl time tracking integration), R16-INV.4 (coding-agent extension /invoice commands), R16-INV.5 (auto-generate from project data)
**Acceptance:** Invoice CRUD works against Lexoffice API, Toggl hours imported, coding agent commands registered.

## Phase 17: Compliance Checker — `complete`
**Goal:** GDPR and EU AI Act compliance checking with German legal templates in `packages/compliance/`.
**Requirements:** R17-CMP.1 (GDPR PII scanner), R17-CMP.2 (EU AI Act documentation validator), R17-CMP.3 (coding-agent compliance extension), R17-CMP.4 (German legal templates), R17-CMP.5 (compliance report generator)
**Acceptance:** PII scanner catches test cases, legal templates generated, report passes sample audit.

## Phase 18: draht.dev Website Content — `complete`
**Goal:** Full content for the Astro landing page — features, architecture, getting started, blog scaffold, SEO.
**Requirements:** R18-WEB.1 (feature descriptions), R18-WEB.2 (architecture diagram), R18-WEB.3 (getting started guide), R18-WEB.4 (pricing/positioning), R18-WEB.5 (blog scaffold), R18-WEB.6 (SEO meta/OG/sitemap)
**Acceptance:** Landing page has real content, all sections filled, sitemap.xml generated, OG images present.

---

## Milestone 2: Integration Hardening

## Phase 19: GSD CLI Integration — `complete`
**Goal:** draht CLI commands work as real TypeScript modules inside coding-agent, replacing shell-script stubs.
**Requirements:** R14-TDD.1, R14-TDD.2, R14-TDD.3, R14-TDD.7, R15-DDD.3, R15-DDD.4, R19-GSD.1, R19-GSD.2, R19-GSD.3
**Acceptance:** `/create-plan`, `/commit-task`, `/create-domain-model`, `/map-codebase` commands execute real draht functions; enhanced hooks run during `/execute` and `/verify` flows; gsd-commands extension loads and registers all commands.

## Phase 20: TDD/DDD Hook Hardening — `complete`
**Goal:** Hooks are production-ready with auto-detected toolchains, configurable thresholds, and domain checks.
**Requirements:** R14-TDD.4, R15-DDD.5, R15-DDD.6, R20-HOOK.1, R20-HOOK.2, R20-HOOK.3
**Acceptance:** Hook auto-detects npm/bun/pnpm test runner (no hardcoded `bun test`); coverage threshold configurable via `.planning/config.json` (default 80%); TDD cycle check supports strict and advisory modes; domain glossary validated against DOMAIN-MODEL.md; all hooks have vitest tests.

## Phase 21: GSD Integration Tests — `complete`
**Goal:** End-to-end GSD lifecycle is verified by automated tests.
**Requirements:** R21-INT.1, R21-INT.2, R21-INT.3, R21-INT.4
**Acceptance:** Full lifecycle test passes (create-project → commit-task → verify-phase); map-codebase test produces valid domain extraction; quality gate pass/fail tests cover both outcomes; gsd-commands extension loading test confirms registration.

## Phase 22: Router Hardening — `pending`
**Goal:** Model router is reliable under failure conditions with accurate cost tracking.
**Requirements:** R22-RTR.1, R22-RTR.2, R22-RTR.3
**Acceptance:** Fallback chain integration tests pass with simulated provider failures; cost tracking matches expected values within 1% tolerance; config validation rejects invalid schemas with clear errors.

## Phase 23: Multi-Agent Layer — `pending`
**Goal:** Full multi-agent orchestration layer: FSM protocol, mailbox messaging, task board, worktree isolation, permission gate.
**Requirements:** R23-MA.1 (FSM protocol), R23-MA.2 (teammate mailboxes), R23-MA.3 (autonomous task board), R23-MA.4 (worktree isolator), R23-MA.5 (permission gate), R23-MA.6 (integration with subagent builtin)
**Acceptance:** FSM state transitions validated; mailbox pub/sub delivers messages between agents; task board supports self-assign with atomic locking; worktree isolator creates/merges git worktrees with conflict detection; permission gate evaluates YAML rules with deny/allow/approve tiers; all primitives integrated into subagent.ts.

## Phase 24: Invoice/Compliance Tests — `pending`
**Goal:** Invoice and compliance modules are verified against realistic test data.
**Requirements:** R24-API.1, R24-API.2, R24-API.3, R24-API.4
**Acceptance:** Lexoffice mock integration tests cover CRUD operations; Toggl mock tests cover time entry import; PII scanner achieves target accuracy on German corpus; EU AI Act template validation passes against sample documentation.

## Phase 25: CI & Artifact Cleanup — `pending`
**Goal:** CI pipeline runs on PRs and all planning artifacts are accurate and consolidated.
**Requirements:** R25-CI.1, R25-CI.2, R25-DOC.1, R25-DOC.2
**Acceptance:** GitHub Actions PR check workflow runs lint + test on push; AI review dogfooding enabled on draht-mono PRs; Phase 14-18 summaries contain real data (not placeholders); hook files consolidated to single source of truth with no duplication.

---

## Milestone 3: Recursive Language Models

> **Paradigm:** Zhang, Kraska, Khattab (2026) — *Recursive Language Models* (arXiv:2512.24601). Treat long prompts as external objects inside a REPL environment; root LLM writes code to peek, decompose, and recursively invoke sub-LLMs over slices of the prompt. Scales effective context 10×–1000× without finetuning.
>
> **Scope for v1:** inference-time scaffold only (no RLM-native training). Use existing frontier models via `@draht/router`. Python-subprocess REPL for model-prompt parity with the paper; Node `vm` considered as a v2 fallback.
>
> **Milestone 2 carry-forward:** Phases 22–25 remain pending backlog and are not a prerequisite for Milestone 3.

## Phase 26: RLM Core Primitives — `pending`
**Goal:** `@draht/rlm` package exposes an `RlmSession` that runs the root loop: root-LLM-produces-code → REPL-executes → truncated-stdout → history-append → FINAL-check, with a working `llm_query` and `FINAL`/`FINAL_VAR` sentinels.
**Requirements:** R26-RLM.1, R26-RLM.2, R26-RLM.3, R26-RLM.4, R26-RLM.5, R26-RLM.6, R26-RLM.7
**Acceptance:** Unit tests prove: a seeded needle-in-haystack prompt completes via a mocked root LLM that writes Python; REPL persists variables across steps; `context` variable holds the full prompt; `llm_query` stub returns a canned response; `FINAL("x")` and `FINAL_VAR("ans")` both terminate the loop and return the correct value.

## Phase 27: Sub-LLM Integration & System Prompts — `pending`
**Goal:** RLM sessions route root and sub-LLM calls through `@draht/router` with model-tiered system prompts (frontier / coder-mid / small-context) and cost accounting per trajectory.
**Requirements:** R27-SLM.1, R27-SLM.2, R27-SLM.3, R27-SLM.4, R27-SLM.5
**Acceptance:** Router has new roles `rlm-root` and `rlm-sub` with configurable fallback chains; three system-prompt templates in `packages/rlm/prompts/` select automatically from resolved model context window; prompt template substitutes `context_type`, `context_total_length`, `chunk_lengths`, `max_sub_call_budget`; every RLM session appends per-call cost entries to `.draht/cost-log.jsonl` tagged with trajectory id.

## Phase 28: REPL Sandbox & Safety — `pending`
**Goal:** REPL execution is sandboxed with hard resource limits, stdout caps, and session-wide sub-LLM budgets so RLM cannot exfiltrate or runaway.
**Requirements:** R28-SBX.1, R28-SBX.2, R28-SBX.3, R28-SBX.4, R28-SBX.5, R28-SBX.6
**Acceptance:** Python REPL runs as a sandboxed child process with no network, no filesystem outside an explicit session workdir, and seccomp/ulimit-style CPU + memory ceilings; per-step timeout default 30s, max-iterations default 24, max-sub-calls and max-session-cost enforced; stdout truncated to configurable cap (default 2 KB) with explicit `[truncated N chars]` marker; security test suite proves `import os; os.system("...")`, `open("/etc/passwd")`, and `urllib.request.urlopen(...)` all fail; budget-exhausted stop returns a typed error the agent can handle.

## Phase 29: Draht Agent & CLI Integration — `pending`
**Goal:** RLM is invokable from the coding-agent (`/rlm`), the `draht` CLI, and from inside other agent tools (`rlm_query` tool), with input loaders for files, directories, URLs, and the client knowledge base.
**Requirements:** R29-INT.1, R29-INT.2, R29-INT.3, R29-INT.4, R29-INT.5
**Acceptance:** `packages/rlm-agent/` extension registers `/rlm <input> <query>` in coding-agent; `draht rlm --input <path|glob|url> --query "..."` CLI returns an answer on a 500 KB+ fixture; `rlm_query` tool usable inside normal agent flow to defer long reads; `@draht/knowledge` loader pulls client AGENTS.md + decisions into RLM context; a GSD plan can declare `rlm: true` and `/execute-phase` routes oversize inputs through RLM automatically.

## Phase 30: Evaluation, Observability & Docs — `pending`
**Goal:** RLM trajectories are measurable, replayable, and documented so developers can trust and tune them.
**Requirements:** R30-EVAL.1, R30-EVAL.2, R30-EVAL.3, R30-EVAL.4, R30-EVAL.5
**Acceptance:** Every RLM session emits a trajectory JSONL (step, code, truncated-stdout, sub-calls, cost, final); synthetic S-NIAH regression test passes on input 10× the root model's window; cost comparison harness records RLM vs base-LLM-with-truncation on the same task; `draht rlm replay <trajectory-id>` reconstructs the final answer from the log alone; README + AGENTS.md sections document when to use RLM, how to bound costs, and a worked end-to-end example.

---

## Milestone 4: geist

> **Source spec:** `.planning/specs/geist-spec.md` (rev 7, locked — no open decisions). Harness-agnostic spatial ADE for Quest 3: point at a running app or an ACP coding-agent session, talk to change or steer it — any ACP agent (Claude Code, Codex, Gemini CLI, draht, ~50 in the registry). Home: this monorepo, with a hard import boundary — `geist-core`/`geist-acp`/`geist-console`/`quest/` import zero `@draht/*`; only `packages/draht-acp` may (spec §17.1, R31-FOUND.4).
> **Phase mapping:** Phase 31 is foundation/scaffold work the spec's own milestone list (§16) doesn't name explicitly; Phases 32–40 map 1:1 to the spec's M0–M8. Every phase from 32 on carries two kinds of acceptance: an automated ✅ e2e criterion (mock-ACP-agent-based, CI-checkable) and, where the spec defines one, an H-gate — a human/hardware demo on Oskar's physical Quest 3 that this GSD loop can never self-certify. H-gates are recorded as evidence debt on the phase, not a blocker to closing its automated acceptance.
> **Sandbox constraint:** the environment executing this milestone's early phases has no Quest headset, no `gradle`/`kotlinc` on PATH, and no Meta Spatial SDK Maven credentials. `quest/` (Kotlin) work is scaffolded structurally but not build-verified here; H-gates require Oskar's machine.
> **Milestone 2/3 carry-forward:** Phases 22–25 and 26–30 remain pending backlog and are not a prerequisite for Milestone 4 (same precedent as Milestone 3's carry-forward above).

## Phase 31: Geist Foundation & Repo Scaffold — `complete`
**Goal:** The repo layout, workspace wiring, and cross-cutting contracts every geist milestone depends on exist and are boundary-checked.
**Requirements:** R31-FOUND.1, R31-FOUND.2, R31-FOUND.3, R31-FOUND.4, R31-FOUND.5, R31-FOUND.6
**Acceptance:** `packages/geist/`, `packages/geist-core/`, `packages/geist-acp/`, `packages/draht-acp/`, `packages/geist-protocol/`, `packages/geist-picker/`, `packages/geist-console/` exist as npm workspaces (package.json + tsconfig, wired into root tsconfig `paths`); `quest/` exists as a Kotlin project skeleton and is explicitly NOT an npm workspace; a zod schema in `geist-protocol` validates the `geist.yaml` harness config contract (spec §9.1) and `geist.yaml.example` passes it; `scripts/check-geist-boundary.mjs` fails root `check` if `geist-core`/`geist-acp`/`geist-console`/`quest` import `@draht/*` (only `draht-acp` may) and is wired into root `npm run check`; `scripts/check-geist-mirrors.mjs` exists per spec §6's tooling row; `docs/geist/spec.md` and `.planning/geist/README.md` exist per the locked repo layout (§8).

## Phase 32: M0 — Spike: Panel + Ray — `complete`
**Goal:** Kotlin/Spatial-SDK panel-and-ray-cast spike exists structurally; the panel-alpha probe decision point is implemented.
**Requirements:** R32-M0.1, R32-M0.2, R32-M0.3, R32-M0.4
**Acceptance:** `quest/` renders a passthrough panel via Meta Spatial SDK and resolves ray→plane addressee hits (structural scaffold — build/run verification deferred, no Quest hardware or Meta SDK Maven access in this sandbox); the panel-alpha probe (room-glass vs opaque-smoke fallback, spec §13/§17.6) is implemented with both code paths present; H0 (hover-coords evidence) is logged as evidence debt in `.planning/geist/`, pending Oskar's hardware.

## Phase 33: M1 — Pairing + Voice Wire — `complete`
**Goal:** Bridge↔headset pairing and the whisper.cpp DE/EN voice pipeline are wired; the console ships on geist-glass tokens from its first pixel.
**Requirements:** R33-M1.1, R33-M1.2, R33-M1.3, R33-M1.4
**Acceptance:** WS pairing handshake (LAN, token) connects bridge and headset and survives a reconnect; `geist-console` renders exclusively from `tokens.css` (no unstyled/restyle-later state); whisper.cpp turbo/small transcribes DE/EN test fixtures; H1 (9/10 live transcripts, pairing survives restart) is logged as evidence debt.

## Phase 34: M2 — Context Pack — `complete`
**Goal:** Element pointing composes an `ElementContext` situation prompt with capability-gated image delivery and an always-present crop path reference.
**Requirements:** R34-M2.1, R34-M2.2, R34-M2.3
**Acceptance:** `ElementContext` composition (spec §9.3, unchanged from r2) is implemented in `geist-core`; an image content block is attached only when the session's capability handshake advertises image support, while the crop is always written to `<wt>/.geist/task-<id>/target.webp` and path-referenced in the prompt; H2 (chip + crop demo) is logged as evidence debt.

## Phase 35: M3 — ACP Loop Closes — `complete`
**Goal:** `geist-acp`'s `HarnessSession` port drives a real ACP client against a deterministic in-repo mock agent and against draht (via a new `draht-acp` shim) and Claude Code (`claude-agent-acp`), with permission rendering and a sha ledger.
**Requirements:** R35-M3.1, R35-M3.2, R35-M3.3, R35-M3.4, R35-M3.5, R35-M3.6, R35-M3.7
**Acceptance:** ✅ e2e vs the mock ACP agent: dispatch → tool-call events → edit → turn end + dirty git → `awaiting_review` → approve/undo/stop, full permission round-trip; ✅ the same fake-headset script passes against `draht-acp` in CI, keyless via draht's faux provider inside the shim's own tests; ✅ `smoke:harness -- claude` passes (network, non-CI, `claude-agent-acp`); sha ledger (`baseSha`/`lastApprovedSha`, undo = `reset --hard <ref>`) is implemented; H3 (fr3n button change end-to-end on both harnesses; one permission answered by voice) is logged as evidence debt.

## Phase 36: M4 — Commands, Addressing, Project & Harness Grammar — `complete`
**Goal:** ACP-advertised commands/modes surface as palette + voice options (verbatim `/…` pass-through always available); harness and project qualifiers resolve per the locked grammar order.
**Requirements:** R36-M4.1, R36-M4.2, R36-M4.3, R36-M4.4
**Acceptance:** ✅ advertised-command golden test per mock capability profile; ✅ *"new claude session in \<fixture\>: x"* spawns the right harness in the right project path; ✅ resolution-order test proves qualifiers (reserved verbs → command → harness → project → text) can never shadow an earlier stage; H4 (voice-spawn a draht `/plan` and a Claude session in two projects, disambiguate by re-say) is logged as evidence debt.

## Phase 37: M5 — Fleet Across Projects & Harnesses — `complete`
**Goal:** The fleet board supports ≤4 sessions spanning multiple projects and mixed harnesses, with capability badges and scoped approve/undo/stop.
**Requirements:** R37-M5.1, R37-M5.2, R37-M5.3
**Acceptance:** ✅ 3 mock sessions across 2 capability profiles and 2 fixture repos prove isolation via `fleet_state` goldens; ✅ scoped undo test confirms undo on one session never touches another's worktree; H5 (fr3n on draht + kintura on claude simultaneously, point-routed, 72 Hz with 3 live panels and tier-1 glass on — OVR evidence) is logged as evidence debt.

## Phase 38: M6 — Variants, Optionally Mixed — `complete`
**Goal:** `variants_new` supports an optional per-member harness list that round-robins across configured agents; winner-by-pointing keeps the winner and resets/prunes siblings.
**Requirements:** R38-M6.1, R38-M6.2
**Acceptance:** ✅ e2e against mixed mock capability profiles: winner session is kept, sibling worktrees are reset and pruned; H6 (3-way shoot-out across harnesses, winner picked by pointing) is logged as evidence debt.

## Phase 39: M7 — Run Rendering — `pending`
**Goal:** Generic ACP tool-call/plan-update lanes render for every harness; `subagent-recognizer.ts` upgrades draht/Claude-Task-style calls to typed lanes; `LOOP.md` surfaces when present.
**Requirements:** R39-M7.1, R39-M7.2, R39-M7.3
**Acceptance:** ✅ scripted mock tool-call sequences produce golden lane output for both generic and draht-typed cases (data-driven, golden-tested recognizer); ✅ a stop command cancels an in-flight run cleanly; H7 (real draht `/orchestrate` lanes live; a Claude session's tool activity renders as untyped generic lanes) is logged as evidence debt.

## Phase 40: M8 — Spatial Dividends (v1.5) — `pending`
**Goal:** Multi-viewport, pins, history, and pose persistence land as the v1.5 spatial-organization dividend.
**Requirements:** R40-M8.1
**Acceptance:** H8 (two-viewport layout fix demoed; workspace pose restores after a headset restart) is logged as evidence debt — this phase is entirely hardware-gated per spec §2/§16 and has no automated ✅ criterion of its own.
