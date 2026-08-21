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

> **Supersession (2026-08-19):** `R32-M0` through `R40-M8` are retired wholesale and replaced by `R32-FLEET` through `R40-SPATIAL` below, per `.planning/specs/2026-08-18-geist-remote-control-rev8.md`. The retired ids remain referenced by ROADMAP history and `.planning/geist/AUDIT-2026-07-13.md` and are superseded, not lost. R31-FOUND is unchanged and complete.

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

### R32-FLEET: Fleet, Attach & One Served Surface
- R32-FLEET.1: Fleet projection and the socket↔WS attach bridge live in `packages/geist-core` and import zero `@draht/coding-agent` and zero kernel packages — they speak the socket wire and read `~/.draht/agent/sockets/` — so `check-geist-boundary.mjs` is green from the first commit and Phase 38 is a host swap, not a code move
- R32-FLEET.2: `GET /fleet` lists every live attachable draht session (id, cwd, pid, startedAt) from the `<id>.sock` + `.lock` contract with live-PID filtering and stale reaping; dead-PID entries never appear
- R32-FLEET.3: The attach WS bridges a session's Unix socket both ways, relaying output, input, `session_metadata`, `client_joined`/`client_left` and `input_echo` unchanged, behind the existing bearer auth; an unauthenticated attach is refused before the Unix socket is opened
- R32-FLEET.4: Every wire message is a zod schema exported from `geist-protocol` with a `hello`/`server_hello` handshake at `geist/0.x`; a `check:geist-protocol` gate fails when a wire type is declared elsewhere, when the daemon accepts a frame no exported schema validates, or when the schemas drift field-for-field from `coding-agent/src/core/socket-server/types.ts`
- R32-FLEET.5: A conformance corpus (≥1 golden per message type per direction, **generated by recording the running daemon**, not hand-authored) is committed, and the drift gate fails root `npm run check` on any change without a 0.x bump and a migration note — same pattern as the existing `check:skills-artifacts` gate
- R32-FLEET.6: Bounded transport — per-frame byte cap, per-client outbound queue cap, total buffered-output cap, backpressure in both directions; overflow is a typed `protocol_error` that disconnects only the offending client (GSEC-09 transport half)
- R32-FLEET.7: Concurrent-writer policy is decided and implemented — a prompt arriving while the agent streams is queued or refused with a client-visible reason, never surfaced to a phone as a vanished message (today `AgentSession.prompt()` rejects and `PROMPT_FAILED` reaches only the sender)
- R32-FLEET.8: `POST /sessions`'s caller-supplied `command: string[]` path is deleted from the emitted binary and `validateCommand` (`gateway/src/gateway/routes/sessions.ts:52`) removed; no code path reaches `Bun.spawn` with caller bytes until Phase 36's registry lands (GSEC-12 exposure removal)
- R32-FLEET.9: Exactly one process listener, loopback-enforced on the CLI flag, config file, programmatic surface and per request; `createPairingServer()`'s hostname-less `Bun.serve({ port })` (`packages/geist/src/pairing/server.ts:211`) is deleted or routed through `assertBindHostAllowed`, and a repo-wide gate fails on any hostname-less `Bun.serve` (GSEC-04 bind half)
- R32-FLEET.10: A decision record resolves spec §10 Q1 and Q2 — one daemon-served bundle serves desktop and mobile at two viewports and Adler is not the mobile renderer — and that bundle ships on `tokens.css` from its first pixel, listing sessions, streaming output and sending prompts, responsive from day one
- R32-FLEET.11: An in-repo keyless stub provider selectable by env var by the **spawned** `draht` binary, so every later phase's e2e drives real assistant output with no API key and no network (`registerFauxProvider` in `@draht/ai/compat` is in-process only and cannot serve a child process)
- R32-FLEET.12: A headless-browser harness is added to the repo and runs in CI — none exists today; `scripts/check-browser-smoke.mjs` is an esbuild bundle-shape check — because every renderer acceptance from Phase 32 onward is a DOM assertion

### R33-REACH: On the Phone — Exposure, Pairing, Device Credentials
- R33-REACH.1: A committed, re-runnable script publishes the loopback listener via `tailscale serve`, resolves MagicDNS, and drives the public HTTP + WS surface from a second tailnet node, failing loudly on cert/DNS/upgrade failure; Funnel is never invoked
- R33-REACH.2: Archived device evidence — iOS Safari and the Quest 3 browser each load the served bundle over `https://<magicdns>` and complete a WS upgrade — with pinned browser/OS versions, screenshots, console logs, and the measured WS idle timeout, sleep/wake and tailnet-drop behavior through the proxy, captured as the input to Phase 39
- R33-REACH.3: Authentication is first-message/header only; the `?token=` query fallback in `gateway/src/gateway/middleware/auth.ts` is removed and its removal regression-tested; no credential appears in any URL, query string, `Referer`, or log line (spec §6.4)
- R33-REACH.4: `geist pair` prints a QR and copyable deep link carrying the MagicDNS origin plus a single-use, short-TTL bootstrap token, with the origin derived from the live `tailscale serve` mapping rather than typed into config
- R33-REACH.5: The bootstrap token is exchanged on first connect for a rotated per-device credential bound to a device id, invalidated at exchange, and rotated on reconnect (GSEC-04 credential half)
- R33-REACH.6: Device credentials are individually enumerable and revocable (`geist devices list|revoke`); a revoked device is refused at its next frame, not merely at its next connect
- R33-REACH.7: Pairing is socket-scoped — an invalid, replayed or downgraded `pair` on a second socket cannot revoke, mutate or disturb an already-bound device (GSEC-08)
- R33-REACH.8: When the deployment declares itself tailnet-fronted, the tailnet identity header must match the configured owner; its absence never grants access and it is never the only check (spec §6.6)
- R33-REACH.9: The bundle reconnects with bounded backoff, restores the open session, shows an explicit disconnected state rather than a silently dead transcript, and its stored credential survives a tab/app restart with a defined eviction behavior — re-bootstrap, never a broken page
- R33-REACH.10: Mobile layout in the same bundle — viewport-fit, keyboard-safe composer, one session at a time, touch targets; `TAILSCALE_SETUP.md` is updated to the verified procedure and states which half of GSEC-04 this work closes, with no finding ID in any operator-facing refusal text

### R34-PERM: The Ask Reaches the Phone — Permission Relay
- R34-PERM.1: The attach wire gains out-of-band request/response frames (`id`, `method`, payload, deadline) modelled on `RpcExtensionUIRequest`/`RpcExtensionUIResponse`, multiplexed alongside the output stream and version-bumped in the 0.x corpus
- R34-PERM.2: `createExtensionUIContext()` (`modes/interactive/interactive-mode.ts:2190`, whose `confirm` delegates to `showExtensionSelector`) fans every request out to the local TUI and every attached read-write client at once; the first valid answer wins, is authoritative, and the resolution — with its deciding surface — is echoed to every other surface including the TUI
- R34-PERM.3: The request carries canonical detail — tool-call id, canonical cwd, command/path/operation — not a summary sentence (GSEC-06)
- R34-PERM.4: Bounded, spoof-safe rendering happens at the protocol layer — decisive suffixes preserved, control and bidi characters neutralized — so all three renderers inherit it rather than each reimplementing it (GSEC-06)
- R34-PERM.5: Answers are validated against the immutable offered-option set stored with that exact pending request; unknown, stale and cross-session ids are refused without consuming the still-answerable request (GSEC-11)
- R34-PERM.6: A bounded pending registry survives client disconnect and replays exactly once after authenticated reconnect; expiry fails closed; entries are removed on answer, cancel or session exit (GSEC-10, in-session case)
- R34-PERM.7: An enumeration regression over draht's active tool registry — including an extension-provided tool and one invoked inside a subagent — proves every execution that raises a local prompt raises a remote one; the relay is documented as observability parity and makes no claim that the gate's *rules* cover every dangerous path (GSEC-02, rules half re-owned to Milestone 6 Phase 45)
- R34-PERM.8: A measured answer-latency ceiling from a **real provider turn** is archived — tool-call to prompt-offered, and the maximum answer delay the turn tolerates before failing — because the mobile job is answering after walking away, and a tolerated delay shorter than the human one is a design defect that must surface here, not in a later renderer phase

### R35-ALWAYS: Every Session Is There — Default-On, History, Honest Liveness
- R35-ALWAYS.1: Interactive sessions register a control socket by default, resolving spec §10 Q3 default-on; `--no-attachable` and a settings key opt out; print and rpc modes keep today's behavior
- R35-ALWAYS.2: Socket registration failure never prevents a session from starting — it degrades to non-attachable with exactly one notice, proven by a regression asserting the session otherwise runs byte-identically
- R35-ALWAYS.3: Attach is same-owner only — 0700 per-uid socket directory plus an explicit ownership check on both socket and lock before the bridge connects
- R35-ALWAYS.4: Socket-directory hygiene at scale — reaping on start and on discovery, a cap on live sockets with a defined refusal, and no unbounded `.sock`/`.lock` growth across repeated start/kill cycles
- R35-ALWAYS.5: `activeRewinds` in `coding-agent/src/core/checkpoints/rewind.ts` stops being module-global before default-on ships, because `isRewindInProgress()` is currently shared across every session in the process and default-on multiplies attachable sessions per host (open Phase 42 residual, 2026-08-19)
- R35-ALWAYS.6: `GET /history` enumerates past sessions from `~/.draht/agent/sessions/<cwd-slug>/<ts>_<uuid>.jsonl` by first line only, incrementally cached and mtime-invalidated, paged and filterable by project, with a measured budget on the real ~843-directory corpus
- R35-ALWAYS.7: Every listed session carries `origin` and `attachable` on the wire; a session from a build predating socket registration is `history`, resumable-not-attachable, and no renderer may present it as steerable — spec §4's honest v1 limit as a protocol field, not prose
- R35-ALWAYS.8: Derived status comes from observed process state plus a deadline-bounded git probe; probe failure or timeout yields `unknown`, never `clean` and never a terminal value (GSEC-07 fail-open half)
- R35-ALWAYS.9: `session_resume` over the public protocol resumes a history session through the existing `--resume` path; the resumed process registers a socket and joins the live fleet with no manual step and no client reconnect
- R35-ALWAYS.10: `fleet_delta` incremental updates (appeared / disappeared / status changed) plus a snapshot-resync path usable on the same socket without reconnecting, so a phone that slept converges without a full reload
- R35-ALWAYS.11: Soak instrumentation records socket bind/rebind/teardown, client attach/detach, rejected prompts, fd count and socket count to a rotating JSONL retained across process restarts — the input to Phase 39's verdict, recording from the day default-on lands

### R36-SPAWN: Start Work From the Phone, Without Handing Out a Shell
- R36-SPAWN.1: `session_spawn` accepts a harness id plus a project id resolved against a user-owned registry (`geist.yaml` / `GeistConfigSchema` / `geist-core/registry`); it is the only spawn path and it replaces the Phase 32 refusal (spec §6.3)
- R36-SPAWN.2: Resolution yields a canonical absolute executable under a user-owned, non-symlinked, non-group/world-writable path, race-safely verified at launch; relative commands, PATH lookups and project-local binaries are rejected (GSEC-12)
- R36-SPAWN.3: The registry file and its secure parent are current-uid, non-symlink and not group/world accessible on every load; project-supplied config may reference only approved harness ids and canonical approved roots (GSEC-12)
- R36-SPAWN.4: Children receive an allowlist-built environment — absolute trusted PATH, runtime/locale/temp, and only that harness's declared auth — with arbitrary-name canaries proving nothing else crosses into the child or a nested grandchild (GSEC-03; sessions geist merely discovers inherit the user's own shell environment by construction and are explicitly out of scope, stated in the docs)
- R36-SPAWN.5: A remotely spawned session starts untrusted with project-controlled executable resources disabled and never bypasses `coding-agent/src/cli/project-trust.ts`; trust is granted only through the local machine, never by a remote or model answer (GSEC-01, v1 form)
- R36-SPAWN.6: Automatically read project context is a no-follow regular file canonically contained under an approved root; symlinks, special files and out-of-root ancestors are refused, with a canary proving out-of-root bytes never reach the first provider request (GSEC-13, geist-spawn form)
- R36-SPAWN.7: Numeric deadlines on spawn, handshake, first output and stop, with TERM→KILL process-tree teardown; a wedged child never wedges the daemon (GSEC-09 lifecycle half)
- R36-SPAWN.8: Spawned sessions are indistinguishable from discovered ones — same id space, same capability shape, same attach path — no free-text command field exists anywhere in the client, and the identical acceptance script passes unchanged against both origins

### R37-LANE: Run Lanes, Not a Wall of Text
- R37-LANE.1: A typed `run_event` frame carries structured lane items (tool call start/update/end, message deltas, plan/todo updates, diffs) with stable per-item ids, added alongside the text frame and version-negotiated at attach, so terminal `draht --attach` and every Phase 32-36 client keep working unchanged
- R37-LANE.2: The producer is draht's existing typed `AgentSessionEvent` stream — `subscribeToSession` (`core/socket-server/session-integration.ts:228`) currently flattens it to `[Tool: name]` strings and text deltas; this phase stops discarding the structure rather than building a new pipeline
- R37-LANE.3: Sessions that cannot emit structured events advertise `lanes:false` and degrade to text only, and Phase 32's attach acceptance passes unmodified against such a session
- R37-LANE.4: Diff lanes carry path plus hunk metadata sufficient to render a review without the client touching the filesystem — a hard requirement for the mobile and spatial renderers, which have no filesystem access
- R37-LANE.5: `geist-core/lanes` maps harness events to renderer-agnostic lanes and `subagent-recognizer.ts` stays data-driven and golden-tested; unrecognized tools render as generic lanes, never as raw text and never invisibly
- R37-LANE.6: A wide viewport shows several sessions at once, and input, permission answers and stops are scoped by session id with isolation proven by test
- R37-LANE.7: A scoped `session_cancel` cancels an in-flight turn, producing a terminal lane item and zero further `run_event` frames for that turn after acknowledgement
- R37-LANE.8: Lane streams are bounded by the Phase 32 caps and drop with an explicit notice frame rather than growing unboundedly; a flood regression proves the daemon stays responsive (GSEC-09 lane half)

### R38-ONE: One Binary, Always Running — Absorption and Protocol 1.0
- R38-ONE.1: `runGeist()` becomes the real composition root — config load, bind guard, auth, fleet, attach bridge, permission relay, registry — and the emitted `geist` binary becomes the daemon, closing the "primitives without composition" finding of the 2026-07-13 audit
- R38-ONE.2: `packages/gateway`'s host layer (server, lifecycle, EventBus, auth middleware, bind-host) moves into `packages/geist`; because R32-FLEET.1 kept the product logic in `geist-core`, this is a host swap and `check-geist-boundary.mjs` is green with **no change to the `GEIST_FAMILY` allowlist**
- R38-ONE.3: Every Phase 32-37 acceptance suite passes against the `geist` binary with no edit other than the binary path; gateway's raw-stdout session wire is retired and `draht-gateway` either prints a deprecation and forwards or is removed, with the choice regression-tested
- R38-ONE.4: The protocol is promoted to `geist/1.0`; `hello`/`server_hello` refuses a mismatch with a typed error and never silently degrades; the pinned 1.0 corpus must keep validating against the daemon forever, and post-1.0 additions may only be optional fields
- R38-ONE.5: A headless journey client depending only on `geist-protocol` and importing zero renderer code (asserted by the boundary gate) executes every journey the three renderers claim — list, live-vs-history, attach, stream, input, lanes, permission answer, resume, spawn, reconnect-and-resync — against the emitted binary; a journey it cannot express is a protocol defect that blocks the freeze, and the ten journeys are written down as a reviewed artifact at the start of Phase 32 and kept current, so this is a verification and not a design exercise
- R38-ONE.6: `docs/geist/protocol.md` is generated from the schemas, and `check-geist-mirrors.mjs` covers every headset-visible 1.0 schema including the attach, fleet, permission and lane frames
- R38-ONE.7: A launchd service starts the daemon at login, restarts it on failure and logs where the operator can find it; a paired client reconnects across logout/login with no terminal step
- R38-ONE.8: `geist doctor` reports bind host, listener count, socket-directory mode and state, discovered sessions by origin, paired devices, exposure and harness auth in one command, and refuses to start silently on a config that sets a non-loopback host — including a legacy `~/.draht/gateway.config.json`

### R39-RESIL: Resilience — Sleep, Drop, Restart, Death
- R39-RESIL.1: Sleep/wake re-verifies the socket-directory view, reaps sockets whose owning pid died during sleep and republishes fleet state; attached clients resync instead of showing stale sessions
- R39-RESIL.2: A tailnet drop mid-turn reconnects on the stored device credential, receives a full fleet resync and a single-delivery pending-permission replay, and can never double-answer — asserted from the session's own JSONL
- R39-RESIL.3: Daemon restart with permissions pending either durably replays them or explicitly fails them closed to the originating session; the choice is written down and tested both ways (GSEC-10, restart case)
- R39-RESIL.4: Session death mid-attach delivers a typed `session_gone` to every attached client within a declared bound, drops it from the fleet, and strands no client on a dead sequence
- R39-RESIL.5: Reconnect after the grace window, a device-id collision, and a device with a skewed clock each have defined, tested outcomes rather than silent acceptance
- R39-RESIL.6: The Phase 35 soak verdict is archived under `.planning/geist/` — ≥10 real interactive sessions over ≥7 elapsed days including ≥3 sleep/wake cycles and ≥1 tailnet drop — with fd count, socket count, RSS and startup delta inside a declared budget and zero orphaned `.sock`/`.lock` pairs
- R39-RESIL.7: Session-replacement paths (`/new`, `/resume`, `/fork`, `/import`) rebind the socket, remove the old id from discovery and leave no orphans, driven against the emitted binary

### R40-SPATIAL: Spatial Renderer (Quest 3)
- R40-SPATIAL.1: The Quest client consumes frozen `geist/1.0` only, with zero `@draht/*` imports under `quest/` and a Kotlin mirror gate over every headset-visible schema that fails on an omitted schema and on a field or type rename
- R40-SPATIAL.2: Sessions are *placed* rather than listed — panel per session, pointing to address, multi-viewport, pins, spatial anchors and pose persistence — carrying rev 7's retained spatial design (spec §5.3) forward intact as this phase's internal gates
- R40-SPATIAL.3: The spatial renderer adds no protocol message; anything it needs that 1.0 lacks is a 1.x additive change with a corpus update, never a fork or a private channel
- R40-SPATIAL.4: A CI job runs the Phase 38 journey client, the browser suite and the transport suite with the entire Quest client removed from the build tree and no headset present, all green — the renderer's absence can never block the desktop or mobile surfaces
- R40-SPATIAL.5: Class-4 archived physical Quest 3 evidence for QR pairing over `tailscale serve`, three placed panels bound to three genuinely running draht sessions, a permission answered by pointing with the agent observed proceeding, and pose restored across a headset restart — each carrying commit, APK, headset/OS and Spatial SDK identifiers


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
