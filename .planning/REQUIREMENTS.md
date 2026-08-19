# Requirements

## v1 (Must Have)

### R1: Rebrand to @draht/ namespace
- R1.1: Update all package.json names from `@mariozechner/pi-*` to `@draht/*`
- R1.2: Update internal cross-package imports/references
- R1.3: Update README.md with Draht branding, keep fork attribution
- R1.4: Update AGENTS.md, CONTRIBUTING.md references
- R1.5: Update LICENSE to add Draht copyright while keeping original MIT

### R2: SST v4 Infrastructure Package
- R2.1: Create `packages/infra/` with package.json (@draht/infra)
- R2.2: SST v4 config (sst.config.ts) with AWS provider
- R2.3: Lambda function resources
- R2.4: API Gateway (HTTP API) resource
- R2.5: DynamoDB table resources (sessions, clients)
- R2.6: TypeScript IaC following SST v4 patterns

### R3: SST Resource Manager Extension
- R3.1: Extension that registers tools for querying SST resource state
- R3.2: Tool: `sst_status` — show deployed stack status (reads .sst/ metadata, NOT deploy)
- R3.3: Tool: `sst_resources` — list defined resources from sst.config.ts
- R3.4: Follows Pi Agent extension factory pattern

### R4: AGENTS.md Template Library
- R4.1: Create `packages/templates/` with package.json (@draht/templates)
- R4.2: SST/TypeScript AGENTS.md template
- R4.3: Astro AGENTS.md template
- R4.4: Go/gRPC AGENTS.md template
- R4.5: Each template includes project rules, conventions, tool usage

### R5: Monorepo Workspace Config
- R5.1: Add new packages to root workspaces array
- R5.2: Update build scripts to include new packages
- R5.3: Ensure `npm install` resolves cleanly

### R5-KB: Client Knowledge Base Extension
- R5-KB.1: Create `packages/knowledge/` with package.json (@draht/knowledge)
- R5-KB.2: Zvec integration for local vector DB operations (index, search, update)
- R5-KB.3: Per-client knowledge store (AGENTS.md, decisions, patterns) with namespace isolation
- R5-KB.4: Coding agent extension that auto-loads client context on session_start
- R5-KB.5: CLI commands for knowledge management (index, search, forget)

### R6-CI: CI/CD AI Review Pipeline
- R6-CI.1: Create `packages/ci/` with package.json (@draht/ci)
- R6-CI.2: GitHub Action YAML (action.yml) with inputs for model, AGENTS.md path, severity threshold
- R6-CI.3: TypeScript action that fetches PR diff, sends to Claude with AGENTS.md context
- R6-CI.4: Posts inline review comments, blocks merge on critical findings via check status

### R7-MA: Multi-Agent Orchestration
- R7-MA.1: Create `packages/orchestrator/` with package.json (@draht/orchestrator)
- R7-MA.2: GSD Controller pattern: task → plan → spawn sub-agents → synthesize results
- R7-MA.3: Ticket Decomposer: break tickets into agent-sized sub-tasks with dependency graph
- R7-MA.4: Sub-agent coordination with result synthesis and failure handling

### R8-WF: n8n Client Workflows
- R8-WF.1: Create `packages/workflows/` with package.json (@draht/workflows)
- R8-WF.2: Client onboarding workflow (form → repo → Notion → AGENTS.md → invoice)
- R8-WF.3: Daily AI standup workflow (git commits → summarize → post to channel)
- R8-WF.4: Invoice + time tracking workflow template

### R9-DG: Deploy Guardian Extension
- R9-DG.1: Coding agent extension for pre-deployment safety checks
- R9-DG.2: Lighthouse + load testing integration (run checks, report results)
- R9-DG.3: Rollback automation (detect failure → rollback to last known good)
- R9-DG.4: SST-specific safety (never auto-deploy, always verify, check resource drift)

## v2 (Nice to Have)
- DACH compliance module (Datenschutz, EU AI Act)
- Draht CLI wrapper around pi coding-agent
- draht.dev website

## Out of Scope
- Deploying any AWS resources
- Modifying Pi Agent core logic (ai, agent, tui packages internals)
- Custom LLM providers

---

## Milestone 2

> Requirements carried forward from Milestone 1 (incomplete):
> - R14-TDD.1: task template test→action→refactor — carried to Phase 19
> - R14-TDD.2: commit-task warns on missing tests — carried to Phase 19
> - R14-TDD.3: post-task hook runs tests — carried to Phase 19
> - R14-TDD.4: quality gate coverage threshold — carried to Phase 20
> - R14-TDD.7: coding-agent TDD mode — carried to Phase 19
> - R15-DDD.3: create-domain-model command — carried to Phase 19
> - R15-DDD.4: map-codebase domain extraction — carried to Phase 19
> - R15-DDD.5: knowledge base domain glossary — carried to Phase 20
> - R15-DDD.6: CI domain naming checks — carried to Phase 20

### R19-GSD: GSD CLI Integration
- R19-GSD.1: Move draht-tools shell scripts to TypeScript modules in coding-agent
- R19-GSD.2: gsd-commands extension uses real draht functions (not shell stubs)
- R19-GSD.3: Enhanced hooks wired into /execute and /verify flows

### R20-HOOK: Hook Hardening
- R20-HOOK.1: Toolchain auto-detection (npm/bun/pnpm) for test runner
- R20-HOOK.2: Configurable coverage threshold via `.planning/config.json`
- R20-HOOK.3: Configurable TDD cycle check (strict/advisory mode)

### R21-INT: GSD Integration Tests
- R21-INT.1: Full lifecycle test (create-project → commit-task → verify-phase)
- R21-INT.2: map-codebase test produces valid domain extraction
- R21-INT.3: Quality gate pass/fail test covers both outcomes
- R21-INT.4: gsd-commands extension loading test confirms registration

### R22-RTR: Router Hardening
- R22-RTR.1: Fallback chain integration test with simulated provider failures
- R22-RTR.2: Cost tracking accuracy test (within 1% tolerance)
- R22-RTR.3: Config validation rejects invalid schemas with clear errors

### R23-MA: Multi-Agent Layer
- R23-MA.1: FSM protocol for agent lifecycle coordination (IDLE, REQUEST, WORKING, WAIT, RESPOND)
- R23-MA.2: Teammate mailbox system — pub/sub inter-agent messaging, typed messages (TaskRequest, TaskResult, DataExchange, Abort)
- R23-MA.3: Autonomous task board with self-assign and atomic locking
- R23-MA.4: Worktree isolator — git worktree per task, merge-back with conflict detection
- R23-MA.5: Permission gate — YAML-rule-based deny/allow/approve tiers for tool execution
- R23-MA.6: Integration — wire FSM/mailbox/task-board/worktree/permission-gate into subagent.ts builtin

### R24-API: Invoice/Compliance Tests
- R24-API.1: Lexoffice mock integration test (CRUD operations)
- R24-API.2: Toggl mock integration test (time entry import)
- R24-API.3: PII scanner accuracy test with German corpus
- R24-API.4: EU AI Act template validation against sample documentation

### R25-CI: CI Pipeline
- R25-CI.1: GitHub Actions PR check workflow (lint + test on push)
- R25-CI.2: AI review dogfooding on draht-mono PRs

### R25-DOC: Artifact Cleanup
- R25-DOC.1: Backfill empty Phase 14-18 summaries with real data
- R25-DOC.2: Consolidate hook files to single source of truth

---

## Milestone 3 — Recursive Language Models

> Reference: Zhang, Kraska, Khattab (2026), *Recursive Language Models*, arXiv:2512.24601.
> Scope: inference-time scaffold; no RLM-native finetuning in v1.

### R26-RLM: RLM Core Primitives
- R26-RLM.1: New package `packages/rlm/` published as `@draht/rlm`
- R26-RLM.2: Python-subprocess REPL executor with persistent variables across steps
- R26-RLM.3: `RlmSession` class: `init(prompt)`, `step()`, `run()`, typed `RlmResult`
- R26-RLM.4: Root loop — root-LLM → parse ```repl Python block → execute → truncated stdout → history metadata → FINAL check
- R26-RLM.5: `llm_query(prompt: str) -> str` available inside REPL, routes through `@draht/router`
- R26-RLM.6: `FINAL(answer)` and `FINAL_VAR(var_name)` sentinel parsing with brittleness safeguards (reject when wrapped in code blocks, warn on ambiguous usage)
- R26-RLM.7: Constant-size metadata injection (context length, chunk lengths, short prefix) — full context never enters root LM history

### R27-SLM: Sub-LLM Integration & System Prompts
- R27-SLM.1: Three tuned system-prompt templates (frontier, coder-mid, small-context) mirroring paper Appendix C.1
- R27-SLM.2: Prompt templating substitutes `context_type`, `context_total_length`, `chunk_lengths`, `max_sub_call_budget`, `sub_call_char_budget`
- R27-SLM.3: Router roles `rlm-root` and `rlm-sub` with independent fallback chains
- R27-SLM.4: Per-model config block: `context_window`, `max_sub_calls`, `sub_call_char_budget`, auto-selected template
- R27-SLM.5: Batching advisory injected into prompt (avoid 1000× single-item sub-calls; aim for batched ~10–15k char chunks)

### R28-SBX: REPL Sandbox & Safety
- R28-SBX.1: Sandboxed Python child process — no network, no fs outside session workdir, no arbitrary imports of `os`/`subprocess`/`socket` except allowed stdlib (`re`, `json`, `math`, `itertools`, `collections`, `statistics`)
- R28-SBX.2: Per-step CPU timeout (default 30s) and memory ceiling (default 256 MB); hard-kill on breach
- R28-SBX.3: Session-wide budgets: `max_iterations` (default 24), `max_sub_calls` (default 100), `max_total_cost_usd` (configurable)
- R28-SBX.4: Stdout cap per step (default 2 KB) with explicit `[truncated N chars]` marker; stderr streamed at same cap
- R28-SBX.5: REPL state persistence via the child process lifetime (exec, don't relaunch) with snapshot/rollback on exception
- R28-SBX.6: Typed stop reasons: `final` | `final_var` | `max_iterations` | `budget_exhausted` | `timeout` | `sandbox_violation` | `error`

### R29-INT: Draht Agent & CLI Integration
- R29-INT.1: Extension package `packages/rlm-agent/` registers `/rlm <input> <query>` in coding-agent
- R29-INT.2: `rlm_query` tool exposed to other agent flows (lets a normal agent defer oversize context reads)
- R29-INT.3: CLI `draht rlm --input <path|glob|url> --query "..." [--max-cost 1.00]` with file, directory-glob, and HTTP(S) loaders
- R29-INT.4: `@draht/knowledge` loader: seed RLM context from a named client knowledge base
- R29-INT.5: GSD integration — plans may declare `rlm: true`; `/execute-phase` routes inputs over threshold through RLM instead of feeding them directly to the root agent

### R30-EVAL: Evaluation, Observability & Docs
- R30-EVAL.1: Trajectory JSONL per session (`step`, `code`, `stdout_truncated`, `sub_calls[]`, `cost_usd`, `final`) written to `.draht/rlm/<session-id>.jsonl`
- R30-EVAL.2: S-NIAH regression suite — synthetic needle-in-haystack fixtures at 10×, 100× root window, with asserted recall
- R30-EVAL.3: Cost-comparison harness: RLM vs `router` baseline (truncate + single call) on the same task, written to eval report
- R30-EVAL.4: `draht rlm replay <session-id>` reconstructs final answer from the trajectory log without re-invoking any LLM
- R30-EVAL.5: README + AGENTS.md sections — when to prefer RLM, cost envelope, worked example end-to-end

---

## Milestone 4 — geist

> Source: `.planning/specs/geist-spec.md` (rev 7, locked), subject to the explicit security/spec amendments required by `.planning/geist/SECURITY-2026-07-13.md`. Harness-agnostic spatial ADE for Quest 3, built as an ACP client.
> Evidence is phase-appropriate: host behavior uses emitted-binary/public-protocol tests against real mock subprocesses; UI uses browser automation; Quest behavior uses Android unit/instrumentation/build evidence; H0–H8 use archived physical Quest 3 evidence. Recording absent evidence as debt satisfies nothing.
> **Audit correction (2026-07-13):** R31-FOUND through R39-M7 are reopened and R40-M8 is not started. These bullets describe target behavior, not current implementation. See `.planning/geist/AUDIT-2026-07-13.md`.

### R31-FOUND: Geist Foundation & Repo Scaffold
- R31-FOUND.1: Repo layout — `packages/geist/`, `geist-core/`, `geist-acp/`, `draht-acp/`, `geist-protocol/`, `geist-picker/`, `geist-console/` created as npm workspaces (spec §8)
- R31-FOUND.2: `quest/` Kotlin project skeleton created and explicitly excluded from npm workspaces (spec §8)
- R31-FOUND.3: `geist.yaml` config contract implemented as a zod schema in `geist-protocol`, with a passing `geist.yaml.example`
- R31-FOUND.4: Import boundary enforced — `packages/geist`, `geist-core`, `geist-acp`, `geist-protocol`, `geist-picker`, and `geist-console` may import only non-privileged Geist-family packages; none may import `@draht/draht-acp` or Draht kernel/business packages; `quest/` may import no `@draht/*`; only `packages/draht-acp` may import the Draht kernel
- R31-FOUND.5: `scripts/check-geist-mirrors.mjs` scaffolded per spec §6's tooling row and wired into root `check`
- R31-FOUND.6: `docs/geist/spec.md` and `.planning/geist/README.md` created per the locked repo layout (spec §8)
- R31-FOUND.7: Boundary mutation tests prove imports of both `@draht/coding-agent` and `@draht/draht-acp` fail independently from `packages/geist`, `geist-core`, `geist-acp`, `geist-protocol`, `geist-picker`, and `geist-console`; a separate mutation proves every `@draht/*` reference fails under `quest/`

### R32-M0: Spike — Panel + Ray
- R32-M0.1: Kotlin app in `quest/` uses a pinned Meta Spatial SDK and renders a real URL/passthrough panel on Quest 3
- R32-M0.2: Ray-cast addressee resolution is unit-tested and wired to real controller/hand input at PTT press
- R32-M0.3: Panel-alpha probe is executable — both room-glass and opaque-smoke-fallback materials are SDK-bound and selectable
- R32-M0.4: H0 archives hover-coordinate and alpha-probe evidence with commit, APK, headset/OS, and Spatial SDK identifiers

### R33-M1: Pairing + Voice Wire
- R33-M1.1: WS pairing between the production bridge and Kotlin headset client survives Quest app recreation and performs authoritative state resynchronization
- R33-M1.2: `geist-console` is served by the bridge from `tokens.css` at first pixel, with no unstyled state
- R33-M1.3: PTT `AudioRecord` reaches whisper.cpp turbo/small and transcribes fixed DE/EN fixtures
- R33-M1.4: H1 archives ten live headset transcripts with a defined DE/EN split, at least nine normalized transcript matches, latency data, and pairing restart/reconnect evidence
- R33-M1.5: The emitted `geist` binary reads/validates config, owns HTTP/WS lifecycle, serves `/ui` and health, launches one named mock ACP session in an approved worktree, and accepts one public-protocol text/voice dispatch
- R33-M1.6: Every headset-visible protocol schema has a Kotlin serialization mirror; the drift gate detects omitted schemas plus field/type changes
- R33-M1.7: GSEC-04, GSEC-08, and GSEC-12 are closed before the production bridge accepts headset connections

### R34-M2: Context Pack
- R34-M2.1: A real injected picker IIFE tracks/freeze-selects an element and emits `ElementContext` through the public protocol
- R34-M2.2: A decodable crop is always written to `<wt>/.geist/task-<id>/target.webp`; image-capable sessions receive bytes and every session receives a usable path reference
- R34-M2.3: H2 archives the physical target-ring, crop-chip, and written-crop dispatch demo

### R35-M3: ACP Loop Closes
- R35-M3.1: `geist-acp` `HarnessSession` port + ACP client provides bounded stdio lifecycle and capability handshake
- R35-M3.2: In-repo deterministic mock ACP agent supports product-level e2e tests
- R35-M3.3: `draht-acp` implements ACP over Draht with a keyless faux provider for CI
- R35-M3.4: The Claude adapter is exactly pinned; an explicitly invoked real-harness smoke fails rather than skips when prerequisites are missing
- R35-M3.5: Permission requests render operation-bound option chips; tap/voice allow/deny resolves only an offered option for the addressed pending request and survives reconnect
- R35-M3.6: Approval/undo follows the durable full-state managed-worktree amendment required by GSEC-05; approval survives restart and transactional restore preserves recoverability
- R35-M3.7: H3 archives the fr3n button change on both Draht and Claude plus one permission answered by voice
- R35-M3.8: One emitted-binary/public-protocol e2e covers config → worktree/session spawn → dispatch → tools/plans → deny/allow → edit → review → approve → second edit → undo → stop/cleanup, and passes against mock ACP and keyless `draht-acp`
- R35-M3.9: GSEC-01, GSEC-02, GSEC-03, GSEC-05, GSEC-06, GSEC-07, GSEC-09, GSEC-10, GSEC-11, and GSEC-13 are closed with their required regressions

### R36-M4: Commands, Addressing, Project & Harness Grammar
- R36-M4.1: Live ACP commands and complete mode state cross the protocol and render as palette + voice options; verbatim `/…` pass-through remains available
- R36-M4.2: Reserved verb → command → harness → project → text precedence is enforced against configured vocabularies
- R36-M4.3: Project resolution uses validated yaml ∪ workspaceRoots ∪ persisted recents with canonical approved roots
- R36-M4.4: H4 archives voice-spawning Draht `/plan` and Claude sessions in two projects plus re-say disambiguation
- R36-M4.5: Public typed/transcribed `session_new` launches the named configured harness in the exact resolved worktree; collision/ambiguity produces visible disambiguation instead of silent fallback

### R37-M5: Fleet Across Projects & Harnesses
- R37-M5.1: Mixed-harness fleet cards render project, harness, status, and capability badges from live `fleet_state`
- R37-M5.2: At most four real sessions span distinct managed worktrees; approve/undo/stop and capacity errors are scoped by session
- R37-M5.3: H5 archives Draht + Claude across two projects, point routing, three live panels, and a 72 Hz tier-1-glass OVR run
- R37-M5.4: Three real spawned mock ACP sessions across two profiles/two repos emit public WS state and render in browser automation; byte/process isolation regressions pass

### R38-M6: Variants, Optionally Mixed
- R38-M6.1: `variants_new` validates configured harnesses/capacity and round-robins optional harness names
- R38-M6.2: H6 archives the physical three-way mixed-harness shoot-out and pointing winner selection
- R38-M6.3: A public request creates sibling worktrees/processes, dispatches one prompt, renders the compare row, and transactionally keeps the selected winner while stopping/removing every sibling process/worktree and its tracked/untracked output

### R39-M7: Run Rendering
- R39-M7.1: Real ACP tool/plan updates flow through production state/protocol into live generic/plan lanes
- R39-M7.2: `subagent-recognizer.ts` remains data-driven and golden-tested for typed Draht/Claude-Task-style lanes
- R39-M7.3: H7 archives real typed Draht `/orchestrate` lanes and untyped Claude tool lanes
- R39-M7.4: Browser automation proves lane updates, LOOP.md initial/refresh behavior, and a public scoped stop command that cancels an in-flight run with no late events

### R40-M8: Spatial Dividends (v1.5)
- R40-M8.1: Multi-viewport layout, pins/history, spatial anchors, and workspace pose serialization/restoration are implemented with recreation and migration tests
- R40-M8.2: H8 archives before/after pose data plus the physical two-viewport and headset-restart restoration demo

---

## Milestone 5 — Rewind & Checkpoints

> Design spec: `.planning/specs/2026-07-12-rewind-checkpoint-design.md`.
> Scope: first-class in `packages/coding-agent` (core + interactive mode + `core/builtins/`); no new package. Supersedes the example extension `examples/extensions/git-checkpoint.ts`.

### R41-CKP: Checkpoint Capture & Storage
- R41-CKP.1: `CheckpointManager` in `packages/coding-agent/src/core/checkpoints/` — capture, lookup, prune; snapshots built via temporary index (`GIT_INDEX_FILE`) + `write-tree` + `commit-tree`; never touches the user's index, `HEAD`, stash, or reflog; no `git stash` anywhere
- R41-CKP.2: Snapshots include untracked-but-not-ignored files; `.gitignore`d files are never captured
- R41-CKP.3: Snapshot commits anchored at `refs/draht/checkpoints/<session-id>/<entry-id>` (GC-proof, namespaced per session)
- R41-CKP.4: Capture at `turn_start`, keyed to the session leaf entry id at that moment; skipped when the tree hash equals the previous checkpoint's (dedup)
- R41-CKP.5: Metadata sidecar `<session-file>.checkpoints.jsonl` (entryId, ref, treeHash, timestamp, dirty-file count); records for preserved entry ids copied on `/fork` and `/clone`
- R41-CKP.6: Non-git cwd: capture disabled with a one-time notice, no errors; session continues normally
- R41-CKP.7: Wired as an always-loaded core builtin (`core/builtins/`), with real-session loading proof; `draht checkpoint prune` CLI + age/count retention policy via settings (default 30 days)

### R42-RWD: Rewind Command & Restore
- R42-RWD.1: `/rewind` command + `app.session.rewind` keybinding action; selector reuses the tree-selector filtered to checkpointed user messages, annotated with checkpoint timestamp and dirty-file count
- R42-RWD.2: Restore scope menu: conversation + files (default) / conversation only / files only
- R42-RWD.3: Pre-rewind safety snapshot always captured and anchored before any file mutation; any restore failure rolls the tree back to it
- R42-RWD.4: File restore is diff-driven between safety snapshot and target snapshot: only differing paths are checked out, paths absent in the target are deleted, ignored files are never touched (no `stash apply`, no blanket `checkout -- .`)
- R42-RWD.5: Atomic ordering: safety snapshot → file restore → `navigateTree()`; the conversation leaf moves only after file restore succeeds
- R42-RWD.6: Redo/rewind-forward: abandoned branches keep their checkpoints; rewinding to an entry on an abandoned branch restores that state
- R42-RWD.7: `/tree` navigation and `/fork` offer file restore when the target entry has a checkpoint (integrated via the `session_before_tree` / `session_before_fork` seams), and honor decline
- R42-RWD.8: Extension surface: `pi.checkpoints` (list/get/restore) on `ExtensionAPI`; events `checkpoint_created` and cancelable `session_before_rewind`

### R43-SFT: Rewind Safety, Fallbacks, Tests & Docs
- R43-SFT.1: Failure-injection tests — process killed or git failing mid-restore leaves the working tree equal to the target or the safety snapshot; if rollback also fails, both anchored refs are reported (nothing unrecoverable)
- R43-SFT.2: Filesystem semantics test matrix — untracked files, files created after the checkpoint (removed on rewind), ignored files (never touched), staged/unstaged split (documented: worktree content wins, user index untouched), symlinks, file-mode changes
- R43-SFT.3: Concurrency test — two sessions in the same repo cannot corrupt each other (per-session ref namespaces, per-operation temp index)
- R43-SFT.4: Non-interactive/RPC mode never restores files without an explicit option; conversation-only fallback covered by tests
- R43-SFT.5: Settings — enable/disable capture, retention policy, per-file size guard for large untracked files (warn + skip above configurable threshold)
- R43-SFT.6: Docs — `session-format.md` sidecar section, `extensions.md` new events, `quickstart.md` rollback note replaced with `/rewind`, `examples/extensions/git-checkpoint.ts` marked superseded with pointer to the built-in
- R43-SFT.7: Performance budget enforced by test on the medium fixture repo — capture p95 < 200 ms warm, dedup fast-path < 50 ms

---

## Milestone 6 — Bash Sandbox Confinement

> Design spec: `.planning/specs/2026-07-12-bash-sandbox-confinement.md`.
> Scope: `packages/coding-agent` (core + interactive mode + `core/builtins/`); no new package. Generalizes Phase 28's OS-boundary pattern (`packages/rlm/src/sandbox.ts`) from the RLM REPL to the agent's bash tool, composing with (not replacing) the permission gate and its default/auto/yolo modes.

### R44-SBX: Sandbox Executor Core
- R44-SBX.1: `SandboxExecutor` interface in `packages/coding-agent/src/core/sandbox/` with per-platform backends — macOS Seatbelt (`sandbox-exec -f` + SBPL profile generated from policy), Linux Landlock (kernel ≥ 5.13) with `unshare`/bwrap namespace fallback; unsupported platforms report `unavailable`
- R44-SBX.2: `SandboxPolicy` v1 — filesystem write allowlist (project cwd, session scratch, OS temp, configurable `extraWritePaths` incl. curated default cache roots), read allow-all, single network on/off toggle (default on), no privilege escalation possible inside the sandbox
- R44-SBX.3: Policy paths real-path resolved before profile generation — a symlink inside the project pointing outside must not widen the writable set
- R44-SBX.4: Startup self-test (Phase 28 pattern): probe write outside the allowlist (and loopback connect when network-off) inside a throwaway sandbox; only a passing self-test lets the backend report `available`; a broken profile degrades to `unavailable`, never to unconfined execution
- R44-SBX.5: Environment hygiene — the sandboxed child receives a constructed env, not the full parent env
- R44-SBX.6: Delivered as a `BashOperations` implementation wrapping the existing local backend (`src/core/tools/bash.ts` seam); existing bash tool behavior byte-identical when sandboxing is off

### R45-SBM: Permission Integration & Escalation UX
- R45-SBM.1: Session sandbox state (`on`/`off`) alongside `PermissionMode` — `/sandbox` command, settings key + `DRAHT_SANDBOX` env seeding, status-bar indicator
- R45-SBM.2: Sandbox-on auto-mode semantics — unmatched bash auto-allowed because confined; inline-interpreter-eval danger patterns stop prompting; outward-facing patterns (`git push*`, publish) keep prompting; `permissions.yml` `deny` rules still hard-block in every combination
- R45-SBM.3: Denial escalation — platform denial signature detected from the failed run produces exactly one "rerun unsandboxed?" approval via the existing confirm path; approve reruns through the unsandboxed backend and logs it; decline leaves the denial as the tool result
- R45-SBM.4: Non-interactive/RPC mode never escalates and never silently reruns unsandboxed — the denial is the result
- R45-SBM.5: Sandbox-unavailable falls back to current permission-gate behavior with a one-time notice; the gate's text heuristics are the floor, never regressed
- R45-SBM.6: Wired via `core/builtins/` with real-session loading proof (Phases 23/29 proof class)

### R46-SBH: Sandbox Hardening, Performance & Docs
- R46-SBH.1: Adversarial escape suite — symlink pivots created mid-command, `/tmp`-relocation tricks, interpreter matrix (python/node/ruby/perl × inline-eval/script-file), git-hook-triggered writes from an in-sandbox `git commit`, env probe proving no secret-bearing parent vars leak
- R46-SBH.2: Linux CI covers Landlock and the namespace fallback as separate matrix jobs (Phase 28's Linux path shipped unverified on the macOS dev machine — not repeating that)
- R46-SBH.3: Spawn-overhead budget enforced by test — added p95 < 50 ms per invocation
- R46-SBH.4: Dogfood proof — full `npm run check` + build of this monorepo completes inside the sandbox on the curated default allowlist alone
- R46-SBH.5: Docs — `extensions.md`, `quickstart.md` security section, permission-gate module doc updated to point at the sandbox as the hard boundary (text gate = heuristic UX in front of it)

---

## Milestone 7 — Unified Distribution

> Design spec: `.planning/specs/2026-08-12-unified-distribution-product.md` (adjudicated synthesis of the three 2026-08-11 plans in /srv/work/draht/draht-mono-plans/).
> Registry evidence as of 2026-08-11: unscoped `draht` is third-party (thenativeweb); `draht-install`, `draht-init`, `create-draht`, `@draht/install` unclaimed. New package: `packages/install/` (canonical `@draht/install`). No new bin named `draht`, `draht-tools`, `draht-claude`, or `draht-codex` anywhere in the milestone.
> Scope note: launcher packages, `next` channel, version pinning, repair/rollback verbs, config merge/overlay, update-notice pipeline, plugin-CLI shims, provenance metadata, signed catalog, scheduled updates are explicitly deferred (spec §7).

### R47-SKL: Canonical Skill Source & Generated Artifacts
- R47-SKL.1: Repo-root `skills/` canonical tree — 9 dialect-neutralized discipline skills, 17 workflow skills as `<cmd>/{SKILL.md, command.md}` with in-dir references only, and a new `draht` umbrella/router skill (~27 total), every SKILL.md spec-clean (frontmatter exactly `name`+`description`, name==dirname)
- R47-SKL.2: Generator `scripts/generate-skills-artifacts.mjs` renders Claude artifacts (17 commands + 10 skills) and Codex artifacts (17 commands + 27 skills incl. self-contained wrappers) from the canonical tree through a data-driven dialect table; the walk over `skills/` is dynamic — adding a canonical skill dir requires zero generator changes
- R47-SKL.3: Migration byte-safety — regenerated Claude commands and the 9 pre-existing Claude discipline skills are byte-identical to the pre-migration committed files; Codex content changes are exactly the intended wrapper self-containment fix; both packages gain only `skills/draht/`
- R47-SKL.4: Drift gate — `check:skills-artifacts` (regenerate + byte-compare, non-zero on drift) wired into root `npm run check` and both plugin packages' `prepublishOnly`; `check-plugin-mirrors.mjs` reduced to its agents/ byte-identity check
- R47-SKL.5: Native artifact tests — Agent Skills spec validation, portability lint (no `../` escapes, no absolute paths, no `${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_ROOT` tokens, host-dialect markers only in an explicit documented allowlist), ≤500-line size gate, generator determinism, dialect completeness, wrapper-standalone resolution
- R47-SKL.6: Catalog proof — a native implementation of the skills-CLI priority-walk semantics (root `skills/` short-circuit, first-found-wins name dedup) over this repository lists exactly the canonical skill set
- R47-SKL.7: README truth — both plugin READMEs list the real skill surface (10 disciplines + `draht` router) *(count corrected 2026-08-18: the canonical tree holds 28 skill dirs = 17 command skills + 10 disciplines + the `draht` router; `saga-spawner` was omitted from the old tally.)*

### R48-ENG: Install Engine Core
- R48-ENG.1: New workspace package `packages/install/` publishing `@draht/install` (private:false, `files` allowlist, lockstep CalVer, vitest suite, `workspace:*` dependency on `@draht/tools` for the init scaffold), wired into the root `build` chain and green under `npm run check` and `check-draht-customizations`
- R48-ENG.2: Schema-versioned state manifest at `~/.draht/install/state.json` (`DRAHT_INSTALL_DIR` override): channel, profile, per-component version/source/integrity, per-file `{path, sha256}`, effectiveness; all writes temp-file + fsync + atomic rename, kill-proven
- R48-ENG.3: Append-only `journal.jsonl` (`planned → staged → backed-up → swapped → registered → committed | rolled-back`), fsync per record, torn-final-line-tolerant reader, open-transaction detection
- R48-ENG.4: Pure plan engine — desired (profile ∪ selectors, channel) vs actual (state + injected disk hashes) → ordered typed actions; deterministic; downgrades surface as typed `blocked` entries, never silent actions; removes only under explicit prune
- R48-ENG.5: Transactional executor — staging → journaled per-component backup → atomic rename swap (EXDEV copy fallback) → registration callback → verified commit; any failure restores the pre-apply tree byte-identically, journals `rolled-back`, and leaves `state.json` untouched; named checkpoints as the fault-injection seam
- R48-ENG.6: Idempotent convergence — re-planning after a successful apply yields zero actions, proven by hash-equal state and fs snapshots

### R49-SRC: Component Sources, Detection & Adapters
- R49-SRC.1: `RegistryClient` seam with an npm-registry implementation (packument fetch honoring `DRAHT_REGISTRY`, dist-tag resolution) and a hermetic fixture implementation; channel `latest` only — `next` refused with the honest frozen-tag message (registry `next: 2026.3.2-4` predates and is unreachable by the release pipeline)
- R49-SRC.2: Tarball acquisition verified against registry-served ssri integrity (`sha512-…`/`sha256-…`) into `~/.draht/install/cache/` keyed by integrity; cache hits satisfy plans offline; corrupted downloads rejected before any staging
- R49-SRC.3: `claude-plugin` adapter — stages the payload into the claude marketplace layout with full manifest tracking and drives the verified `cli.mjs` call sequence (validate → marketplace add → marketplace update → [force: uninstall] → `plugin install --scope user` → enable) against the host CLI; uninstall verifies host deregistration success before deleting local files (no allowFail-then-delete)
- R49-SRC.4: `codex-plugin` adapter — same contract for the codex marketplace and verb set (marketplace add → [force: remove] → add)
- R49-SRC.5: `global-cli` adapter (used by `coding-agent` and `installer` components) — delegated install via detected package manager, delegation recorded in state, symmetric uninstall, honest failure reporting
- R49-SRC.6: Detection module — harness CLIs on PATH, legacy curl-clone (`~/.draht/.git`), `~/.local/bin/draht` wrapper, `~/.pi` legacy state; typed findings consumed by plan and doctor
- R49-SRC.7: Component index as validated data (`components.json`: id, kind, npmName, provides, default-membership rules); adapters keyed by `kind`; unknown kinds fail closed only when selected; adding a package of a supported kind is a data-only change

### R50-CLI: CLI Surface & Contracts
- R50-CLI.1: Bins `draht-install` and `draht-init` from `@draht/install` (single entry, basename dispatch); no bin named `draht`/`draht-tools`/`draht-claude`/`draht-codex` (guard test)
- R50-CLI.2: Verbs `plan`, `install`, `status`, `doctor`, `update`, `uninstall` per the spec contracts; `install --dry-run` prints the plan and writes nothing; `update` = re-resolve + apply for installed components; `uninstall --purge` additionally removes the state root
- R50-CLI.3: Flags `--full`, `--agents`, `--skills`, `--coding-agent`, `--channel <latest>`, `--dry-run`, `--yes`, `--json`, `--fail-on-empty`; selector composition rules (selectors replace the default set; `--full`+selector errors); short flags only `-h/-y/-n`
- R50-CLI.4: `--json` single-document output with `schemaVersion` on plan/status/doctor/uninstall, NDJSON event stream on `install --json`; schemas checked into the package and snapshot-tested
- R50-CLI.5: Non-interactive discipline — mutating verbs require `--yes` without a TTY; read verbs never prompt; exit codes 0/1/2/3 as specified and test-pinned
- R50-CLI.6: `draht-init` — ensures required components (offering `install`), scaffolds `.planning/` by subprocess-invoking the `draht-tools` bin from the package's own dependency, prints the agent handoff, refuses to overwrite an existing scaffold without `--force`
- R50-CLI.7: Doctor catalogue with at minimum: node/npm environment, state/journal integrity, manifest drift, legacy curl-clone, wrapper/PATH shadowing, `~/.pi` legacy state, harness presence for installed components, crashed transactions, installed-payload manifest-version drift — each `{id, severity, message, repairable}`
- R50-CLI.8: Help text disambiguates `draht install <source>` (coding-agent extension manager) from `draht-install` (machine components)

### R51-SHIP: Release Integration, Docs & E2E
- R51-SHIP.1: Shared stamping module (`scripts/lib/version-stamp.mjs`) rewrites both plugin manifests; called by `release.mjs`'s version step and `sync-versions.js`; both manifests converged to the lockstep version; `check-draht-customizations.mjs` fails on manifest/package version drift
- R51-SHIP.2: Always-suffixed CalVer — `computeVersion` emits only `YYYY.M.D-N` (first release of a day `-1`); transition-day ordering edge documented and test-pinned; `--tag next` publishing remains explicitly deferred
- R51-SHIP.3: `install.sh` refuses a non-empty non-git `~/.draht` with a clear message and `DRAHT_DIR` guidance (the npx-bootstrap rewrite is publish-gated, R52-PUB.3)
- R51-SHIP.4: Docs truth — engine README, plugin README skill lists, `docs/releasing.md` reflecting the real CalVer/release process, CHANGELOG entries for touched packages
- R51-SHIP.5: Hermetic lifecycle e2e — pack `@draht/install`, install from the tarball into a sandbox HOME with stub `claude`/`codex` on PATH, drive plan→install→status→injected drift→doctor→uninstall to a byte-clean home; zero live-registry access under test

### R52-PUB: Publish, Launchers & Bootstrap (publish-gated)
- R52-PUB.1: Unscoped launcher packages `draht-install`, `draht-init`, `create-draht` (bin stub + README + LICENSE + CHANGELOG only), `workspace:*`-pinned to `@draht/install`, published by the lockstep pipeline with `npm pack` content assertions
- R52-PUB.2: `check-draht-customizations.mjs` structural duplicate-bin rule — a bin name may be declared by multiple workspace packages only when byte-synced (the `draht-tools` pair) or when every non-canonical declarer is a single-bin launcher exact-pinned to the `@draht/*` package declaring the same bin
- R52-PUB.3: `install.sh` rewritten as a thin bootstrap (node check → `exec npx draht-install@latest "$@"`), preserving the published URL; no clone, no `git reset --hard`, no shell-rc mutation
- R52-PUB.4: One-time registry hygiene — remediate the frozen `@draht/coding-agent@next` dist-tag; claim the unscoped launcher names
- R52-PUB.5: Post-publish verification — `npx draht-install@latest plan` smoke in a clean container; live `npx skills add draht-dev/draht --list` equals the canonical catalog; all gated on reconciling the `fix/final-*`/`fix/review-*` branch family first
