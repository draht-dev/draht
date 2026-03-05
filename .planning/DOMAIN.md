# Domain Model

## Bounded Contexts

- **GSD (Get Shit Done)** — Structured AI-assisted development lifecycle. Manages phases, plans, tasks, and execution state.
- **Coding Agent** — The Pi-based interactive coding assistant. Loads extensions, provides commands, runs tools.
- **Extension System** — TypeScript extension loading and registration. Extensions add commands, tools, hooks.
- **Model Routing** — Selects and routes LLM API calls based on task type, cost, and provider availability.
- **Infrastructure** — SST v4 / AWS serverless resources (Lambda, API Gateway, DynamoDB).
- **Compliance** — DACH-specific invoice generation and EU AI Act compliance checking.

## Context Map

- **GSD → Coding Agent**: GSD commands are registered in the coding agent extension system. GSD state lives in `.planning/`.
- **Coding Agent → Extension System**: Agent discovers and loads `.draht/extensions/*.ts` at startup.
- **GSD → Git**: GSD commit operations call git directly (execSync). No abstraction layer.
- **Model Routing ← Coding Agent**: Agent uses model router to select provider per request.

## Entities

- **Phase** — A numbered milestone in the GSD roadmap. Has a slug, status (pending/in-progress/complete), and a directory of plans.
- **Plan** — A structured implementation guide within a phase. Has frontmatter (phase, plan, depends_on, must_haves) and task elements.
- **Task** — A single unit of work within a plan. Has type (auto/checkpoint:human-verify/checkpoint:decision), and structured XML: `<n>`, `<files>`, `<test>`, `<action>`, `<refactor>`, `<verify>`, `<done>`.
- **ExecutionLog** — JSONL audit trail of task executions with status (pass/fail/skip/tdd-violation).
- **Summary** — Post-execution record of completed tasks, files changed, verification results.
- **Extension** — A TypeScript module that registers commands, tools, or hooks into the coding agent.

## Value Objects

- **PhaseNumber** — Positive integer, zero-padded to 2 digits for file system use.
- **PlanNumber** — Positive integer within a phase, zero-padded to 2 digits.
- **TaskType** — "auto" | "checkpoint:human-verify" | "checkpoint:decision"
- **TaskStatus** — "pass" | "fail" | "skip" | "tdd-violation"
- **CommitHash** — Git SHA-1, 40-char hex string.
- **Timestamp** — ISO 8601 datetime string.

## Aggregates

- **Phase (root)** — Owns Plans, Summaries, Fix Plans, Verification. Transactional boundary for phase execution.
- **ExecutionLog (root)** — Append-only log entries. Never mutated, only appended.

## Domain Events

- **TaskExecuted** — A task was run (pass/fail/skip). Logged to execution-log.jsonl.
- **TDDViolation** — A "green:" commit was made without a preceding "red:" commit for the same task.
- **PhaseComplete** — All plans in a phase have summaries and verification passes.

## Ubiquitous Language Glossary

| Term | Context | Definition |
|------|---------|------------|
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
| Extension | Coding Agent | A TypeScript module in `.draht/extensions/` that registers commands/tools/hooks. |
| Hook | GSD | A Node.js script in `hooks/gsd/` that runs at lifecycle points (pre-execute, post-task, post-phase). |
| draht-tools | GSD | CLI binary providing GSD commands as a CJS script (`bin/draht-tools.cjs`). |
| GSD module | GSD | A TypeScript module in `src/gsd/` providing GSD operations as importable functions. |
