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

### R23-API: Invoice/Compliance Tests
- R23-API.1: Lexoffice mock integration test (CRUD operations)
- R23-API.2: Toggl mock integration test (time entry import)
- R23-API.3: PII scanner accuracy test with German corpus
- R23-API.4: EU AI Act template validation against sample documentation

### R24-CI: CI Pipeline
- R24-CI.1: GitHub Actions PR check workflow (lint + test on push)
- R24-CI.2: AI review dogfooding on draht-mono PRs

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
