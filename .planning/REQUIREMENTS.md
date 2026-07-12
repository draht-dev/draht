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

> Source: `.planning/specs/geist-spec.md` (rev 7, locked). Harness-agnostic spatial ADE for Quest 3, built as an ACP client — see spec for full rationale, rejected alternatives, and locked decisions (§5, §17).
> Every phase from R32-M0 on distinguishes automated ✅ e2e requirements (CI-checkable against a mock ACP agent) from H-gate requirements (human/hardware evidence on Oskar's Quest 3 — never auto-certifiable by a GSD loop).

### R31-FOUND: Geist Foundation & Repo Scaffold
- R31-FOUND.1: Repo layout — `packages/geist/`, `geist-core/`, `geist-acp/`, `draht-acp/`, `geist-protocol/`, `geist-picker/`, `geist-console/` created as npm workspaces (spec §8)
- R31-FOUND.2: `quest/` Kotlin project skeleton created and explicitly excluded from npm workspaces (spec §8)
- R31-FOUND.3: `geist.yaml` config contract (spec §9.1: `harness.default`, `harness.agents` launch specs) implemented as a zod schema in `geist-protocol`, with a passing `geist.yaml.example`
- R31-FOUND.4: Import boundary enforced — `scripts/check-geist-boundary.mjs` fails root `check` if `geist-core`/`geist-acp`/`geist-console`/`quest` import `@draht/*` (only `draht-acp` may); this is the code-level enforcement of spec §17.1
- R31-FOUND.5: `scripts/check-geist-mirrors.mjs` scaffolded per spec §6's tooling row, wired into root `check`
- R31-FOUND.6: `docs/geist/spec.md` and `.planning/geist/README.md` created per the locked repo layout (spec §8)

### R32-M0: Spike — Panel + Ray
- R32-M0.1: Kotlin Spatial SDK panel scaffold in `quest/` renders a passthrough panel (structural; build/run verification deferred — no Quest hardware/Meta SDK Maven access in this sandbox)
- R32-M0.2: Ray-cast addressee resolution stubbed (ray→plane fallback) per spec §7 quest/ responsibilities
- R32-M0.3: Panel-alpha probe implemented — both room-glass and opaque-smoke-fallback code paths present (spec §13, §17.6)
- R32-M0.4: H0 (hover-coords evidence) recorded as evidence debt pending physical Quest 3 access

### R33-M1: Pairing + Voice Wire
- R33-M1.1: WS pairing handshake (LAN, token) between bridge and headset, survives reconnect (spec §6 "Sessions & worktrees" row is unrelated — this is the M1 pairing wire specifically)
- R33-M1.2: `geist-console` ships from `tokens.css` (geist-glass) at first pixel — no unstyled/restyle-later state
- R33-M1.3: whisper.cpp turbo/small wired for DE/EN transcription
- R33-M1.4: H1 (9/10 live transcripts; pairing survives restart) recorded as evidence debt

### R34-M2: Context Pack
- R34-M2.1: `ElementContext` composition (spec §9.3, unchanged from r2) implemented in `geist-core`
- R34-M2.2: Image content block attached only when capability-advertised; crop path-reference (`<wt>/.geist/task-<id>/target.webp`) always written and referenced
- R34-M2.3: H2 (chip + crop demo) recorded as evidence debt

### R35-M3: ACP Loop Closes
- R35-M3.1: `geist-acp` `HarnessSession` port + ACP client (JSON-RPC 2.0, stdio subprocess per session, capability handshake)
- R35-M3.2: In-repo deterministic mock ACP agent for e2e tests
- R35-M3.3: `draht-acp` shim implementing ACP over draht, with a keyless faux provider for CI
- R35-M3.4: `claude-agent-acp` launch spec pinned from the ACP registry; `smoke:harness -- claude` test (network, non-CI)
- R35-M3.5: Permission requests — `permission_request`/`permission_answer` WS messages, chip rendering, voice allow/deny mapped to the closest offered option
- R35-M3.6: Sha ledger — `baseSha`/`lastApprovedSha`, approve/undo = `reset --hard <ref>`
- R35-M3.7: H3 (fr3n button change end-to-end on both harnesses; one permission answered by voice) recorded as evidence debt

### R36-M4: Commands, Addressing, Project & Harness Grammar
- R36-M4.1: ACP-advertised commands/modes surfaced as palette + voice options; verbatim `/…` pass-through always available
- R36-M4.2: Harness qualifier grammar (closed vocab = configured agents) per spec §9.5 resolution order
- R36-M4.3: Project qualifier resolution (registry = yaml ∪ workspaceRoots ∪ recents)
- R36-M4.4: H4 (voice-spawn two harnesses in two projects; disambiguation chips by re-say) recorded as evidence debt

### R37-M5: Fleet Across Projects & Harnesses
- R37-M5.1: Mixed-harness fleet cards with capability badges
- R37-M5.2: ≤4 sessions across projects and harnesses, scoped approve/undo/stop
- R37-M5.3: H5 (two harnesses simultaneous, point-routed, 72 Hz with 3 panels + tier-1 glass) recorded as evidence debt

### R38-M6: Variants, Optionally Mixed
- R38-M6.1: `variants_new` WS message supports optional `harnesses: [name]` round-robin across configured agents
- R38-M6.2: H6 (3-way shoot-out, winner by pointing) recorded as evidence debt

### R39-M7: Run Rendering
- R39-M7.1: Generic ACP tool-call/plan-update → live lanes for every harness
- R39-M7.2: `subagent-recognizer.ts` — data-driven, golden-tested typed-lane upgrade for draht/Claude-Task-style calls
- R39-M7.3: H7 (real draht `/orchestrate` lanes; untyped Claude lanes) recorded as evidence debt

### R40-M8: Spatial Dividends (v1.5)
- R40-M8.1: H8 (two-viewport fix; workspace pose restores after restart) recorded as evidence debt — entirely hardware-gated, no automated ✅ criterion

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
