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
> **2026-08-18 reconciliation:** Phase 31 is **complete** — the boundary-gate loophole the audit reopened it for was closed on 2026-08-12 by 13 red/green commits, mutation-proven by 9 tests spawning the real gate script (`packages/geist/test/boundary-gate.test.ts`, 9 pass / 96 assertions). Phases 32-40 remain pending and are **superseded in scope** by `.planning/specs/2026-08-18-geist-remote-control-rev8.md`: geist absorbs `packages/gateway` and becomes remote control for running draht sessions, with desktop/mobile/spatial as three renderers over one core. The Quest-hardware H-gates leave the critical path.

## Phase 31: Geist Foundation & Repo Scaffold — `complete`
**Goal:** The repo layout, workspace wiring, and cross-cutting contracts every geist milestone depends on exist and are boundary-checked.
**Requirements:** R31-FOUND.1, R31-FOUND.2, R31-FOUND.3, R31-FOUND.4, R31-FOUND.5, R31-FOUND.6, R31-FOUND.7
**Acceptance:** The existing layout/config/docs scaffolds remain; `scripts/check-geist-boundary.mjs` rejects both direct Draht-kernel imports and `@draht/draht-acp` imports from each of `packages/geist`, `geist-core`, `geist-acp`, `geist-protocol`, `geist-picker`, and `geist-console`, with a separate zero-`@draht/*` Quest mutation; only the shim may import the Draht kernel. Kotlin field/type mirror enforcement is completed with M1 when the headset protocol lands.

## Phase 32: Fleet, Attach & One Served Surface — `partial`
**Why here:** the verification log says remote control is a wiring job, so the first phase is the wiring — and it is also the only safe moment to delete the arbitrary-command spawn route before the daemon becomes something that runs all day.
**Goal:** A `draht --attachable` session on the Mac is listed and steerable from a page the daemon serves on loopback, over a versioned protocol whose product logic already lives behind the geist boundary gate.
**Requirements:** R32-FLEET.1, R32-FLEET.2, R32-FLEET.3, R32-FLEET.4, R32-FLEET.5, R32-FLEET.6, R32-FLEET.7, R32-FLEET.8, R32-FLEET.9, R32-FLEET.10, R32-FLEET.11, R32-FLEET.12
**Acceptance:** Class 3 (production-e2e). A test starts the emitted `draht` binary with `--attachable` against the in-repo keyless provider, starts the daemon via its bin on an ephemeral loopback port, and then over HTTP/WS only: sees exactly that session in `GET /fleet` with its real cwd and pid; attaches; sends a prompt; receives the assistant's streamed text; a second attached client sees the first's `input_echo`; killing the draht process removes the session within one poll; an unauthenticated WS is closed before the Unix socket is opened; an oversized frame yields a typed `protocol_error` that disconnects only the offending client while the other client's stream continues; a prompt sent mid-stream produces the defined queued-or-refused behavior with a client-visible reason. Four separate emitted-binary proofs: `POST /sessions {"command":["/bin/sh","-c","touch $CANARY"]}` is refused and the canary does not exist; a non-loopback bind is refused on the CLI flag, the config file, the programmatic surface and per request, and enumerating the spawned pid's listening sockets shows exactly one; deliberately altering one field of one wire schema fails root `npm run check` with a named diff and passes only after a 0.x bump plus regenerated corpus; `check-geist-boundary.mjs` is green with the fleet and bridge code in `geist-core`. A headless-browser run loads the served bundle from the running daemon, clicks the session, types a prompt, and asserts the assistant's text in the DOM at both a desktop and a 390×844 viewport. No package-level test satisfies any clause.
**Status (2026-08-19):** The product works. A real browser drives a real daemon attached to a real `draht --attachable` session — prompt in, streamed assistant text out — at desktop and 390x844. Acceptance clauses verified against the emitted binaries and the public protocol; `fleet-attach.e2e.test.ts` passes 10/10 and was re-run 5 consecutive times from a clean build. Evidence class 3. Marked `partial` only for the residuals below, which are smaller than Phases 42/44's.
**Residual (2026-08-19):**
- The console replenishes its reconnect budget only on a successful ATTACH, so a console that connects but never opens a session never resets `retries` and gives up permanently. Introduced by the fix for the opposite bug (unbounded reconnect when a session dies).
- `fleet-attach.e2e.test.ts`'s concurrent-writer test is load-sensitive — it paces the stub at 25 tokens/sec to land a prompt mid-stream, and flaked ~30% under heavy parallel load while passing 5/5 idle. It will flake in CI.
- The `@draht/ai` subpath fix is a point patch: only one subpath is aliased, so `@draht/ai/providers/anthropic` and `@draht/ai/api/*` still fail to resolve under jiti. `packages/ai/package.json` advertises wildcard `./providers/*` and `./api/*` exports, so the next extension reaching for an unlisted one reproduces the same silent failure.
- `listeningSockets()` in `bind-host-emitted.e2e.test.ts` returns `[]` both when a process has no listeners and when `lsof` is missing, so the single-listener proof degrades to a vacuous pass on a host without `lsof`. Non-vacuous on this machine.
- Session-direction frames are capped at `maxBufferedOutputBytes` (4 MiB) rather than uncapped; a single socket-wire line above that still disconnects readers.

## Phase 33: On the Phone — Exposure, Pairing, Device Credentials — `partial`
**Why here:** the phone is the product, and the one assumption that could invalidate Phases 34-40's whole delivery model — that `tailscale serve` carries a `wss://` upgrade to iOS Safari and the Quest browser — is cheapest to falsify the moment there is something to load.
**Goal:** Oskar opens the MagicDNS URL on his iPhone, scans a QR once, and steers a live session — no IP typing, no token typing, no secrets in URLs, daemon still bound to loopback.
**Requirements:** R33-REACH.1, R33-REACH.2, R33-REACH.3, R33-REACH.4, R33-REACH.5, R33-REACH.6, R33-REACH.7, R33-REACH.8, R33-REACH.9, R33-REACH.10
**Acceptance:** Class 3 plus class 4 for the device probe. Against the emitted binaries behind a local TLS-terminating reverse-proxy fixture reproducing the `tailscale serve` topology and identity header (so CI never needs a live tailnet): a `wss://` client presenting `?token=<valid>` is refused and the same credential presented as a first message is accepted; a bootstrap token is accepted exactly once and its replay refused while the first connection stays bound and undisturbed; a wrong-token `pair` on a second socket leaves the first device authorized; `geist devices revoke` causes the *next frame* from that device to be refused; a request with a forged identity header naming a non-owner is refused and one with none is still subject to full credential auth; killing the proxy mid-session yields a visible disconnected state and an automatic reconnect that restores the transcript; a scan of the recorded transport and the daemon's logs finds zero credential material in any URL, query string or log line. A headless mobile-emulated browser completes deep-link → paired → session list → prompt → assistant text in the DOM, then reloads and steers again with no re-pairing. The daemon's bind is asserted 127.0.0.1 for the whole run. Class 4: archived evidence that iOS Safari and the Quest 3 browser each load the served bundle over `https://<magicdns>` and complete a WS upgrade, with pinned browser/OS versions, screenshots and console logs; plus one real-tailnet end-to-end run with the observed identity-header contract pinned into the fixture and annotated with the tailscale version it was captured from. `npm run check` fails on any hostname-less `Bun.serve` in the repo.
**Run budget — decided, not discovered (2026-08-20, P33-T25):** Phase 32 left one browser suite and one spawned-binary suite in the root `test` chain; Phase 33 adds four more (`scripts/fixtures/tls-proxy.test.mjs`, `scripts/geist-device-evidence.test.mjs`, `scripts/geist-reach-browser.e2e.test.mjs`, plus `packages/gateway`'s `reach-transport.e2e.test.ts` and `device-revocation-live.e2e.test.ts` inside the workspace fan-out). `node --test` runs test **files** concurrently by default, so before this the whole scripts group raced on one runner — the exact contention under which Phase 32's residual says `fleet-attach.e2e.test.ts`'s concurrent-writer test (stub paced at 25 tokens/sec) flaked ~30%.
- **Decision: no split CI job. The budget lives in the root `package.json` scripts, and CI runs `bun run test` verbatim** — one definition of "the suite", so CI cannot drift from what a developer runs locally. The root `test` chains `npm run test --workspaces --if-present && npm run test:scripts && npm run test:scripts:serial && bun test scripts/check-geist-protocol.test.mjs`. `test:scripts` keeps node's default file concurrency for the fast suites; `test:scripts:serial` runs every spawned-process/browser suite with `--test-concurrency=1`, so exactly one Chromium and one process fleet is alive at a time.
- **Declared timeouts:** `--test-timeout=120000` (fast group) and `--test-timeout=300000` (serial group) — a wedged spawn fails as a timed-out test instead of eating the job; `.github/workflows/ci.yml` sets `timeout-minutes: 60` on the job and `40` on the Test step. Measured on a 14-core dev box: serial group 73/73 in **52s**, the same six files at default concurrency **39s** — the serialization costs ~13s there and should cost less on a 4-vCPU `ubuntu-latest`, where the contention is what costs.
- **Retry policy:** none automatic. No `continue-on-error`, no `--rerun-each`, no muted step. `fleet-attach.e2e.test.ts`'s concurrent-writer runs inside gateway's `bun test`, not the node group, so serializing the node group does **not** fix it — the policy for it is one manual "re-run failed jobs"; a second failure is a regression, not a flake, and gets a fix rather than a rerun.
- **Wiring gate:** `scripts/root-test-script-parity.test.mjs` walks the tree and fails if any `scripts/**/*.test.mjs` is unreachable from the root `test` script, if the script names a path that does not exist (`node --test missing.mjs` exits 0), or if the workspace fan-out that carries `packages/gateway`'s `*.e2e.test.ts` files is removed. It found three suites already unwired — `geist-reach-browser.e2e.test.mjs`, `geist-device-evidence.test.mjs` and `publish-workspaces.test.mjs` (unwired since well before this phase). Evidence class 2: it closes no acceptance clause, it only guarantees the class-3 suites actually run.
- **CI is knowingly RED and must stay that way:** `packages/gateway`'s `tailnet-identity.test.ts` → "is a real capture, not the placeholder this repo ships" fails because the real tailnet identity header has never been observed on this machine and the pin file is a marked placeholder. Nothing in CI can clear it. It is cleared only by a human running, on a tailnet-joined machine, `node scripts/geist-tailscale-serve.mjs --capture-identity --peer NODE --out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json` — which is also the class-4 half of this phase's acceptance. Do not skip, exclude or `continue-on-error` it to make the badge green.

**Landed `partial` 2026-08-21 (29 commits).** Everything not requiring Oskar's hardware is done and
verified on an idle machine: `packages/gateway` 364 pass / 1 fail, where the single failure is the
deliberate capture tripwire below. `npm run check` green.

Class-3 evidence, against spawned emitted binaries through the TLS reverse-proxy fixture — no in-process
daemon import in any of them:
- `reach-transport.e2e.test.ts` 9/9 — all eight acceptance clauses, plus the whole-run 127.0.0.1 bind
  assertion through the non-vacuous watcher.
- `first-pairing-no-restart.e2e.test.ts` 5/5 — a QR scanned against an already-running daemon pairs
  without a restart, asserted by an unchanged pid.
- `geist-reach-browser.e2e.test.mjs` 2/2 — deep-link → paired → prompt → assistant text → reload → steer
  again, and proxy-killed mid-stream → visible disconnect → reconnect with the transcript intact.
- `fleet-attach.e2e.test.ts` 10/10 — Phase 32's invariant rewritten, not deleted: an unauthenticated
  attach still reaches no Unix socket, now proven by the `not_authenticated` refusal plus an unchanged
  socket directory.
- `geist-console-bundle.e2e.test.mjs` 29/29 — including the 390x400 keyboard layout and 44px touch targets.

**What Phase 33 still needs, and it is not more agent work:**
1. **R33-REACH.1's run.** `node scripts/geist-tailscale-serve.mjs --verify --peer <node>` on a
   tailnet-joined machine. The script, its funnel guard, its failure taxonomy and its idempotency are
   committed and green against a fake tailscale binary; only the execution needs a tailnet. Note the
   recorded client/daemon skew (CLI 1.98.8 vs tailscaled 1.102.1) and that `tailscale serve status`
   reports no serve config, so this is a first publish.
2. **R33-REACH.8's capture — this is what keeps one test red.**
   `node scripts/geist-tailscale-serve.mjs --capture-identity --peer <node> --out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json`
   then set `DEFAULT_TAILNET_IDENTITY_HEADER` in
   `packages/gateway/src/gateway/middleware/tailnet-identity.ts` to the header it records. The real
   tailnet identity header has never been observed on this machine; the pin ships as a marked
   placeholder and the test fails until it is replaced. **Do not skip, exclude or `continue-on-error`
   it.** The deny-only policy it guards is tested and green — what is unverified is which header name
   Tailscale actually sends.
3. **R33-REACH.2 — class 4, iOS Safari and the Quest 3 browser.** `node scripts/geist-device-evidence.mjs`
   collapses it to one command plus two QR scans, four screenshots and two console-log pastes; `--measure`
   records the idle-timeout, sleep/wake and tailnet-drop behaviour that is the declared input to Phase 39.
   The Quest 3 has been offline 36 days — charge it first. No emulator substitutes: this clause exists
   because rev 8's delivery model rests on the unverified assumption that `tailscale serve` carries a
   `wss://` upgrade to those two browsers.

**Scope corrections made during execution, so the roadmap text above is stale in two places:** the
bind-host obligation was already closed in Phase 32 (`check:bun-serve-hostname` green over 1561 files),
so Phase 33 owed only the continuous assertion and the `lsof` vacuous-pass fix; and "an automatic
reconnect that restores the transcript" is client-side preservation plus re-attach, not server replay —
neither the geist wire nor the coding-agent socket server has any scrollback concept.

**Residual — `geist` is not runnable as an installed npm bin (found 2026-08-20 by P33-T19, unowned):**
`packages/geist` declares `bin.geist = dist/cli.js`, but that file imports `@draht/geist-core`, whose
package `main` is `./src/index.ts`, and `packages/geist-core` ships no `dist/`. Node cannot parse
TypeScript, and geist-core's internal `./x.js` specifiers do not exist on disk either
(`ERR_MODULE_NOT_FOUND` on `geist-core/src/attach/attach-bridge.js`). `@draht/geist-protocol` has the
same shape (`main: ./src/index.ts`, no `dist/`). The CLI therefore runs only under `bun`, which resolves
TypeScript directly — every Phase 33 suite spawns it with `bun` for this reason and says so. This is
latent today because nothing installs `geist` from a registry, but it blocks **Phase 38** (`runGeist()`
as a real emitted binary starting at login) and **Phase 52** (publish). Whoever owns Phase 38 must decide
whether geist-core/geist-protocol gain a build step or whether geist ships as a bun-compiled single file.
Verified by reading the three package.json files and confirming no `dist/` exists in geist-core.

## Phase 34: The Ask Reaches the Phone — Permission Relay — `pending`
**Why here:** this is the mobile companion's whole reason to exist (spec §5.2), and it is the last frame-shaping change the wire needs before default-on multiplies clients — better to shape the wire while it is young and the corpus is small.
**Goal:** An agent asks for permission on the Mac; the phone shows exactly what it wants; a tap answers it; the terminal and every other surface reflect the same answer.
**Requirements:** R34-PERM.1, R34-PERM.2, R34-PERM.3, R34-PERM.4, R34-PERM.5, R34-PERM.6, R34-PERM.7, R34-PERM.8
**Acceptance:** Class 3. The phase opens with a timeboxed probe against the seam named in R34-PERM.2 and a written go/no-go recording viability plus, on no-go, the fallback and what it costs the §1 thesis. Then: with an in-repo extension and a subagent-gated tool call, a session started by the emitted `draht` binary is attached over the public WS and the request arrives carrying the real command, canonical cwd and tool-call id; answering from the WS lets the session proceed, and the resolution appears in a second attached client and in the local TUI — asserted from the session's own JSONL, not in-process state; the local TUI answering first tells the WS client the request was resolved and by which surface; a second answer is refused as already-resolved; an unknown, stale or cross-session option id is refused without consuming the still-answerable request; a request containing CR, ANSI and RTL-override bytes renders neutralized with its decisive path suffix intact; SIGKILLing the answering client mid-request and reconnecting replays it exactly once; expiry denies and the session reports the denial; killing the session removes the pending entry. An enumeration regression walks the active tool registry — including one extension-provided tool and one invoked inside a subagent — and asserts every execution that raises a local prompt raises a remote one. A measured answer-latency ceiling from a real provider turn is archived.

**R34-PERM.8 measured (2026-08-21), and the headline number is not the one that matters.**

*The agent core imposes no deadline on a permission ask.* Verified at every layer between the provider
request and the dialog — `agent-loop.ts:193/214/619-628` (the stream is fully drained and `message_end`
emitted before any tool runs; the gate is a bare `await` with no race and no timer), `runner.ts:986`,
`agent-session.ts:473` (the loop's `signal` is not even forwarded), `subagent.ts:605` (calls `confirm`
with two arguments — the `opts` carrying `timeout`/`signal` is never supplied), `packages/ai` (per-request
timeouts only), and no reaper in session-manager, agent-session or socket-server. **Measured against the
emitted binary at 30s / 120s / 600s / 1500s — four rungs, zero degradation.** Phase 34 MAY keep
"hold the turn" as its primary mechanism; do NOT build park/auto-deny/retry as the primary design.

*But answer latency is bounded by the TRANSPORT, not by the agent.* **CORRECTED 2026-08-21 by
measurement — the first version of this note, and the adjudication behind it, were right that the
transport is the binding layer and wrong about the mechanism. Recorded here in full because the wrong
version was committed and acted on.**

What was actually true, measured against a real listener:
- `Bun.serve({ idleTimeout })` — where `config.idleTimeout: 255` was being passed — **does not govern
  WebSockets at all.** A server with a top-level `idleTimeout: 3` held a silent socket for 12s and 20s.
  The 255 an operator could configure never described `/attach` in either direction.
- The window that governs `/attach` is `Bun.serve({ websocket: { idleTimeout } })`, which this package
  never set, so it ran on Bun's unset default of **120s — not 255s**.
- Bun's reaper is a **liveness probe, not a plain timer**: it emits one PING near the end of the window
  (t≈104s) and closes at t=120s only if no PONG returns. A client that pongs was never reaped (measured
  open at 200s). **So "the socket goes silent and Bun closes it ~4m15s later" is not reproducible for a
  compliant browser**, which answers pings in its network stack. An awake phone on a healthy path likely
  already survived a held ask — by accident.

What was genuinely wrong, and what the fix addresses: the connection's life rested entirely on the peer's
PONG arriving inside a ~16s grace, during the one interval when nothing else is on the wire to keep the
path warm — and a phone on a radio is exactly the peer most likely to be late. The window was also an
unset upstream default that no configuration could move and no test pinned. The fix (a) sets
`websocket.idleTimeout` explicitly from the effective config so `GatewaySettings.idleTimeout` finally
means what it says, and (b) adds a server-side ping at `idleTimeout / 3` that resets the window on SEND,
so survival no longer depends on the peer answering anything — measured surviving 10x the window against
a client that never ponged once. The divisor is 3, not 2, so two consecutive missed keepalives are still
survivable.

**Scope, stated plainly:** this fixes the connection being reaped while both ends are AWAKE. It does
nothing for a phone that is asleep, in a tunnel, or handed between networks — there the socket genuinely
dies and no server-side pinging helps. That case needs a durable pending ask a reconnecting client
re-reads, which depends on decision 5 in `.planning/DECISIONS-PENDING.md`. **The walk-away case is not
fully solved.**

**Phase 34 prerequisites that follow, not nice-to-haves:**
1. An application-level heartbeat on `/attach` well under 255s, or a durable pending ask a reconnecting
   phone re-reads. Without one, the measured 25-minute core tolerance is unreachable in the product.
2. Arm the dialog deliberately — pass real `ExtensionUIDialogOptions` at `subagent.ts:605` with a generous
   `timeout` (an hour, not 30s) and a `signal`. Today it inherits "wait forever", making an unanswered ask
   an immortal wedged turn. Timeout defaults to DENY (`rpc-mode.ts:142`), the right fail-safe direction —
   surface "timed out, denied" as distinct from "user said no".
3. ~~**Defect:** abort wedges the loop~~ — **FIXED 2026-08-21.** `cancelPendingExtensionRequests()`
   resolves every pending dialog through the protocol's own `{cancelled: true}` shape, so fail-closed is
   automaticrather than a bespoke path: each dialog's `parseResponse` already maps `cancelled` to that
   method's negative default.
4. ~~**Defect:** stdin `end` kills a pending ask~~ — **FIXED 2026-08-21**, shutdown now resolves pending
   dialogs fail-closed before exiting. The existing lifecycle is unchanged and regression-tested; whether
   an attachable agent should OUTLIVE the bridge that spawned it is a product question tied to decision 5
   and was deliberately not decided.
5. Render pending-approval from `extension_ui_request`, never from `tool_execution_start` — the latter
   fires BEFORE the gate in both sequential and parallel paths, so a naive surface shows a blocked tool as
   "running".
6. Parallel tool calls **serialize at the gate** (`agent-loop.ts:489-520`). Either batch-approve, or accept
   N serial round trips and design the surface to show the queue.
7. Set `PI_CACHE_RETENTION=long` for remote-controlled sessions (`anthropic-messages.ts:49-57` defaults to
   a 5-minute TTL) so a walk-away lands inside a 1-hour cache window.

**Unverified — do not read these as proven:** no real provider was exercised (no API key in the
environment; real-provider tolerance is INFERRED from provider-agnostic sequencing, an inference an
independent adjudicator confirmed sound but which remains untested). 25 minutes is the longest hold ever
run. The interactive TUI path was not held (SSH idle, tmux, sleep/wake unexercised). The Codex/ChatGPT
WebSocket transport was not run — a >5-min hold there is correctness-safe but discards the continuation
delta and forces a full-context resend, so it is a real token COST the measurement wrongly excluded.

**SEAM RESOLVED and DESIGN OF RECORD — 2026-08-21.** Workflow `wf_08536a00-ffc`: six read-only lenses over
the permission, attach, durability, sanitization and tool-registry code, then two Fable 5 advisors at max
effort. Both returned `high` confidence, both ran their own probes, and they converge. Decision 5 in
`.planning/DECISIONS-PENDING.md` is closed: **the relay hooks the attach wire**, because rev-8 §4 already
requires it ("a session appears because it is *running*, not because it was started by geist").

*The named seam in R34-PERM.2 is wrong and this is the correction.* `createExtensionUIContext()` is a
producer, not a chokepoint. The single production `setUIContext` call site — verified by repo-wide scan —
is `agent-session.ts:2360` inside `_applyExtensionBindings`, reached by all four modes (interactive and rpc
via `bindExtensions`; draht-acp and the SDK via the constructor's `_buildRuntime`) and re-run on reload.
A `RelayUIContext` decorator composed there survives `/new`, `/resume`, `/fork`, `/import` and extension
reload. Installing it at the attach seam (`main.ts:916`) does **not** work: interactive and rpc later bind
their own context and silently overwrite it.

Five findings that change the implementation, each from a probe rather than a reading:

1. **`hasUI()` must become surface-aware in the same commit as the decorator.** It is an identity check
   against `noOpUIContext` (`runner.ts:464-466`), so *any* decorator flips it true. For an `--attachable`
   session with zero clients attached, that converts today's loud fail-closed block into either an eternal
   hang or the wrapped noOp's instant `false` — which `subagent.ts:606-608` reports as **"User denied
   approval"**, a fabricated user action written into the transcript. Contract: `hasUI` becomes "at least
   one surface can answer right now"; the no-surface case keeps blocking.
2. **Ordering is `settle → resolve → abort losing surfaces → broadcast → append JSONL`.** Reversed, the
   abort resolves the losing TUI dialog to `false` (`interactive-mode.ts:2307` maps abort to false), which
   re-enters the decorator as an apparent TUI **deny** and overwrites the phone's approve.
3. **`settle()` is synchronous** from pending-check through `resolve()`. A single `await` between the
   pending-check and the settled-mark lets both answers pass validation, double-appending the JSONL with
   conflicting `decidedBy` — and it is silent, because the second `resolve()` is a no-op.
4. **The pending registry cannot live in the decorator.** `_buildRuntime` constructs a new
   `ExtensionRunner` per reload and recreates the decorator. It lives on the relay object inside
   `makeSessionAttachable`'s bind closure — which also dies with the session (correct for "removed on
   session exit") while surviving client churn (correct for "survives client disconnect").
5. **The protocol change is ONE atomic commit, not a sequence.** `MIRRORED_UNIONS` fails the build on any
   unmirrored socket-wire union member; `missingGoldens` fails on any declared-but-unrecorded type; and
   `attach-bridge.ts:707-714` answers an undeclared frame by closing **every** attached phone with 1008.
   The train is: socket `types.ts` frames + `wire.ts` schemas + `GEIST_PROTOCOL_VERSION` 0.2→0.3 +
   `MIRRORED_FRAMES` rows + a `## geist/0.3` section in `MIGRATIONS.md` + regenerated
   `conformance/geist-0.3/` + the recorder scripts + the one literal pin at `wire-auth-frames.test.ts:100`.

**Requirement corrections, recorded because the requirements as written would produce defects:**

- **R34-PERM.1's frame `deadline` ships nullable and advisory.** An enforced frame deadline is a *new*
  denial path that did not exist before Phase 34, and it contradicts the archived PERM.8 finding that the
  agent core imposes none. Real expiry binds solely to the registry's fail-closed timer — one clock.
- **R34-PERM.2 needs the ask widened, not just decorated.** A pure decorator sees only what the caller
  passed, and `subagent.ts:605` passes a prose sentence — so the decorator alone would relay a summary and
  violate R34-PERM.3 in the same breath. The decorator and an optional `detail` on
  `ExtensionUIDialogOptions` are one change.
- **R34-PERM.4's "protocol layer" means the socket wire, at frame construction.** Read as geist-protocol
  it silently leaves `draht --attach` unprotected — that client is a bare `JSON.parse(line) as
  ServerMessage` cast (`socket-client.ts:177`). Neutralize where the frame is built; re-assert downstream
  in `wire.ts` with `.refine()`, never `.transform()` (a transform makes decode/encode non-idempotent and
  the conformance goldens compare byte-wise).
- **R34-PERM.7 is vacuous until the surface fix lands, and its subagent leg is unsatisfiable as written.**
  Under shipped defaults no local prompt is raised headless at all, so "every execution that raises a local
  prompt raises a remote one" enumerates the empty set. Subagents are separate `--mode json -p
  --no-session` processes with no socket, no UI and no env channel; the leg needs either a relay endpoint
  passed to the child or an explicit re-scope. **It must not block the phase.** The project-trust prompt
  (`main.ts:738`) is out of scope by construction — it runs before the session exists.
- **The shipped defect is fixed in-phase and first, not as a standalone patch.** Without a surface there is
  no correct behaviour to ship: flipping `hasUI` true yields a silent denial, a hang, or fail-open. The
  only real fix is giving sessions surfaces, which is this phase. Note it is wider than first reported —
  under `auto`, every *non-built-in* tool still hard-fails (`permission-gate.ts:755` defaults unknown tools
  to the approval tier).

**Skew, in both directions, measured:** an old `draht --attach` client silently ignores unknown server
frames (`socket-client.ts:188-226` has no default case), so that direction degrades gracefully. The lethal
direction is a new draht emitting to an old geist-core bridge — close 1008, every phone dropped. Emission
is therefore **capability-gated**: permission frames go only to clients whose `attach` declared support.

**Also found, worth fixing while here:** `mode: "banana"` currently attaches successfully and its input
reaches the session — the read-only check at `socket-server.ts:502` is a negative `=== "read-only"` test
over an unvalidated field. Answer authority cannot rest on that field until it is a closed set.


## Phase 35: Every Session Is There — Default-On, History, Honest Liveness — `pending`
**Why here:** this is the phase that makes "just automatically" literally true, and it is deliberately after the wire settles because turning sockets on by default multiplies per-host session state and collides with a known open Phase 42 residual.
**Goal:** Oskar stops typing `--attachable`. Any draht he starts shows up on the phone; past sessions show up as history, honestly labelled and resumable.
**Requirements:** R35-ALWAYS.1, R35-ALWAYS.2, R35-ALWAYS.3, R35-ALWAYS.4, R35-ALWAYS.5, R35-ALWAYS.6, R35-ALWAYS.7, R35-ALWAYS.8, R35-ALWAYS.9, R35-ALWAYS.10, R35-ALWAYS.11
**Acceptance:** Class 3. Through the emitted binaries only: a plain `draht` with no flags appears in the fleet within one poll and is steerable; with `--no-attachable` it never appears; a session started with socket registration forced to fail runs byte-identically to one started with the feature off, prints exactly one notice, and reports itself non-attachable; 50 sequential start/kill cycles leave zero `.sock`/`.lock` files and an empty fleet; a socket whose lock names another uid is refused rather than attached. Against a seeded `$HOME` of the same shape as the real ~843 project directories: the initial fleet returns inside a stated wall-clock budget with live sessions marked `origin:socket, attachable:true` and historical ones `origin:history, attachable:false, resumable:true`, and a read-byte counter proves no history file is read past its first line; `session_resume` on a historical id produces a process that joins the live fleet **without a client reconnect** and answers a prompt; killing a live session emits a `fleet_delta` removal, and a client that skipped deltas resyncs to the same state on the same socket. With the `git` binary replaced by a fixture that exits non-zero, and a second run where it hangs past the probe deadline, status is `unknown` — never `clean`, never a terminal value. A regression proves `isRewindInProgress()` is session-scoped with two concurrent attachable sessions in one process.

## Phase 36: Start Work From the Phone, Without Handing Out a Shell — `pending`
**Why here:** spawning is the first moment a remote party chooses which bytes execute and which project's context is read, so every launch-surface GSEC lands together, after the daemon is reachable and before it is convenient.
**Goal:** Oskar starts a new session from his phone — pick project, pick harness — and it launches on the Mac and attaches through exactly the same path as a discovered session.
**Requirements:** R36-SPAWN.1, R36-SPAWN.2, R36-SPAWN.3, R36-SPAWN.4, R36-SPAWN.5, R36-SPAWN.6, R36-SPAWN.7, R36-SPAWN.8
**Acceptance:** Class 3, with assertions against the OS process table rather than in-process state. Over the public protocol against the emitted binaries: a request naming a registered harness id launches exactly the registered canonical absolute executable in the resolved root, and the new session appears in the fleet with the same capability shape as a discovered one and answers a prompt; the identical acceptance script passes unchanged against a discovered session, proving no renderer branches on origin. Each adversarial fixture produces a typed refusal with no process created: a raw `command` array; a relative command in config; a PATH-shadowing binary; a project-local `./node_modules/.bin/draht`; a symlinked registry path; a registry file at mode 0644; one owned by another uid; one behind a symlinked parent; a project config naming an unregistered harness. Env canaries (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, and a randomly-named secret) are absent from the child's and a nested grandchild's environment. A malicious fixture loads no project extension and makes no provider call before an authenticated *local* trust grant, and a trust grant delivered as a renderer or model answer is rejected. A fixture whose `AGENTS.md` symlinks outside the approved root is refused and its canary bytes never appear in the recorded first provider request. A child ignoring SIGTERM is SIGKILLed within the stated deadline with no orphaned process-group members. A source-level check plus a server-side rejection test prove no free-text command field exists anywhere in the client.

## Phase 37: Run Lanes, Not a Wall of Text — `pending`
**Why here:** lanes are what make a phone screen usable at all, but they are additive to a wire that must already be proven — and they are the last protocol change before the freeze.
**Goal:** The served surface shows tool calls, plans and diffs as structured lanes, and a wide screen watches several sessions at once.
**Requirements:** R37-LANE.1, R37-LANE.2, R37-LANE.3, R37-LANE.4, R37-LANE.5, R37-LANE.6, R37-LANE.7, R37-LANE.8
**Acceptance:** Class 3. A session started by the emitted binary runs a file-editing tool and a multi-step plan: a WS client that negotiated the typed frame receives ordered `run_event` frames with stable per-item ids sufficient to reconstruct the run's lanes with **zero bytes read from the text stream and zero filesystem access by the client**, while a real terminal `draht --attach` receives the same run unchanged and the Phase 32 attach acceptance passes unmodified. A second session pinned to a build that cannot emit structured events advertises `lanes:false` and yields text only, and Phase 32's acceptance still passes against it. Browser automation renders a tool lane, a plan lane and a diff against golden DOM snapshots at both phone and desktop viewports, and an unrecognized tool renders as a generic lane rather than raw text or nothing. With two sessions attached, answering a permission or issuing a stop in one leaves the other's pending state and process untouched. A scoped `session_cancel` produces a terminal lane item and zero further `run_event` frames for that turn, asserted by a quiet period after the acknowledgement. A 10,000-event flood drops with an explicit notice frame rather than growing unboundedly, and the daemon still answers a fleet request during the flood.

## Phase 38: One Binary, Always Running — Absorption and Protocol 1.0 — `pending`
**Why here:** the move is pure refactor with no user-visible value, so it is scheduled after the product works — but before the third renderer exists, because `geist/1.0` is what stops the Quest client from being rework.
**Goal:** `runGeist()` stops being a stub, the daemon starts at login, and the protocol closes at `geist/1.0` with a conformance corpus that cannot drift.
**Requirements:** R38-ONE.1, R38-ONE.2, R38-ONE.3, R38-ONE.4, R38-ONE.5, R38-ONE.6, R38-ONE.7, R38-ONE.8
**Acceptance:** Class 3. The `geist` emitted binary starts from a clean config, serves the same public protocol, and every Phase 32-37 acceptance suite passes against it with no edit other than the binary path; `check-geist-boundary.mjs` and `check-geist-mirrors.mjs` are green with the moved host code and **no change to the `GEIST_FAMILY` allowlist**. A headless journey client depending only on `geist-protocol`, importing zero renderer code (asserted by the boundary gate), runs all ten declared journeys green against the spawned binary: list fleet, distinguish live vs history, attach, stream, input, receive lanes, answer a permission, resume, spawn from the registry, reconnect-and-resync. Every golden in `corpus/1.0/` still validates against the current schemas and is still accepted by the running daemon; a well-formed frame whose type is absent from the corpus is refused with `protocol_error`; a mutation of one schema field fails root `npm run check` and passes only after a version bump plus regenerated corpus and migration note; `docs/geist/protocol.md` regenerates byte-identically from the schemas. Installing the launchd service and logging out and back in leaves the paired client reconnecting with no terminal step. `geist doctor` on a machine whose config sets a non-loopback host reports the refusal instead of starting. `draht-gateway` either prints its deprecation and forwards, or is gone, with the choice regression-tested.

## Phase 39: Resilience — Sleep, Drop, Restart, Death — `pending`
**Why here:** every failure mode here was characterized by Phase 33's probe and instrumented from Phase 35, so this phase converts measured facts into handled behavior — and it is the last thing that must be true before a second machine (the headset) joins.
**Goal:** The product survives a closed lid, a train tunnel, and a daemon restart without lying about state or double-answering anything.
**Requirements:** R39-RESIL.1, R39-RESIL.2, R39-RESIL.3, R39-RESIL.4, R39-RESIL.5, R39-RESIL.6, R39-RESIL.7
**Acceptance:** Class 3. Injected faults against the emitted `geist` binary: a simulated sleep window plus SIGSTOP/SIGCONT of a session host reaps the dead sockets and republishes the fleet, and attached clients resync rather than showing stale sessions; dropping and restoring the tailnet interface mid-turn reconnects on the stored device credential, resyncs the fleet, replays exactly one pending permission, and — asserted from the session JSONL — produces no double answer; restarting the daemon with a permission pending produces the documented outcome, tested in both directions of the durable-replay-versus-fail-closed choice; `kill -9` on a session delivers typed `session_gone` to every attached client within the declared bound and strands no client on a dead sequence; reconnect after the grace window, a device-id collision and a skewed device clock each produce their defined outcome rather than silent acceptance. Driving `/new`, `/resume`, `/fork` and `/import` against the emitted binary rebinds the socket, removes the old id from discovery and leaves zero orphaned `.sock`/`.lock` pairs. Archived soak verdict: ≥10 real interactive sessions over ≥7 elapsed days including ≥3 sleep/wake cycles and ≥1 tailnet drop, with fd count, socket count, RSS and startup delta inside the declared budget.

## Phase 40: Spatial Renderer (Quest 3) — `pending`
**Why here:** last by construction — it consumes a frozen protocol, adds nothing to it, and its own acceptance includes proving that deleting it changes nothing about Phases 32-39.
**Goal:** Sessions placed instead of listed, as a third renderer over `geist/1.0`, without ever having blocked or reordered anything before it.
**Requirements:** R40-SPATIAL.1, R40-SPATIAL.2, R40-SPATIAL.3, R40-SPATIAL.4, R40-SPATIAL.5
**Acceptance:** Class 3 for the protocol layer, class 4 for the headset gates, and the class-3 clause gates the class-4 one. Class 3: a CI job runs the Phase 38 journey client, the browser suite and the transport suite with the entire Quest client removed from the build tree and no headset present, all green; `check-geist-mirrors.mjs` fails on a deliberately renamed field and on a deliberately omitted schema; a boundary mutation proves `quest/` imports zero `@draht/*`; a conformance test asserts no spatial-only server message type was added. Class 4: archived physical Quest 3 evidence of QR pairing over `tailscale serve`, three placed panels bound to three genuinely running draht sessions on the dev machine, a permission answered by pointing with the agent observed proceeding, and workspace pose restored across a headset restart — each frame carrying commit, APK, headset/OS and Spatial SDK identifiers. Class 4 evidence gates this phase and no other.

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

## Phase 42: Rewind Command & Restore UX — `partial`
**Goal:** `/rewind` restores conversation and files together: selector over checkpointed user messages, scope choice (conversation + files / conversation only / files only), a mandatory pre-rewind safety snapshot, diff-driven file restore, and leaf navigation via the existing `navigateTree` path — with `/tree` and `/fork` gaining the same file-restore offer.
**Requirements:** R42-RWD.1, R42-RWD.2, R42-RWD.3, R42-RWD.4, R42-RWD.5, R42-RWD.6, R42-RWD.7, R42-RWD.8
**Acceptance:** End-to-end tests prove: after the agent edits a tracked file, creates a new file, and deletes another, `/rewind` to the prior user message makes the working tree byte-identical to the checkpoint (created file gone, deleted file back); the pre-rewind state is itself recoverable by rewinding forward to the abandoned leaf (redo); a failure injected mid-restore rolls the tree back to the safety snapshot; conversation leaf only moves after file restore succeeds; "conversation only" and "files only" scopes each touch exactly their half; `/tree` navigation and `/fork` to a checkpointed entry offer file restore and honor decline; `pi.checkpoints` (list/get/restore) works from a test extension and `session_before_rewind` can cancel.
**Status (2026-08-19):** All 8 acceptance criteria verified on real fixture repos, but the phase is NOT complete — two adversarial reviewers blocked it on data-safety, and the follow-up round closed the reported defects while introducing others. Evidence class: production-e2e for the acceptance criteria; the residuals below are unclosed.
**Residual (blocking, 2026-08-19):**
- **Performance / test reliability:** `applyTreeDiff` spawns one `git checkout-index` process per path (~25s for 200 paths), and the suite now times out against its own 30s limit. Batching is the obvious fix but conflicts with the per-path `onPathRestored` callback the mid-restore failure-injection tests depend on. **This is an open design decision, not a patch.**
- **False refusals from the fail-closed guards:** a file→directory swap at the same path, and a case-only rename on a case-insensitive filesystem (macOS — the primary dev platform), both refuse a restore that is actually safe.
- `clearRestoreMarker` sits inside the try whose catch performs the rollback, so a failed unlink can undo a restore that already succeeded and report it `unrecoverable`.
- `/fork` still applies the restore from inside the cancelable `session_before_fork`, and can lose queued messages; the recovery notice never reaches the real TUI (`ctx.ui.notify` output is cleared by the selector).
- `activeRewinds` in `rewind.ts` is module-global, so `isRewindInProgress()` is shared across every session in the process — it now collides with the attachable socket sessions landed in e35f12b0d.
- The interrupted-restore marker is checked and written seconds apart with no lock, so two draht processes rewinding one repository can interleave.

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

## Phase 44: Sandbox Executor Core — `partial`
**Goal:** A `SandboxExecutor` in `packages/coding-agent/src/core/sandbox/` runs bash commands under a write-allowlist + network-toggle policy via platform backends (Seatbelt SBPL on macOS, Landlock with namespace fallback on Linux), with real-path policy generation, startup self-test, env hygiene, and a `BashOperations` wrapper — reporting `unavailable` cleanly everywhere else.
**Requirements:** R44-SBX.1, R44-SBX.2, R44-SBX.3, R44-SBX.4, R44-SBX.5, R44-SBX.6
**Acceptance:** Escape-attempt tests prove confinement on both macOS (local) and Linux (CI): writes outside the allowlist fail whether attempted directly, via a symlink inside the project pointing outside, via `python -c`/a Python script file, or via a node script; with network off, a loopback connect from inside the sandbox fails; ignored escape vectors (writes to project cwd, OS temp, configured cache roots) succeed; the self-test gates `available` status and a deliberately-broken profile makes the executor report `unavailable` rather than running unconfined; the sandboxed child does not inherit the full parent environment; the wrapper implements `BashOperations` and passes the existing bash tool test suite unchanged when sandboxing is off.
**Status (2026-08-19):** Implemented and committed as `partial`. Every acceptance escape vector is confined and the self-test gate is sound, but an adversarial review found 6 CRITICAL escapes that are NOT implementation bugs — they follow directly from the policy this phase's own requirement mandates. The code is dormant (the wrapper requires `enabled: true`; nothing wires it in yet).
**BLOCKING FINDING — the R44-SBX.2 threat model is incoherent as written:** the write allowlist is itself the escape surface. Anything writable that an *unsandboxed* process later reads or executes is a full escape, and R44-SBX.2 mandates writing to the project cwd, the OS temp dir, and cache roots, with network on by default. Demonstrated escapes, each reproduced end to end:
- `.git/config`, `.git/hooks/` and `.claude/settings.json` live in the writable project tree; a config-only change makes the next *unsandboxed* `git status` execute arbitrary code.
- `$TMPDIR` is on `PATH`, so a confined command plants a binary that the user's next unsandboxed shell runs.
- Unix sockets of unsandboxed daemons live in `$TMPDIR` (20 found live on the dev host, incl. Chromium/Electron singleton sockets and a .NET diagnostics endpoint whose protocol includes assembly load).
- `~/.npm/_cacache` poisoning: the `integrity` value npm verifies against is a field of the same attacker-written index entry.
- `~/.cargo/registry` tampering: `.cargo-checksum.json` does not exist in the extracted src tree on cargo 1.95, so nothing re-hashes it.
- Loopback TCP reaches unsandboxed local services — and the R44-SBX.4 self-test *requires* a loopback connect to succeed, so the probe depends on the hole.
- `sysctl KERN_PROCARGS2` under `(allow sysctl-read)` returns full argv AND environment of every same-uid process (744 readable on the dev host), defeating `env.ts` entirely.
**Residual (usability — deny-by-default needs a curated allow set that was never specified):** `fs.watch` is dead (FSEvents denied — breaks every watch-mode workflow), macOS Keychain is denied (breaks authenticated git-over-HTTPS and `gh`; this repo uses `credential.helper=osxkeychain`), the JVM toolchain is dead (`sysctl-write`), plus `pbcopy`/`pbpaste`, `npx --yes`, and `pip install` over TLS. Root causes are pinned to exact `global-name` entries.
**Next step is a spec decision, not more code:** revise R44-SBX.2's threat model — e.g. confine to a copied worktree rather than the live project, exclude `.git/` and `.claude/`, use a session-private temp instead of shared `$TMPDIR` (which also closes the PATH and socket routes), drop or read-only the cache roots, and reconsider network-on-by-default together with the self-test probe.

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

## Phase 47: Canonical Skill Source & Generated Artifacts — `partial`
**Goal:** Repo-root `skills/` is the provider-neutral Agent Skills source of truth (10 disciplines + 17 self-contained workflow skills + new `draht` umbrella skill), and the Claude/Codex plugin skill+command content is generated from it through a dialect table with byte-equality drift gates — hand-mirroring and the tolerance-based mirror check retire.
**Requirements:** R47-SKL.1, R47-SKL.2, R47-SKL.3, R47-SKL.4, R47-SKL.5, R47-SKL.6, R47-SKL.7
**Acceptance:** Canonical tree passes native Agent Skills spec validation (closed frontmatter key set, name==dirname, description ≤1024, flat metadata) plus portability lint (no out-of-dir refs, no plugin-root tokens, no host-dialect markers outside an explicit allowlist) and the ≤500-line size gate; regenerating twice is byte-identical and regenerated output equals the committed plugin-package files (`check:skills-artifacts` green in `npm run check` and both plugin `prepublishOnly` scripts); regenerated Claude artifacts are byte-identical to the pre-migration committed files while Codex diffs are exactly the 17 wrapper self-containment rewrites (+ in-dir `command.md`) and both packages gain `skills/draht/`; a native reimplementation of the skills-CLI priority walk over this repo yields exactly the canonical catalog; a generated Codex wrapper dir copied alone to a temp dir resolves its `./command.md` reference; `check-plugin-mirrors.mjs` reduced to agents/-only still passes.
**Residual (2026-08-18 reconciliation):** R47-SKL.7 (README truth) unmet in both plugin READMEs; the `draht` router skill catalog is stale (says "9 discipline skills", omits saga-spawner). Everything else green: 28-skill canonical tree, generator byte-compared against committed artifacts, drift gate in `npm run check` + both prepublishOnly, 670/670 skills tests.

## Phase 48: Install Engine Core — `complete`
**Goal:** `@draht/install` exists as a workspace package with the transactional core: schema-versioned hash-manifested state, append-only JSONL journal, pure plan engine, staged executor with backup/rollback and crash detection — all filesystem-hermetic under test.
**Requirements:** R48-ENG.1, R48-ENG.2, R48-ENG.3, R48-ENG.4, R48-ENG.5, R48-ENG.6
**Acceptance:** `packages/install` builds in the root build chain and passes `npm run check` (root tsconfig exclude added only if the check demands it — the Phase 31/33/35b trap is `bun:test`-specific; vitest precedents `rlm`/`rlm-agent` needed none); state writes survive subprocess SIGKILL injection with old-or-new-never-torn proven by test; plan is pure and deterministic over fixture states (fresh/upgrade/no-op/drift/downgrade-blocked/remove-under-prune); executor fault injection at every checkpoint boundary restores the pre-apply tree byte-identically with `state.json` untouched and a `rolled-back` journal record; double-apply yields an empty second plan; journal reader tolerates a torn final line and open transactions are detectable.

## Phase 49: Component Sources, Detection & Adapters — `complete`
**Goal:** The engine resolves real components from a registry client per channel, fetches and integrity-verifies tarballs into the cache, detects the host environment, and drives claude-plugin / codex-plugin / global-cli adapters — hermetically, against fixture registries and stub host CLIs.
**Requirements:** R49-SRC.1, R49-SRC.2, R49-SRC.3, R49-SRC.4, R49-SRC.5, R49-SRC.6, R49-SRC.7
**Acceptance:** Channel resolution honors dist-tags with `latest` the only accepted channel (`next` refused with the honest frozen-tag message) and downgrades never applied silently; tarball acquisition verifies registry-served ssri integrity and caches by integrity hash with offline cache hits; the claude adapter reproduces the verified `draht-claude/cli.mjs` registration call sequence against a recording stub `claude` (validate → marketplace add → marketplace update → [force: uninstall] → install --scope user → enable) with every staged file manifest-tracked, and uninstall verifies host deregistration before local deletion; same for codex (marketplace add → [force: remove] → add); the global-cli adapter delegates to a stub package manager, records the delegation, and reports honest failure; detection distinguishes claude/codex presence, the legacy `~/.draht/.git` clone, the `~/.local/bin/draht` wrapper, and `~/.pi` legacy state on fixture homes; no test touches the live registry.

## Phase 50: CLI Surface & Contracts — `partial`
**Goal:** Bins `draht-install` and `draht-init` (single entry, basename dispatch) expose plan/install/status/doctor/update/uninstall with the locked flag set, stable `--json` schemas, non-interactive rules, exit codes, and the doctor catalogue; `draht-init` ensures components then scaffolds `.planning/` by subprocess-invoking the bundled `draht-tools` bin and hands off to the agent.
**Requirements:** R50-CLI.1, R50-CLI.2, R50-CLI.3, R50-CLI.4, R50-CLI.5, R50-CLI.6, R50-CLI.7, R50-CLI.8
**Acceptance:** Every verb runs against a fixture HOME via `DRAHT_INSTALL_DIR` in CLI integration tests; `--json` outputs validate against checked-in schemas (`schemaVersion` present) and `install --json` emits NDJSON events; mutating verbs without a TTY and without `--yes` exit non-zero with guidance while plan/status/doctor never prompt; documented exit codes (0 ok, 1 error, 2 changes-pending on plan/`status --check`, 3 partial/blocked incl. `--fail-on-empty` empty-profile) gate a simulated CI run; the doctor catalogue implements the spec's v1 checks each with id/severity/repairable; `draht-init` on an empty fixture project produces the `.planning/` scaffold via `draht-tools` and prints the agent handoff, refusing to clobber an existing scaffold without `--force`; a guard test asserts no bin named `draht` exists in the package; help text disambiguates `draht install <source>` (extension manager) from `draht-install` (machine components).
**Residual (2026-08-18 reconciliation):** No `--json` schemas checked into the package and no snapshot tests; no help text disambiguates `draht install <source>` from `draht-install`. The CLI surface itself is production-e2e proven (18/18 e2e drive the packed binary through every verb).

## Phase 51: Release Integration, Docs & E2E — `partial`
**Goal:** The release pipeline stamps plugin manifests in lockstep (closing the live `2026.7.7-1` freeze) with a drift gate, CalVer becomes always-suffixed, `install.sh` gains the collision guard, docs tell the truth, and a hermetic end-to-end proves the full lifecycle byte-clean.
**Requirements:** R51-SHIP.1, R51-SHIP.2, R51-SHIP.3, R51-SHIP.4, R51-SHIP.5
**Acceptance:** A shared stamping module is called by both `release.mjs` and `sync-versions.js`, both plugin manifests read the lockstep version, and `check-draht-customizations.mjs` fails on manifest/package version drift; `computeVersion` emits only `YYYY.M.D-N` (first-of-day `-1`) with the transition edge pinned by test; `install.sh` refuses a non-empty non-git `~/.draht` with actionable guidance; engine/plugin READMEs and `docs/releasing.md` reflect reality and CHANGELOGs carry the entries; an e2e test packs `@draht/install`, installs from the tarball into a sandbox HOME with stub `claude`/`codex`, and drives plan→install→status (clean)→injected drift→doctor→uninstall to a byte-clean home with zero live-registry access.
**Residual (2026-08-18 reconciliation):** `install.sh` has no non-empty-non-git `~/.draht` guard; plugin README skill lists are stale (4 and 7 listed vs 12 shipped); no plugin CHANGELOG entries for the lockstep fix. Everything else is production-e2e proven (18/18 packed-tarball lifecycle, CalVer + manifest lockstep).

## Phase 52: Publish, Launchers & Bootstrap — `pending`
**Goal:** The product goes public: unscoped launcher packages ship, the registry is cleaned up, `install.sh` becomes a thin npx bootstrap, and the live catalog is verified — everything that requires npm/GitHub write access, gated on the §6 branch-family reconciliation.
**Requirements:** R52-PUB.1, R52-PUB.2, R52-PUB.3, R52-PUB.4, R52-PUB.5
**Acceptance:** Unscoped `draht-install`/`draht-init`/`create-draht` launchers (bin stub + docs only, `workspace:*`-pinned to `@draht/install`) publish through the lockstep pipeline with `npm pack` content assertions; `check-draht-customizations.mjs` enforces the structural duplicate-bin rule; `install.sh` execs `npx draht-install@latest` with no clone/reset/rc-append; the frozen `@draht/coding-agent@next` dist-tag is remediated and the unscoped names are claimed; a post-publish smoke (`npx draht-install@latest plan` in a clean container) and a live `skills add draht-dev/draht --list` catalog check pass; the `fix/final-*`/`fix/review-*` branch family is reconciled before any of this executes.
