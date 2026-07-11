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

`@draht/tools` (canonical GSD CLI source), `draht-claude` & `draht-codex` (plugin wrappers mirroring tools/agents/skills), `@draht/templates` (AGENTS.md library), `@draht/workflows` (n8n templates). Packaging/distribution shells, not domain logic.

### Tier F — geist (spatial ADE, harness-independent)

A deliberately separate product living in this monorepo (Milestone 4; source: `.planning/specs/geist-spec.md`). Point a Quest 3 ray at a running app or an ACP coding-agent session and talk to it. Boundary-enforced: only `draht-acp` may import `@draht/*` — everything else in this tier is harness-agnostic by construction.

- **geist** (`packages/geist/`) — CLI + composition root; wires `geist-core` + `geist-acp` + `geist-console` together.
- **geist-core** (`packages/geist-core/`) — harness-free product logic: sessions, project registry, worktree/port manager, sha ledger, variants, composer, git ops, the `HarnessSession` port interface. Imports no `@draht/*`.
- **geist-acp** (`packages/geist-acp/`) — the only code that knows ACP wire shapes: JSON-RPC 2.0 client, subprocess lifecycle per session, capability handshake, event/permission/cancel normalization into the `HarnessSession` port.
- **draht-acp** (`packages/draht-acp/`) — thin ACP shim wrapping `@draht/coding-agent`; the single permitted door from the geist tier into `@draht/*`. Also usable standalone by Zed/JetBrains.
- **geist-protocol** (`packages/geist-protocol/`) — shared wire types (WS protocol, `geist.yaml` config schema) consumed by bridge and headset alike.
- **geist-picker** (`packages/geist-picker/`) — IIFE injected into target pages for element hover/highlight/crop.
- **geist-console** (`packages/geist-console/`) — React `/ui`, styled from `tokens.css` (geist glass design tokens).
- **quest/** — Kotlin, Meta Spatial SDK headset app. Not an npm workspace; talks to the bridge over WS only. Never composes prompts or speaks ACP directly.

## Context Map

- **Shared Kernel**: `@draht/ai` (types/vocabulary) and `@draht/tui` (rendering) — depended on across kernel and business tiers without translation.
- **Upstream → Downstream**: `ai` → `agent-core` → `coding-agent` is a clean supply chain; each layer knows only the one below.
- **Open-Host Service**: `coding-agent` is upstream host to seven downstream business contexts (router, orchestrator, knowledge, invoice, compliance, deploy-guardian, mom) via the Extension pattern (`src/extension.ts` per package). Downstream contexts are conformist to coding-agent but isolated from each other.
- **Anti-Corruption Layers**: `invoice` wraps Lexoffice + Toggl (`lexoffice.ts`, `toggl.ts`); `mom` wraps Slack (`slack.ts`); `pods` wraps SSH/vLLM; `ci` wraps the GitHub API; `ai/src/api/*` are per-provider ACLs translating vendor wire formats into shared message types.
- **GSD → Coding Agent**: GSD commands are registered in the coding agent extension system. GSD state lives in `.planning/`.
- **GSD → Git**: GSD commit operations call git directly (execSync). No abstraction layer.
- **Distribution mirrors** (not runtime coupling): `draht-claude`/`draht-codex` mirror `@draht/tools` content; enforced by `scripts/check-plugin-mirrors.mjs`.
- **Separate Ways, by design**: the geist tier and the draht kernel/business tiers share no code and no vocabulary except through `draht-acp`. `scripts/check-geist-boundary.mjs` (the geist analogue of `check-plugin-mirrors.mjs`) fails root `check` if that rule is violated.
- **Anti-Corruption Layer**: `draht-acp` translates `@draht/coding-agent`'s Session/Turn/Tool vocabulary into ACP wire shapes — geist-core never sees a draht type.
- **Open-Host Service**: `geist-acp`'s `HarnessSession` port is upstream to any ACP-speaking launch spec (`draht-acp`, `claude-agent-acp`, `codex-acp`, native-ACP `gemini`, …) — all are conformist adapters behind one port.
- **geist-core ⇄ quest/**: WS only, LAN, token-paired. Kotlin never composes prompts; the bridge never renders or speaks ACP directly — three strict responsibilities per spec §7.

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
- **Variant** — geist-core: one sibling worktree in a `variants n` comparison; carries its own harness, its own sha ledger entry, winner/pruned status.
- **ShaLedger entry** — geist-core: `{baseSha, lastApprovedSha}` per session; the substrate for approve/undo (`reset --hard <ref>`).
- **PermissionRequest / PermissionOption** — geist-acp: an ACP permission ask, rendered as chips, resolved by `allow`/`deny` (voice or tap).
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
- **PermissionRequested / PermissionAnswered** — a `HarnessSession` asked for tool permission; resolved by allow/deny.
- **VariantWinnerPicked** — a `variants n` comparison closed; the winning Variant's sha becomes the session's, siblings reset to `baseSha` and are pruned.

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
| Sha ledger | geist | Per-session `{baseSha, lastApprovedSha}`; approve/undo = `reset --hard <ref>`. |
| awaiting_review | geist | Session status once a turn ends AND git is dirty/ahead — git is the truth, not the agent's claim. |
| Variant | geist | One sibling worktree in a `variants n` comparison; may carry its own harness. |
| room-glass / content-glass | geist | The two-material design system (spec §13): opaque/alpha-smoke panel chrome vs. full blur+refraction inside panels — split because Quest cannot sample passthrough. |
| Target ring | geist | The signature UI element: the picker's element highlight, refracting the app's own pixels, condensing into the frozen-target crop chip on PTT press. |

## Concerns (inferred, for later confirmation)

- **`coding-agent` is a god-context**: `src/index.ts` (114 dependents) mixes extension-host platform API, the interactive TUI application, session persistence, the tool suite, and the GSD planning sub-domain. GSD is the clearest extraction candidate.
- **Duplicated vocabulary across kernels**: `ThinkingLevel`, `Session`, and `SessionManager`/`EventBus` are independently redeclared in multiple packages (ai/agent-core; coding-agent/gateway; gateway/mom) rather than sharing one definition.
- **Cross-cluster test bridges**: `ai/test` reaches into `coding-agent/src/core/auth-storage.ts`, and `coding-agent/test` reaches into `ai/src/api/openai-codex-responses.ts` — test-only coupling between the two kernels that would complicate a clean split.
- **Vendored code pollutes domain extraction**: `packages/landing/.sst/platform/**` contributed false "entities" to the auto-generated glossary before manual filtering; recommend `map-codebase` ignore `**/.sst/**`, `**/.astro/**`, `**/dist/**`.
- **GSD kernel is triplicated by copy, not import**: `@draht/tools` is the canonical GSD source, mirrored into `draht-claude`, `draht-codex`, and re-implemented in `coding-agent/src/gsd/`. Kept in sync only by `scripts/check-plugin-mirrors.mjs`/`scripts/sync-draht-tools.mjs` — a standing consistency hazard rather than a real shared kernel (inferred; see also prior memory notes on sync/lint gotchas for this area).
