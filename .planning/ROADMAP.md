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

## Phase 22: Router Hardening — `complete`
**Goal:** Model router is reliable under failure conditions with accurate cost tracking.
**Requirements:** R22-RTR.1, R22-RTR.2, R22-RTR.3
**Acceptance:** Fallback chain integration tests pass with simulated provider failures; cost tracking matches expected values within 1% tolerance; config validation rejects invalid schemas with clear errors.

## Phase 23: Multi-Agent Layer — `complete`
**Goal:** Full multi-agent orchestration layer: FSM protocol, mailbox messaging, task board, worktree isolation, permission gate.
**Requirements:** R23-MA.1 (FSM protocol), R23-MA.2 (teammate mailboxes), R23-MA.3 (autonomous task board), R23-MA.4 (worktree isolator), R23-MA.5 (permission gate), R23-MA.6 (integration with subagent builtin)
**Acceptance:** FSM state transitions validated; mailbox pub/sub delivers messages between agents; task board supports self-assign with atomic locking; worktree isolator creates/merges git worktrees with conflict detection; permission gate evaluates YAML rules with deny/allow/approve tiers; all primitives integrated into subagent.ts.

## Phase 24: Invoice/Compliance Tests — `complete`
**Goal:** Invoice and compliance modules are verified against realistic test data.
**Requirements:** R24-API.1, R24-API.2, R24-API.3, R24-API.4
**Acceptance:** Lexoffice mock integration tests cover CRUD operations; Toggl mock tests cover time entry import; PII scanner achieves target accuracy on German corpus; EU AI Act template validation passes against sample documentation.

## Phase 25: CI & Artifact Cleanup — `complete`
**Goal:** CI pipeline runs on PRs and all planning artifacts are accurate and consolidated.
**Requirements:** R25-CI.1, R25-CI.2, R25-DOC.1, R25-DOC.2
**Acceptance:** GitHub Actions PR check workflow runs lint + test on push; AI review dogfooding enabled on draht-mono PRs; Phase 14-18 summaries contain real data (not placeholders); hook files consolidated to single source of truth with no duplication.

---

## Milestone 3: Recursive Language Models

> **Paradigm:** Zhang, Kraska, Khattab (2026) — *Recursive Language Models* (arXiv:2512.24601). Treat long prompts as external objects inside a REPL environment; root LLM writes code to peek, decompose, and recursively invoke sub-LLMs over slices of the prompt. Scales effective context 10×–1000× without finetuning.
>
> **Scope for v1:** inference-time scaffold only (no RLM-native training). Use existing frontier models via `@draht/router`. Python-subprocess REPL for model-prompt parity with the paper; Node `vm` considered as a v2 fallback.
>
> **Milestone 2 carry-forward:** Phases 22–25 were not a prerequisite for Milestone 3 and were completed in parallel with it (2026-07-11/12).

## Phase 26: RLM Core Primitives — `complete`
**Goal:** `@draht/rlm` package exposes an `RlmSession` that runs the root loop: root-LLM-produces-code → REPL-executes → truncated-stdout → history-append → FINAL-check, with a working `llm_query` and `FINAL`/`FINAL_VAR` sentinels.
**Requirements:** R26-RLM.1, R26-RLM.2, R26-RLM.3, R26-RLM.4, R26-RLM.5, R26-RLM.6, R26-RLM.7
**Acceptance:** Unit tests prove: a seeded needle-in-haystack prompt completes via a mocked root LLM that writes Python; REPL persists variables across steps; `context` variable holds the full prompt; `llm_query` stub returns a canned response; `FINAL("x")` and `FINAL_VAR("ans")` both terminate the loop and return the correct value.

## Phase 27: Sub-LLM Integration & System Prompts — `complete`
**Goal:** RLM sessions route root and sub-LLM calls through `@draht/router` with model-tiered system prompts (frontier / coder-mid / small-context) and cost accounting per trajectory.
**Requirements:** R27-SLM.1, R27-SLM.2, R27-SLM.3, R27-SLM.4, R27-SLM.5
**Acceptance:** Router has new roles `rlm-root` and `rlm-sub` with configurable fallback chains; three system-prompt templates in `packages/rlm/prompts/` select automatically from resolved model context window; prompt template substitutes `context_type`, `context_total_length`, `chunk_lengths`, `max_sub_call_budget`; every RLM session appends per-call cost entries to `.draht/cost-log.jsonl` tagged with trajectory id.

## Phase 28: REPL Sandbox & Safety — `complete`
**Goal:** REPL execution is sandboxed with hard resource limits, stdout caps, and session-wide sub-LLM budgets so RLM cannot exfiltrate or runaway.
**Requirements:** R28-SBX.1, R28-SBX.2, R28-SBX.3, R28-SBX.4, R28-SBX.5, R28-SBX.6
**Acceptance:** Python REPL runs as a sandboxed child process with no network, no filesystem outside an explicit session workdir, and seccomp/ulimit-style CPU + memory ceilings; per-step timeout default 30s, max-iterations default 24, max-sub-calls and max-session-cost enforced; stdout truncated to configurable cap (default 2 KB) with explicit `[truncated N chars]` marker; security test suite proves `import os; os.system("...")`, `open("/etc/passwd")`, and `urllib.request.urlopen(...)` all fail; budget-exhausted stop returns a typed error the agent can handle.

## Phase 29: Draht Agent & CLI Integration — `complete`
**Goal:** RLM is invokable from the coding-agent (`/rlm`), the `draht` CLI, and from inside other agent tools (`rlm_query` tool), with input loaders for files, directories, URLs, and the client knowledge base.
**Requirements:** R29-INT.1, R29-INT.2, R29-INT.3, R29-INT.4, R29-INT.5
**Acceptance:** `packages/rlm-agent/` extension registers `/rlm <input> <query>` in coding-agent; `draht rlm --input <path|glob|url> --query "..."` CLI returns an answer on a 500 KB+ fixture; `rlm_query` tool usable inside normal agent flow to defer long reads; `@draht/knowledge` loader pulls client AGENTS.md + decisions into RLM context; a GSD plan can declare `rlm: true` and `/execute-phase` routes oversize inputs through RLM automatically.

## Phase 30: Evaluation, Observability & Docs — `complete`
**Goal:** RLM trajectories are measurable, replayable, and documented so developers can trust and tune them.
**Requirements:** R30-EVAL.1, R30-EVAL.2, R30-EVAL.3, R30-EVAL.4, R30-EVAL.5
**Acceptance:** Every RLM session emits a trajectory JSONL (step, code, truncated-stdout, sub-calls, cost, final); synthetic S-NIAH regression test passes on input 10× the root model's window; cost comparison harness records RLM vs base-LLM-with-truncation on the same task; `draht rlm replay <trajectory-id>` reconstructs the final answer from the log alone; README + AGENTS.md sections document when to use RLM, how to bound costs, and a worked end-to-end example.

---

## Milestone 4: geist

> **Source spec:** `.planning/specs/geist-spec.md` (rev 7, locked), subject to the explicit amendments required by `.planning/geist/SECURITY-2026-07-13.md`. Harness-agnostic spatial ADE for Quest 3: point at a running app or an ACP coding-agent session, talk to change or steer it. Every non-shim Geist package (`geist`, `geist-core`, `geist-acp`, `geist-protocol`, `geist-picker`, `geist-console`) is protected; only `packages/draht-acp` may import the Draht kernel.
> **Evidence model:** host behavior uses emitted-binary/public-protocol tests against real mock subprocesses; UI uses browser automation; Quest behavior uses Android unit/instrumentation/build evidence; H0–H8 require archived physical Quest 3 evidence. Recording evidence debt satisfies nothing. Numbered REQUIREMENTS are canonical; acceptance/H-gate text here is a summary.
> **2026-07-13 audit correction:** Phases 31–39 are reopened as `pending`; Phase 40 is `pending` and not started. The prior completion decision accepted isolated primitives and package-level tests as product e2e while the production CLI, Quest client, UI composition, and part of the claimed boundary enforcement remained incomplete. See `.planning/geist/AUDIT-2026-07-13.md`. The acceptance statements below are target gates, not claims about current behavior.

## Phase 31: Geist Foundation & Repo Scaffold — `pending`
**Goal:** The repo layout, workspace wiring, and cross-cutting contracts every geist milestone depends on exist and are boundary-checked.
**Requirements:** R31-FOUND.1, R31-FOUND.2, R31-FOUND.3, R31-FOUND.4, R31-FOUND.5, R31-FOUND.6, R31-FOUND.7
**Acceptance:** The existing layout/config/docs scaffolds remain; `scripts/check-geist-boundary.mjs` rejects both direct Draht-kernel imports and `@draht/draht-acp` imports from each of `packages/geist`, `geist-core`, `geist-acp`, `geist-protocol`, `geist-picker`, and `geist-console`, with a separate zero-`@draht/*` Quest mutation; only the shim may import the Draht kernel. Kotlin field/type mirror enforcement is completed with M1 when the headset protocol lands.

## Phase 32: M0 — Spike: Panel + Ray — `pending`
**Goal:** A real Kotlin/Spatial-SDK panel-and-ray-cast spike runs on Quest 3 and produces the panel-alpha/hover evidence needed to continue.
**Requirements:** R32-M0.1, R32-M0.2, R32-M0.3, R32-M0.4
**Acceptance:** A pinned current Meta Spatial SDK build launches on Quest 3, renders a real URL panel, and feeds controller/hand input into tested nearest-panel ray resolution at PTT press; both alpha materials are SDK-bound and selectable; H0 archives hover-coordinate and panel-alpha evidence with commit/APK/headset/SDK identifiers.

## Phase 33: M1 — Pairing + Voice Wire — `pending`
**Goal:** Bridge↔headset pairing and the whisper.cpp DE/EN voice pipeline are wired; the console ships on geist-glass tokens from its first pixel.
**Requirements:** R33-M1.1, R33-M1.2, R33-M1.3, R33-M1.4, R33-M1.5, R33-M1.6, R33-M1.7
**Acceptance:** The emitted `geist` binary loads safe config, owns the bridge, serves `/ui`, launches one named mock session/dispatch, and pairs with the real Kotlin client; pairing survives Quest app recreation and resynchronizes state; PTT `AudioRecord` reaches whisper.cpp with fixed DE/EN fixtures; all headset-visible protocol fields/types are mirror-checked; GSEC-04, GSEC-08, and GSEC-12 are closed; H1 archives at least 9/10 normalized live transcripts plus restart/reconnect evidence.

## Phase 34: M2 — Context Pack — `pending`
**Goal:** Element pointing composes an `ElementContext` situation prompt with capability-gated image delivery and an always-present crop path reference.
**Requirements:** R34-M2.1, R34-M2.2, R34-M2.3
**Acceptance:** A real injected picker freezes the pointed element, writes a decodable WebP to `<wt>/.geist/task-<id>/target.webp`, and shows the crop chip; one public-protocol e2e proves image-capable and path-only ACP profiles receive the correct context; H2 archives the physical chip + crop demo.

## Phase 35: M3 — ACP Loop Closes — `pending`
**Goal:** `geist-acp`'s `HarnessSession` port drives a real ACP client against a deterministic in-repo mock agent and against draht (via a new `draht-acp` shim) and Claude Code (`claude-agent-acp`), with permission rendering and a sha ledger.
**Requirements:** R35-M3.1, R35-M3.2, R35-M3.3, R35-M3.4, R35-M3.5, R35-M3.6, R35-M3.7, R35-M3.8, R35-M3.9
**Acceptance:** One test launches the emitted `geist` binary and drives only its public headset protocol through named harness/worktree spawn → dispatch → tools/plans → deny/allow → edit → blocking review → durable approve → second tracked/untracked edit → transactional restore under the GSEC-05 amendment → stop/cleanup; the same script passes against deterministic mock ACP and keyless `draht-acp`; explicitly invoked Claude smoke fails rather than skips when prerequisites are missing; GSEC-01, GSEC-02, GSEC-03, GSEC-05, GSEC-06, GSEC-07, GSEC-09, GSEC-10, GSEC-11, and GSEC-13 are closed; H3 archives the two-real-harness button change and one voice permission answer.

## Phase 36: M4 — Commands, Addressing, Project & Harness Grammar — `pending`
**Goal:** ACP-advertised commands/modes surface as palette + voice options (verbatim `/…` pass-through always available); harness and project qualifiers resolve per the locked grammar order.
**Requirements:** R36-M4.1, R36-M4.2, R36-M4.3, R36-M4.4, R36-M4.5
**Acceptance:** Live ACP command/mode updates cross the protocol and render in the palette; raw slash commands pass through; public typed/transcribed input *"new claude session in \<fixture\>: x"* launches the configured `claude` command in the exact fixture worktree and dispatches `x`; precedence/collision tests and visible disambiguation pass; H4 archives the two-project voice-spawn/re-say demo.

## Phase 37: M5 — Fleet Across Projects & Harnesses — `pending`
**Goal:** The fleet board supports ≤4 sessions spanning multiple projects and mixed harnesses, with capability badges and scoped approve/undo/stop.
**Requirements:** R37-M5.1, R37-M5.2, R37-M5.3, R37-M5.4
**Acceptance:** Three real spawned mock ACP sessions across two capability profiles and three distinct linked managed worktrees from two fixture repos emit `fleet_state` through the public WS and render three cards/badges in browser automation; approve/undo/stop and capacity rejection are visibly scoped and byte/process isolated; H5 archives the mixed real-harness, point-routing, three-panel, tier-1-glass 72 Hz OVR run.

## Phase 38: M6 — Variants, Optionally Mixed — `pending`
**Goal:** `variants_new` supports an optional per-member harness list that round-robins across configured agents; winner-by-pointing keeps the winner and resets/prunes siblings.
**Requirements:** R38-M6.1, R38-M6.2, R38-M6.3
**Acceptance:** A public `variants_new` request creates sibling Git worktrees and real mock ACP processes with round-robin profiles, dispatches one prompt, and renders a compare row; winner selection through the public target protocol keeps the winner and atomically stops/removes sibling processes and worktrees, including tracked/untracked output; H6 archives the physical three-way pointing shoot-out.

## Phase 39: M7 — Run Rendering — `pending`
**Goal:** Generic ACP tool-call/plan-update lanes render for every harness; `subagent-recognizer.ts` upgrades draht/Claude-Task-style calls to typed lanes; `LOOP.md` surfaces when present.
**Requirements:** R39-M7.1, R39-M7.2, R39-M7.3, R39-M7.4
**Acceptance:** Real mock ACP tool/plan updates flow through the production adapter and WS into browser-rendered generic/typed/plan lanes with golden DOM snapshots; LOOP.md appears and refreshes; a public scoped stop command cancels an in-flight turn with no late events; H7 archives live typed draht `/orchestrate` lanes and untyped Claude lanes.

## Phase 40: M8 — Spatial Dividends (v1.5) — `pending`
**Goal:** Multi-viewport, pins, history, and pose persistence land as the v1.5 spatial-organization dividend.
**Requirements:** R40-M8.1, R40-M8.2
**Acceptance:** Multi-viewport state, pins/history, anchors, and pose serialization/restoration are implemented with recreation/migration tests; H8 archives before/after pose data plus the physical two-viewport and headset-restart restoration demo.

---

## Milestone 5: Rewind & Checkpoints

> **Feature:** first-class `/rewind` — jump a session back to an earlier point, restoring conversation state and working-tree state together, atomically, never destructively. Parity with Claude Code `/rewind` and Codex checkpoint/rewind.
>
> **Starting point:** conversation-side branching is already built into `packages/coding-agent` (session JSONL tree, `SessionManager.branch`/`branchWithSummary`/`createBranchedSession`/`forkFrom`, `AgentSession.navigateTree` with `session_before_tree`/`session_tree` hooks, `/tree`/`/fork`/`/clone` UI, labels). File/working-tree restore does **not** exist — only the unaudited example `examples/extensions/git-checkpoint.ts` (stash-based: misses untracked files, GC-able dangling commits, in-memory only, merges instead of restoring).
>
> **Design spec:** `.planning/specs/2026-07-12-rewind-checkpoint-design.md`. All work in `packages/coding-agent`; no new package.

## Phase 41: Checkpoint Capture & Storage — `complete`
**Goal:** A `CheckpointManager` in `packages/coding-agent/src/core/checkpoints/` captures a git snapshot of the working tree at every `turn_start`, keyed to the initiating session entry id, GC-proof and invisible to the user's git workflow, with sidecar metadata that survives fork/clone and a prune policy.
**Requirements:** R41-CKP.1, R41-CKP.2, R41-CKP.3, R41-CKP.4, R41-CKP.5, R41-CKP.6, R41-CKP.7
**Acceptance:** Integration tests on fixture repos prove: a turn in a dirty repo (tracked edits + untracked file) yields a commit reachable from `refs/draht/checkpoints/<session-id>/<entry-id>` containing both; `git stash list`, the user's index, `HEAD`, and reflog are byte-identical before/after capture; a read-only turn creates no new ref (tree-hash dedup); ignored files are absent from snapshots; sidecar records for preserved entry ids are copied on `/fork` and `/clone`; non-git cwd disables capture with a one-time notice and no errors; `draht checkpoint prune` removes refs per the retention policy; the manager is wired via `core/builtins/` and loads in a real from-scratch session (same empirical-loading proof class as Phases 23/29).

## Phase 42: Rewind Command & Restore UX — `pending`
**Goal:** `/rewind` restores conversation and files together: selector over checkpointed user messages, scope choice (conversation + files / conversation only / files only), a mandatory pre-rewind safety snapshot, diff-driven file restore, and leaf navigation via the existing `navigateTree` path — with `/tree` and `/fork` gaining the same file-restore offer.
**Requirements:** R42-RWD.1, R42-RWD.2, R42-RWD.3, R42-RWD.4, R42-RWD.5, R42-RWD.6, R42-RWD.7, R42-RWD.8
**Acceptance:** End-to-end tests prove: after the agent edits a tracked file, creates a new file, and deletes another, `/rewind` to the prior user message makes the working tree byte-identical to the checkpoint (created file gone, deleted file back); the pre-rewind state is itself recoverable by rewinding forward to the abandoned leaf (redo); a failure injected mid-restore rolls the tree back to the safety snapshot; conversation leaf only moves after file restore succeeds; "conversation only" and "files only" scopes each touch exactly their half; `/tree` navigation and `/fork` to a checkpointed entry offer file restore and honor decline; `pi.checkpoints` (list/get/restore) works from a test extension and `session_before_rewind` can cancel.

## Phase 43: Rewind Safety Hardening, Fallbacks & Docs — `pending`
**Goal:** Rewind is trustworthy at the edges — failure injection, filesystem semantics matrix, concurrency, non-interactive behavior, settings (enable/retention/size guard), performance budget, and documentation replacing the "use git for rollback" guidance.
**Requirements:** R43-SFT.1, R43-SFT.2, R43-SFT.3, R43-SFT.4, R43-SFT.5, R43-SFT.6, R43-SFT.7
**Acceptance:** Failure-injection suite passes (mid-restore kill leaves tree equal to target or safety snapshot, both refs anchored; double-failure path prints both refs); semantics matrix covered by tests (untracked files, files created after checkpoint, ignored files never touched, staged/unstaged split documented as worktree-wins, symlinks, file-mode changes); two concurrent sessions in one repo cannot corrupt each other's refs or indexes; RPC/non-interactive mode never restores files without an explicit option; settings toggle capture, retention, and large-file size guard (warn + skip above threshold); capture p95 < 200 ms and dedup fast-path < 50 ms on the medium fixture repo; docs updated (`session-format.md` sidecar section, `extensions.md` new events, `quickstart.md` rollback note replaced, `examples/extensions/git-checkpoint.ts` marked superseded with a pointer to the built-in).

---

## Milestone 6: Bash Sandbox Confinement

> **Feature:** run the bash tool inside an OS-level sandbox (macOS Seatbelt, Linux Landlock/namespaces) so what a command *can do* is bounded by policy, not string matching — making auto mode safe to stop prompting and closing the interpreter escape hatch (`python -c`, script files, in-language `shutil.rmtree`) that the permission gate documents as unfixable with text matching, for `deny` rules included.
>
> **Starting point:** the permission gate (`src/core/multi-agent/permission-gate.ts`) with session modes default/auto/yolo and a heuristic danger filter is complete and honest about its limits — it protects against a confused agent, not an adversarial one. The execution seam already exists (`BashOperations.exec` in `src/core/tools/bash.ts`, designed for pluggable backends), and Phase 28 already proved the OS-boundary pattern in-repo for the RLM REPL (`packages/rlm/src/sandbox.ts`: `sandbox-exec` + SBPL on macOS, `unshare`/bwrap namespaces on Linux, startup self-test, env hygiene). Key posture difference from Phase 28: bash is the agent's primary limb, so sandbox-unavailable degrades to today's permission gate with a notice (never fail-closed), and in-sandbox policy denials escalate to a "rerun unsandboxed?" approval prompt.
>
> **Design spec:** `.planning/specs/2026-07-12-bash-sandbox-confinement.md`. All work in `packages/coding-agent`; no new package.

## Phase 44: Sandbox Executor Core — `pending`
**Goal:** A `SandboxExecutor` in `packages/coding-agent/src/core/sandbox/` runs bash commands under a write-allowlist + network-toggle policy via platform backends (Seatbelt SBPL on macOS, Landlock with namespace fallback on Linux), with real-path policy generation, startup self-test, env hygiene, and a `BashOperations` wrapper — reporting `unavailable` cleanly everywhere else.
**Requirements:** R44-SBX.1, R44-SBX.2, R44-SBX.3, R44-SBX.4, R44-SBX.5, R44-SBX.6
**Acceptance:** Escape-attempt tests prove confinement on both macOS (local) and Linux (CI): writes outside the allowlist fail whether attempted directly, via a symlink inside the project pointing outside, via `python -c`/a Python script file, or via a node script; with network off, a loopback connect from inside the sandbox fails; ignored escape vectors (writes to project cwd, OS temp, configured cache roots) succeed; the self-test gates `available` status and a deliberately-broken profile makes the executor report `unavailable` rather than running unconfined; the sandboxed child does not inherit the full parent environment; the wrapper implements `BashOperations` and passes the existing bash tool test suite unchanged when sandboxing is off.

## Phase 45: Permission Integration & Escalation UX — `pending`
**Goal:** The sandbox composes with the permission-mode system: `/sandbox` toggle with settings + `DRAHT_SANDBOX` seeding and a status-bar indicator; with sandbox on, auto mode auto-allows confined commands (inline-eval danger patterns stop prompting, outward-facing `git push`/publish patterns and `deny` rules still gate); policy denials detected from the platform signature escalate to a single "rerun unsandboxed?" approval that executes through the unsandboxed backend and is logged.
**Requirements:** R45-SBM.1, R45-SBM.2, R45-SBM.3, R45-SBM.4, R45-SBM.5, R45-SBM.6
**Acceptance:** End-to-end tests on a real session prove: sandbox on + auto mode runs an unmatched command confined and unprompted while `git push` still prompts and a `deny` rule still blocks; a command writing outside the allowlist produces exactly one escalation prompt, decline leaves the denial as the tool result and approve reruns unsandboxed with the rerun logged; non-interactive/RPC mode never escalates (denial is the result); sandbox-unavailable falls back to current gate behavior with a one-time notice and no errors; `extraWritePaths` from settings/`permissions.yml` widen the policy; `/sandbox` and the status indicator reflect state changes; wired via `core/builtins/` with real-session loading proof (same empirical-loading proof class as Phases 23/29).

## Phase 46: Sandbox Hardening, Performance & Docs — `pending`
**Goal:** The boundary earns trust at the edges — adversarial escape suite, both Linux backend paths covered in CI, spawn-overhead budget enforced by test, curated default cache-root allowlist validated by dogfooding on this repo, and docs that reposition the permission gate as heuristic UX in front of a real boundary.
**Requirements:** R46-SBH.1, R46-SBH.2, R46-SBH.3, R46-SBH.4, R46-SBH.5
**Acceptance:** Adversarial suite passes (symlink pivots created mid-command, `/tmp`-relocation tricks, interpreter matrix python/node/ruby/perl inline-and-scriptfile, a git hook triggered by an in-sandbox `git commit` cannot write outside the allowlist, env probe shows no secret-bearing parent vars leak); Linux CI exercises Landlock and the namespace fallback as separate matrix jobs; added spawn overhead p95 < 50 ms enforced by test; a full `npm run check` + build of this monorepo completes inside the sandbox using only the curated default allowlist (dogfood proof); docs updated (`extensions.md`, `quickstart.md` security section, permission-gate module doc pointing at the sandbox as the hard boundary).

---

## Milestone 7: Unified Distribution

> **Feature:** one transactional installer product for the whole Draht surface — `draht-install` (machine components: Claude/Codex plugin payloads, coding-agent CLI, the installer itself; verbs `plan`/`install`/`status`/`doctor`/`update`/`uninstall`) and `draht-init` (project bootstrap), over hash-manifested state under `~/.draht/install/`, with a data-driven component index — plus a canonical provider-neutral Agent Skills tree at repo-root `skills/` from which the Claude/Codex plugin skill+command artifacts are generated, replacing hand-maintained mirrors with byte-equality checks.
>
> **Starting point:** five disconnected install channels (`npx draht-claude install`, `npx draht-codex install`, `npm i -g @draht/coding-agent`, root `install.sh` curl|bash monorepo clone, per-library installs); no manifest anywhere records what was installed; both plugin manifests frozen at `2026.7.7-1` while packages ship `2026.7.30`, so installed plugins cannot detect updates (regression class of `afa6d67d7`); the public `skills` CLI catalog is an accident of a fallback walk (27 skills incl. a leaked example and 17 wrappers broken standalone); unscoped registry names `draht-install`/`draht-init`/`create-draht` unclaimed (verified 2026-08-11); unscoped npm `draht` is third-party — no `draht` bin or package may ever be created.
>
> **Design spec:** `.planning/specs/2026-08-12-unified-distribution-product.md` (adjudicated synthesis of the three 2026-08-11 Fable plans; it also fixes the saga-spawner integration ordering). New package: `packages/install/` (`@draht/install`, bins `draht-install`/`draht-init`). Existing `draht-claude`/`draht-codex` CLIs untouched in v1 (payload sources only); unscoped launcher packages, `next` channel, and the `install.sh` npx rewrite are publish-gated (Phase 52).

## Phase 47: Canonical Skill Source & Generated Artifacts — `pending`
**Goal:** Repo-root `skills/` is the provider-neutral Agent Skills source of truth (9 disciplines + 17 self-contained workflow skills + new `draht` umbrella skill), and the Claude/Codex plugin skill+command content is generated from it through a dialect table with byte-equality drift gates — hand-mirroring and the tolerance-based mirror check retire.
**Requirements:** R47-SKL.1, R47-SKL.2, R47-SKL.3, R47-SKL.4, R47-SKL.5, R47-SKL.6, R47-SKL.7
**Acceptance:** Canonical tree passes native Agent Skills spec validation (closed frontmatter key set, name==dirname, description ≤1024, flat metadata) plus portability lint (no out-of-dir refs, no plugin-root tokens, no host-dialect markers outside an explicit allowlist) and the ≤500-line size gate; regenerating twice is byte-identical and regenerated output equals the committed plugin-package files (`check:skills-artifacts` green in `npm run check` and both plugin `prepublishOnly` scripts); regenerated Claude artifacts are byte-identical to the pre-migration committed files while Codex diffs are exactly the 17 wrapper self-containment rewrites (+ in-dir `command.md`) and both packages gain `skills/draht/`; a native reimplementation of the skills-CLI priority walk over this repo yields exactly the canonical catalog; a generated Codex wrapper dir copied alone to a temp dir resolves its `./command.md` reference; `check-plugin-mirrors.mjs` reduced to agents/-only still passes.

## Phase 48: Install Engine Core — `pending`
**Goal:** `@draht/install` exists as a workspace package with the transactional core: schema-versioned hash-manifested state, append-only JSONL journal, pure plan engine, staged executor with backup/rollback and crash detection — all filesystem-hermetic under test.
**Requirements:** R48-ENG.1, R48-ENG.2, R48-ENG.3, R48-ENG.4, R48-ENG.5, R48-ENG.6
**Acceptance:** `packages/install` builds in the root build chain and passes `npm run check` (root tsconfig exclude added only if the check demands it — the Phase 31/33/35b trap is `bun:test`-specific; vitest precedents `rlm`/`rlm-agent` needed none); state writes survive subprocess SIGKILL injection with old-or-new-never-torn proven by test; plan is pure and deterministic over fixture states (fresh/upgrade/no-op/drift/downgrade-blocked/remove-under-prune); executor fault injection at every checkpoint boundary restores the pre-apply tree byte-identically with `state.json` untouched and a `rolled-back` journal record; double-apply yields an empty second plan; journal reader tolerates a torn final line and open transactions are detectable.

## Phase 49: Component Sources, Detection & Adapters — `pending`
**Goal:** The engine resolves real components from a registry client per channel, fetches and integrity-verifies tarballs into the cache, detects the host environment, and drives claude-plugin / codex-plugin / global-cli adapters — hermetically, against fixture registries and stub host CLIs.
**Requirements:** R49-SRC.1, R49-SRC.2, R49-SRC.3, R49-SRC.4, R49-SRC.5, R49-SRC.6, R49-SRC.7
**Acceptance:** Channel resolution honors dist-tags with `latest` the only accepted channel (`next` refused with the honest frozen-tag message) and downgrades never applied silently; tarball acquisition verifies registry-served ssri integrity and caches by integrity hash with offline cache hits; the claude adapter reproduces the verified `draht-claude/cli.mjs` registration call sequence against a recording stub `claude` (validate → marketplace add → marketplace update → [force: uninstall] → install --scope user → enable) with every staged file manifest-tracked, and uninstall verifies host deregistration before local deletion; same for codex (marketplace add → [force: remove] → add); the global-cli adapter delegates to a stub package manager, records the delegation, and reports honest failure; detection distinguishes claude/codex presence, the legacy `~/.draht/.git` clone, the `~/.local/bin/draht` wrapper, and `~/.pi` legacy state on fixture homes; no test touches the live registry.

## Phase 50: CLI Surface & Contracts — `pending`
**Goal:** Bins `draht-install` and `draht-init` (single entry, basename dispatch) expose plan/install/status/doctor/update/uninstall with the locked flag set, stable `--json` schemas, non-interactive rules, exit codes, and the doctor catalogue; `draht-init` ensures components then scaffolds `.planning/` by subprocess-invoking the bundled `draht-tools` bin and hands off to the agent.
**Requirements:** R50-CLI.1, R50-CLI.2, R50-CLI.3, R50-CLI.4, R50-CLI.5, R50-CLI.6, R50-CLI.7, R50-CLI.8
**Acceptance:** Every verb runs against a fixture HOME via `DRAHT_INSTALL_DIR` in CLI integration tests; `--json` outputs validate against checked-in schemas (`schemaVersion` present) and `install --json` emits NDJSON events; mutating verbs without a TTY and without `--yes` exit non-zero with guidance while plan/status/doctor never prompt; documented exit codes (0 ok, 1 error, 2 changes-pending on plan/`status --check`, 3 partial/blocked incl. `--fail-on-empty` empty-profile) gate a simulated CI run; the doctor catalogue implements the spec's v1 checks each with id/severity/repairable; `draht-init` on an empty fixture project produces the `.planning/` scaffold via `draht-tools` and prints the agent handoff, refusing to clobber an existing scaffold without `--force`; a guard test asserts no bin named `draht` exists in the package; help text disambiguates `draht install <source>` (extension manager) from `draht-install` (machine components).

## Phase 51: Release Integration, Docs & E2E — `pending`
**Goal:** The release pipeline stamps plugin manifests in lockstep (closing the live `2026.7.7-1` freeze) with a drift gate, CalVer becomes always-suffixed, `install.sh` gains the collision guard, docs tell the truth, and a hermetic end-to-end proves the full lifecycle byte-clean.
**Requirements:** R51-SHIP.1, R51-SHIP.2, R51-SHIP.3, R51-SHIP.4, R51-SHIP.5
**Acceptance:** A shared stamping module is called by both `release.mjs` and `sync-versions.js`, both plugin manifests read the lockstep version, and `check-draht-customizations.mjs` fails on manifest/package version drift; `computeVersion` emits only `YYYY.M.D-N` (first-of-day `-1`) with the transition edge pinned by test; `install.sh` refuses a non-empty non-git `~/.draht` with actionable guidance; engine/plugin READMEs and `docs/releasing.md` reflect reality and CHANGELOGs carry the entries; an e2e test packs `@draht/install`, installs from the tarball into a sandbox HOME with stub `claude`/`codex`, and drives plan→install→status (clean)→injected drift→doctor→uninstall to a byte-clean home with zero live-registry access.

## Phase 52: Publish, Launchers & Bootstrap — `pending`
**Goal:** The product goes public: unscoped launcher packages ship, the registry is cleaned up, `install.sh` becomes a thin npx bootstrap, and the live catalog is verified — everything that requires npm/GitHub write access, gated on the §6 branch-family reconciliation.
**Requirements:** R52-PUB.1, R52-PUB.2, R52-PUB.3, R52-PUB.4, R52-PUB.5
**Acceptance:** Unscoped `draht-install`/`draht-init`/`create-draht` launchers (bin stub + docs only, `workspace:*`-pinned to `@draht/install`) publish through the lockstep pipeline with `npm pack` content assertions; `check-draht-customizations.mjs` enforces the structural duplicate-bin rule; `install.sh` execs `npx draht-install@latest` with no clone/reset/rc-append; the frozen `@draht/coding-agent@next` dist-tag is remediated and the unscoped names are claimed; a post-publish smoke (`npx draht-install@latest plan` in a clean container) and a live `skills add draht-dev/draht --list` catalog check pass; the `fix/final-*`/`fix/review-*` branch family is reconciled before any of this executes.
