# Domain Model

_Inferred from code via `/map-codebase` on 2026-07-08. Bounded contexts, relationships, and glossary below are inferred from directory structure, package.json descriptions, and type definitions — not confirmed by the user. Items marked `(inferred)` should be confirmed rather than built upon._

## Bounded Contexts

The monorepo has 22 workspace packages, clustering into four tiers. Package boundaries are unusually clean: business capabilities plug into the platform via a formal Extension interface rather than reaching into each other's internals.

### Tier A — Platform Kernel

- **AI Provider Gateway** (`@draht/ai`) — Unified LLM API normalizing ~40 providers (Anthropic, OpenAI, Google, Bedrock, xAI, Mistral, Cerebras, and China-region providers) behind one streaming interface. Owns model discovery, provider auth/OAuth, and the canonical message/content type system. `src/types.ts` is the single most depended-on module in the repo (88 dependents) — a shared kernel.
- **Agent Core** (`@draht/agent-core`) — Provider-agnostic agent loop: turn management, tool-call orchestration (sequential/parallel), state, attachments, compaction. Transport-abstracted. Depends only on `@draht/ai`.
- **Coding Agent** (`@draht/coding-agent`) — The flagship application and de-facto extension host. Owns interactive TUI mode, RPC/print modes, session lifecycle, the built-in tool suite (read/write/edit/bash/grep/find/ls), skills, slash-commands, trust/permissions, and the GSD sub-domain. `src/index.ts` has 114 dependents — a god-node (inferred; see Concerns below).
- **Terminal UI** (`@draht/tui`) — Generic terminal rendering library with differential rendering. Pure infrastructure, no domain knowledge. Consumed by coding-agent and web-ui — a second shared kernel.

### Tier B — GSD Sub-domain (nested inside Coding Agent)

- **GSD (Get Shit Done)** (`coding-agent/src/gsd/`) — Structured AI-assisted development lifecycle: codebase mapping, domain-model generation, planning-doc discovery, phase verification, git integration, hook utilities. This is the sub-domain generating this very file. Its vocabulary (Plan, Phase, Task, ExecutionLog) is unrelated to coding-agent's runtime vocabulary (Session, Tool, Trust) — a candidate for extraction into its own package `(inferred)`.

### Tier C — Business Capability Contexts (extension plug-ins)

Each imports `@draht/coding-agent`'s Extension API and registers tools/hooks. None depend on one another — confirmed no cross-imports.

- **Model Routing** (`@draht/router`) — Role-based model selection with auto-fallback and cost tracking.
- **Multi-Agent Orchestration** (`@draht/orchestrator`) — GSD Controller pattern: decomposes a task into typed sub-agents and coordinates execution.
- **Client Knowledge Base** (`@draht/knowledge`) — Per-client vector DB for knowledge persistence across projects.
- **Invoicing** (`@draht/invoice`) — Invoice generation integrating Lexoffice (accounting) + Toggl (time tracking).
- **Compliance** (`@draht/compliance`) — GDPR + EU AI Act scanning with German legal templates.
- **Deploy Guardian** (`@draht/deploy-guardian`) — Pre-deployment checks, rollback automation, SST safety.
- **CI Review Pipeline** (`@draht/ci`) — GitHub Action for Claude-powered PR reviews.

### Tier D — Delivery / Edge Contexts

- **Slack Gateway "mom"** (`@draht/mom`) — Slack bot delegating messages to the coding agent in a sandbox.
- **Session Gateway** (`@draht/gateway`) — Long-running session/process lifecycle server.
- **Web UI** (`@draht/web-ui`) — Browser chat components over `@draht/ai`, with IndexedDB persistence and a sandboxed iframe runtime.
- **Landing** (`@draht/landing`) — Astro marketing site for draht.dev (SST/Cloudflare deploy).
- **GPU Pods** (`@draht/pods`) — CLI managing vLLM deployments on GPU pods over SSH.
- **Infra** (`@draht/infra`) — SST v4 IaC (Lambda, API Gateway, DynamoDB).

### Tier E — Distribution / Tooling (support, non-domain)

`@draht/tools` (canonical GSD CLI source), `draht-claude` & `draht-codex` (plugin wrappers whose skill/command content is **generated** from the repo-root canonical `skills/` tree — Milestone 7 — with `agents/` still byte-synced), `@draht/install` (unified installer engine: transactional component management over hash-manifested state, bins `draht-install`/`draht-init`), `@draht/templates` (AGENTS.md library), `@draht/workflows` (n8n templates). Packaging/distribution shells, not domain logic. Vocabulary: see the Unified Distribution glossary rows and `.planning/specs/2026-08-12-unified-distribution-product.md`.

### Tier F — geist (spatial ADE, harness-independent; target architecture)

A deliberately separate product living in this monorepo (Milestone 4; source: `.planning/specs/geist-spec.md`). The target is to point a Quest 3 ray at a running app or ACP session and talk to it. The 2026-07-13 audit found this tier is not composed into a runnable product; see `.planning/geist/AUDIT-2026-07-13.md`. `geist`, `geist-core`, `geist-acp`, `geist-protocol`, `geist-picker`, and `geist-console` should import only non-privileged Geist-family packages, and only `draht-acp` may import the Draht kernel; the current boundary scope/allowlist still needs a focused fix.

- **geist** (`packages/geist/`) — target CLI/composition root. Current state: config-path helper, isolated pairing/voice helpers, stub CLI, and throwing `runGeist()`.
- **geist-core** (`packages/geist-core/`) — implemented harness-free domain primitives for project/fleet registries, grammar, ledger, variants, composer, and lanes. Worktree/port/dev-server composition is absent.
- **geist-acp** (`packages/geist-acp/`) — substantive ACP stdio client, capability handshake, subprocess session, events, permissions, and cancellation; not created by the production root.
- **draht-acp** (`packages/draht-acp/`) — substantive ACP shim over `@draht/coding-agent`, but blocked from release by project-trust and complete-tool-permission findings in `.planning/geist/SECURITY-2026-07-13.md`.
- **geist-protocol** (`packages/geist-protocol/`) — partial config and WS schemas. Core user-flow messages and Kotlin mirrors are absent.
- **geist-picker** (`packages/geist-picker/`) — currently a DOM element-description helper only; the target injected IIFE/hover/ring/freeze/crop runtime is absent.
- **geist-console** (`packages/geist-console/`) — currently a token-styled React wordmark; the target board/cards/chips/palette/lanes are absent.
- **quest/** — currently a conventional Kotlin/Android scaffold with pure ray math and no Meta Spatial SDK/WS/UI integration. The target headset app remains the locked architecture.

## Context Map

- **Shared Kernel**: `@draht/ai` (types/vocabulary) and `@draht/tui` (rendering) — depended on across kernel and business tiers without translation.
- **Upstream → Downstream**: `ai` → `agent-core` → `coding-agent` is a clean supply chain; each layer knows only the one below.
- **Open-Host Service**: `coding-agent` is upstream host to seven downstream business contexts (router, orchestrator, knowledge, invoice, compliance, deploy-guardian, mom) via the Extension pattern (`src/extension.ts` per package). Downstream contexts are conformist to coding-agent but isolated from each other.
- **Anti-Corruption Layers**: `invoice` wraps Lexoffice + Toggl (`lexoffice.ts`, `toggl.ts`); `mom` wraps Slack (`slack.ts`); `pods` wraps SSH/vLLM; `ci` wraps the GitHub API; `ai/src/api/*` are per-provider ACLs translating vendor wire formats into shared message types.
- **GSD → Coding Agent**: GSD commands are registered in the coding agent extension system. GSD state lives in `.planning/`.
- **GSD → Git**: GSD commit operations call git directly (execSync). No abstraction layer.
- **Distribution mirrors** (not runtime coupling): `draht-claude`/`draht-codex` mirror `@draht/tools` content; enforced by `scripts/check-plugin-mirrors.mjs`.
- **Separate Ways, target boundary**: the Geist tier and Draht kernel should share no code/vocabulary except through `draht-acp`. Phase 31 must cover all six non-shim TypeScript packages, reject privileged-shim/kernel imports in each, and reject every `@draht/*` Quest reference.
- **Anti-Corruption Layer, implemented component**: `draht-acp` translates coding-agent Session/Turn/Tool vocabulary into ACP wire shapes; it is not yet safely composed into Geist.
- **Open-Host Service, implemented component**: `geist-acp` provides a `HarnessSession` adapter for ACP launch specs, currently reached by package tests rather than the production root.
- **geist-core ⇄ quest/, target relationship**: the intended boundary is a secure, typed headset protocol. No Kotlin WS client or protocol mirrors exist yet; plaintext LAN pairing is blocked by GSEC-04.

## Entities

- **Provider** — a concrete LLM vendor+endpoint (AI Gateway root aggregate).
- **AgentLoop** — one request-response-tool cycle owner (Agent Core root aggregate).
- **Session** — a persisted conversation/work unit (Coding Agent root; also redefined independently in `gateway` — see Concerns).
- **Phase** — a numbered milestone in the GSD roadmap. Has a slug, status (pending/in-progress/complete), and a directory of plans.
- **Plan** — a structured implementation guide within a phase. Has frontmatter (phase, plan, depends_on, must_haves) and task elements.
- **Task** — a single unit of work within a plan. Has type (auto/checkpoint:human-verify/checkpoint:decision), and structured XML: `<name>`, `<files>`, `<test>`, `<action>`, `<refactor>`, `<verify>`, `<done>`.
- **ExecutionLog** — JSONL audit trail of task executions with status (pass/fail/skip/tdd-violation).
- **Summary** — post-execution record of completed tasks, files changed, verification results.
- **Extension** — a TypeScript module registering commands, tools, or hooks into the coding agent.
- **RouterConfig / RoleConfig / ModelRef** — Model Routing aggregates.
- **TaskPlan / SubTask / SubTaskResult** — Orchestrator aggregates.
- **Client / VectorStore / Chunk** — Knowledge context aggregates.
- **Invoice / LineItem / TimeEntry** — Invoicing aggregates.
- **ComplianceReport / ComplianceFinding / PiiPattern** — Compliance aggregates.
- **HarnessSession** — geist-acp/geist-core root: one ACP subprocess session, its capability set, and its running/awaiting_review/stopped status.
- **Project / FleetRegistry** — geist-core: the registry of known projects (yaml ∪ workspaceRoots discovery ∪ recents) and the ≤4-session fleet spanning them.
- **Variant** — geist-core domain object for a comparison member. Current code assumes caller-provided sessions/worktrees; creation and physical winner selection are absent.
- **ShaLedger entry** — current `{baseSha, lastApprovedSha}` primitive. Its `reset --hard` semantics are release-blocked by GSEC-05 pending a full-state managed-worktree amendment.
- **PermissionRequest / PermissionOption** — implemented ACP pending-request data and relay. Chip rendering and voice/tap resolution are target behavior, not current UI.
- **ElementContext** — geist-core: the composed situation prompt for one element-pointed dispatch (spec §9.3).

## Value Objects

- **PhaseNumber** — positive integer, zero-padded to 2 digits.
- **PlanNumber** — positive integer within a phase, zero-padded to 2 digits.
- **TaskType** — `"auto" | "checkpoint:human-verify" | "checkpoint:decision"`.
- **TaskStatus** — `"pass" | "fail" | "skip" | "tdd-violation"`.
- **CommitHash** — Git SHA-1, 40-char hex string.
- **Timestamp** — ISO 8601 datetime string.
- **ThinkingLevel** — reasoning-effort control, `off`→`max`. Defined independently in both `ai/src/types.ts` and `agent-core/src/types.ts` with a slightly different union — not yet a single shared term (inferred; confirm which is canonical).
- **StopReason** — `stop | length | toolUse | error | aborted` (AI Gateway).
- **CacheRetention** — `none | short | long` (AI Gateway).

## Aggregates

- **Phase (root)** — Owns Plans, Summaries, Fix Plans, Verification. Transactional boundary for phase execution.
- **ExecutionLog (root)** — Append-only log entries. Never mutated, only appended.
- **Provider (root, AI Gateway)** — owns Models, StreamOptions, CredentialStore/OAuth token.
- **AgentLoop (root, Agent Core)** — owns AgentState → Turns → AgentTool invocations.
- **Session (root, Coding Agent)** — owns Messages → ToolCalls → ToolResults; Trust/Project is a separate small aggregate.
- **RouterConfig (root, Router)** — owns RoleConfig → ModelRef; CostEntry ledger.
- **TaskPlan (root, Orchestrator)** — owns SubTask → SubTaskResult; OrchestratorState.
- **Client (root, Knowledge)** — owns VectorStore → Chunk(+ChunkMetadata).
- **Invoice (root, Invoicing)** — owns LineItem; TimeEntry as inbound value from Toggl.
- **ComplianceReport (root, Compliance)** — owns ComplianceFinding; PiiPattern/AiDocRequirement as policy value objects.
- **ChannelStore (root, Mom)** — owns Channel → PendingMessage → SessionProcess.
- **GatewayLifecycle (root, Gateway)** — owns Session → ServerHandle.
- **FleetRegistry (root, geist-core)** — owns Project → HarnessSession → Variant; enforces the ≤4-session cap.
- **HarnessSession (root, geist-acp)** — owns the ACP subprocess, its capability handshake result, its ToolCallUpdate/PlanUpdate stream, and pending PermissionRequests.

## Domain Events

- **TaskExecuted** — a task was run (pass/fail/skip). Logged to execution-log.jsonl.
- **TDDViolation** — a "green:" commit was made without a preceding "red:" commit for the same task.
- **PhaseComplete** — all plans in a phase have summaries and verification passes.
- **TurnEnded** — an ACP session's turn completed; combined with a dirty/ahead git status this triggers `awaiting_review` (git is the truth, never the agent's own claim).
- **PermissionRequested / PermissionAnswered** — component-level ACP events; no production headset/UI route currently completes them.
- **VariantWinnerPicked** — domain-level event implemented over caller-provided entries; production fan-out, pointing, and worktree removal remain target behavior.

## Persistence Note

There are no SQL tables anywhere in the monorepo (inferred). State lives as: (a) filesystem/JSON session stores (coding-agent's SessionManager, mom's `store.ts`/`credential-store.ts`), (b) a VectorStore collection per client in `knowledge`, (c) browser IndexedDB stores in `web-ui` (sessions, settings, provider-keys, custom-providers). "Collections" mean vector-store namespaces or IndexedDB object stores, not database tables.

## Ubiquitous Language Glossary

| Term | Context | Definition |
|------|---------|------------|
| Provider | AI Gateway | A concrete LLM vendor+endpoint (`ProviderId`, `KnownProvider`). ~40 exist. |
| Api | AI Gateway | The wire protocol family a provider speaks (e.g. `anthropic-messages`, `openai-completions`, `bedrock-converse-stream`). |
| Model | AI Gateway | An addressable model within a provider (`ModelRef`). |
| Transport | AI Gateway | `sse \| websocket \| websocket-cached \| auto`. |
| AgentLoop / Turn | Agent Core | One request-response-tool cycle. |
| AgentTool | Agent Core | Tool contract with streaming partial results. |
| Session | Coding Agent / Gateway | A persisted conversation/work unit. Defined independently in two packages — not a single shared term (inferred, confirm canonical definition). |
| Tool | Coding Agent | Built-in capability: Read, Write, Edit, Bash, Grep, Find, Ls. |
| Skill / SlashCommand / Extension | Coding Agent | User-facing capability registration surfaces. |
| Trust / ProjectTrust | Coding Agent | Permission gate for a project directory. |
| Compaction | Coding Agent | History summarization to fit context. |
| Phase | GSD | A numbered milestone grouping related plans. Maps to a directory under `.planning/phases/`. |
| Plan | GSD | A structured implementation guide (Markdown + XML) for one cohesive slice of a phase. |
| Task | GSD | Smallest unit of work in a plan, with TDD structure: test → action → refactor. |
| Red commit | GSD/TDD | Commit with prefix "red:" containing only failing tests. |
| Green commit | GSD/TDD | Commit with prefix "green:" adding minimal implementation to make tests pass. |
| Refactor commit | GSD/TDD | Commit with prefix "refactor:" cleaning code while keeping tests green. |
| Summary | GSD | Markdown record written after a plan completes, capturing task outcomes and file changes. |
| Fix Plan | GSD | A FIX-PLAN.md created when a task fails repeatedly; targets a specific defect. |
| Execution log | GSD | `.planning/execution-log.jsonl` — append-only JSONL audit trail. |
| Quality gate | GSD | Post-task check running type checker and test suite to confirm code health. |
| Ubiquitous language | DDD | Shared vocabulary used by developers and domain experts, reflected in all identifiers. |
| Bounded context | DDD | An explicit boundary within which a domain model applies. |
| Hook | GSD | A Node.js script in `hooks/gsd/` that runs at lifecycle points (pre-execute, post-task, post-phase). |
| draht-tools | GSD | CLI binary providing GSD commands as a CJS script (`bin/draht-tools.cjs`). |
| GSD module | GSD | A TypeScript module in `src/gsd/` providing GSD operations as importable functions. |
| Role | Router | A named routing slot mapped to a model with fallbacks. |
| SubTask / TaskPlan / AgentType | Orchestrator | `research \| implement \| test \| review` sub-agent decomposition units. |
| Chunk / VectorStore / Client | Knowledge | Embeddings unit, store, and tenant. |
| Invoice / LineItem / TimeEntry | Invoicing | Sourced from Toggl (time) → Lexoffice (accounting). |
| ComplianceFinding / PiiPattern / AiDocRequirement / Severity | Compliance | GDPR + EU AI Act scanning terms. |
| Channel / PendingMessage / SandboxConfig | Mom | Slack delegation terms. |
| Pod / GPU | Pods | vLLM deployment targets. |
| ACP | geist | Agent Client Protocol — the LSP-for-agents standard (JSON-RPC 2.0 over stdio) that every geist harness speaks. |
| HarnessSession | geist | One ACP subprocess session and its capability set; the single port `geist-core` codes against. |
| Capability handshake | geist | Per-session ACP negotiation of `{images, commands, modes, resume}`; geist degrades per capability, never per harness name. |
| Addressee | geist | What a voice utterance targets: an element, an agent/session, or the fleet board — pointing is addressing. |
| Sha ledger | geist | Current per-session `{baseSha, lastApprovedSha}` primitive; rev 7's `reset --hard` undo is insufficient and blocked by GSEC-05. |
| awaiting_review | geist | Current ACP status based on a Git probe after turn end; GSEC-07 requires fail-closed exact-state review before it is a dependable gate. |
| Variant | geist | One sibling worktree in a `variants n` comparison; may carry its own harness. |
| room-glass / content-glass | geist | The two-material design system (spec §13): opaque/alpha-smoke panel chrome vs. full blur+refraction inside panels — split because Quest cannot sample passthrough. |
| Target ring | geist | Target signature UI from the spec; not implemented in the current picker/console/Quest code. |
| Drahtgeist mobile console | geist | The native phone presentation of the typed Geist fleet and session control plane; it never exposes a remote shell. |
| Aggregate Live Activity | geist / iOS | One temporary projection of all currently active Drahtgeist sessions into Dynamic Island, Lock Screen, and StandBy system surfaces. |
| Push coordinator | geist / iOS | A trusted APNs sender that receives only the redacted fleet projection required to update iPhone system surfaces while the app is suspended. |
| Component | Unified Distribution | An installable unit the engine manages (`claude-plugin`, `codex-plugin`, `coding-agent`, `installer`); registered as data in the component index, never as engine code. |
| Component index | Unified Distribution | Zod-validated data (`packages/install/src/components.json`) mapping component ids to kind/npmName/default-membership; the extensibility seam for future packages. |
| Adapter | Unified Distribution | The per-`kind` code seam that stages payloads and drives host registration (claude-plugin / codex-plugin / global-cli); the only place host specifics live. |
| Manifest (install state) | Unified Distribution | `~/.draht/install/state.json` — schema-versioned record of channel, profile, and per-component versions + per-file sha256; the answer to "what did draht write to this machine". |
| Journal | Unified Distribution | Append-only JSONL transaction log (`planned → staged → backed-up → swapped → registered → committed \| rolled-back`); crash recovery reads it, disk state remains the truth. |
| Plan / Apply | Unified Distribution | Pure diff of desired vs actual state producing typed actions; transactional execution of those actions with staging, backups, and rollback-on-failure. |
| Profile | Unified Distribution | Which components a run targets: detection-based default, `--full`, or explicit selectors. |
| Channel | Unified Distribution | npm dist-tag a component resolves through; `latest` only until the `next` pipeline is repaired (frozen-tag hazard). |
| Effectiveness | Unified Distribution | Honest per-host update semantics: `live \| after-reload \| next-session \| restart-required \| unknown` — never "all agents updated". |
| Canonical skill tree | Unified Distribution | Repo-root `skills/` — the provider-neutral Agent Skills source of truth the public catalog serves and the generator consumes. |
| Dialect table | Unified Distribution | Data-driven (canonical → Claude, Codex) span renderings the generator applies; the only permitted per-host divergence in generated artifacts. |
| Generated consumer | Unified Distribution | `packages/draht-claude`/`packages/draht-codex` skill+command content — committed build outputs equality-checked against regeneration (`check:skills-artifacts`), never hand-edited. |
| Launcher | Unified Distribution | A thin unscoped npm package (bin stub) exposing the engine for cold `npx`; publish-gated (Phase 52). |

## Concerns (inferred, for later confirmation)

- **`coding-agent` is a god-context**: `src/index.ts` (114 dependents) mixes extension-host platform API, the interactive TUI application, session persistence, the tool suite, and the GSD planning sub-domain. GSD is the clearest extraction candidate.
- **Duplicated vocabulary across kernels**: `ThinkingLevel`, `Session`, and `SessionManager`/`EventBus` are independently redeclared in multiple packages (ai/agent-core; coding-agent/gateway; gateway/mom) rather than sharing one definition.
- **Cross-cluster test bridges**: `ai/test` reaches into `coding-agent/src/core/auth-storage.ts`, and `coding-agent/test` reaches into `ai/src/api/openai-codex-responses.ts` — test-only coupling between the two kernels that would complicate a clean split.
- **Vendored code pollutes domain extraction**: `packages/landing/.sst/platform/**` contributed false "entities" to the auto-generated glossary before manual filtering; recommend `map-codebase` ignore `**/.sst/**`, `**/.astro/**`, `**/dist/**`.
- **GSD kernel is triplicated by copy, not import**: `@draht/tools` is the canonical GSD source, mirrored into `draht-claude`, `draht-codex`, and re-implemented in `coding-agent/src/gsd/`. Kept in sync only by `scripts/check-plugin-mirrors.mjs`/`scripts/sync-draht-tools.mjs` — a standing consistency hazard rather than a real shared kernel (inferred; see also prior memory notes on sync/lint gotchas for this area).
