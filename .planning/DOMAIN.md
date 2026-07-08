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

## Context Map

- **Shared Kernel**: `@draht/ai` (types/vocabulary) and `@draht/tui` (rendering) — depended on across kernel and business tiers without translation.
- **Upstream → Downstream**: `ai` → `agent-core` → `coding-agent` is a clean supply chain; each layer knows only the one below.
- **Open-Host Service**: `coding-agent` is upstream host to seven downstream business contexts (router, orchestrator, knowledge, invoice, compliance, deploy-guardian, mom) via the Extension pattern (`src/extension.ts` per package). Downstream contexts are conformist to coding-agent but isolated from each other.
- **Anti-Corruption Layers**: `invoice` wraps Lexoffice + Toggl (`lexoffice.ts`, `toggl.ts`); `mom` wraps Slack (`slack.ts`); `pods` wraps SSH/vLLM; `ci` wraps the GitHub API; `ai/src/api/*` are per-provider ACLs translating vendor wire formats into shared message types.
- **GSD → Coding Agent**: GSD commands are registered in the coding agent extension system. GSD state lives in `.planning/`.
- **GSD → Git**: GSD commit operations call git directly (execSync). No abstraction layer.
- **Distribution mirrors** (not runtime coupling): `draht-claude`/`draht-codex` mirror `@draht/tools` content; enforced by `scripts/check-plugin-mirrors.mjs`.

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

## Domain Events

- **TaskExecuted** — a task was run (pass/fail/skip). Logged to execution-log.jsonl.
- **TDDViolation** — a "green:" commit was made without a preceding "red:" commit for the same task.
- **PhaseComplete** — all plans in a phase have summaries and verification passes.

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

## Concerns (inferred, for later confirmation)

- **`coding-agent` is a god-context**: `src/index.ts` (114 dependents) mixes extension-host platform API, the interactive TUI application, session persistence, the tool suite, and the GSD planning sub-domain. GSD is the clearest extraction candidate.
- **Duplicated vocabulary across kernels**: `ThinkingLevel`, `Session`, and `SessionManager`/`EventBus` are independently redeclared in multiple packages (ai/agent-core; coding-agent/gateway; gateway/mom) rather than sharing one definition.
- **Cross-cluster test bridges**: `ai/test` reaches into `coding-agent/src/core/auth-storage.ts`, and `coding-agent/test` reaches into `ai/src/api/openai-codex-responses.ts` — test-only coupling between the two kernels that would complicate a clean split.
- **Vendored code pollutes domain extraction**: `packages/landing/.sst/platform/**` contributed false "entities" to the auto-generated glossary before manual filtering; recommend `map-codebase` ignore `**/.sst/**`, `**/.astro/**`, `**/dist/**`.
