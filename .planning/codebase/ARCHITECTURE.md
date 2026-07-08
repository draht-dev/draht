# Architecture

Generated: 2026-07-08 · Filled in during `/map-codebase`. Full detail in `.planning/DOMAIN.md` and `.planning/codebase/GRAPH_REPORT.md`.

## Directory / Module Layout

npm workspaces monorepo (`packages/*`, 22 packages) organized into four architectural tiers — see `.planning/DOMAIN.md` for the full bounded-context breakdown:

1. **Platform kernel** — `ai`, `agent`(agent-core), `coding-agent`, `tui`. `ai/src/types.ts` is the most-imported module in the repo (88 dependents); `coding-agent/src/index.ts` is the largest hub (114 dependents).
2. **GSD sub-domain** — `coding-agent/src/gsd/`, nested inside the coding-agent package rather than a standalone workspace.
3. **Business-capability extensions** — `router`, `orchestrator`, `knowledge`, `invoice`, `compliance`, `deploy-guardian`, `ci`. Each has a `src/extension.ts` that registers into `coding-agent`'s Extension API.
4. **Delivery/edge + distribution** — `mom`, `gateway`, `web-ui`, `landing`, `pods`, `infra` (edge); `draht-tools`, `draht-claude`, `draht-codex`, `templates`, `workflows` (packaging/distribution, largely non-domain).

Per-package convention: `src/` for implementation, `test/` for tests (one outlier: `gateway` uses `src/__tests__/`), `dist/` for build output, `docs/` for package-local docs where present.

## Data Flow

```
LLM providers (Anthropic, OpenAI, Bedrock, ...)
        │  per-provider wire-protocol translation
        ▼
   @draht/ai            (Provider, Model, message/content types — shared kernel)
        │
        ▼
@draht/agent-core        (AgentLoop: turn management, tool-call orchestration)
        │
        ▼
@draht/coding-agent       (Session, Tool suite, Skills, Trust; extension host)
        │  Extension API (src/extension.ts per package)
        ├──▶ router          (model selection, cost tracking)
        ├──▶ orchestrator    (multi-agent task decomposition)
        ├──▶ knowledge       (per-client vector DB)
        ├──▶ invoice         (Lexoffice + Toggl → Invoice)
        ├──▶ compliance      (GDPR / EU AI Act scanning)
        ├──▶ deploy-guardian (pre-deploy checks, rollback)
        └──▶ ci              (GitHub PR review action)

Entry points into coding-agent:
  mom (Slack) ──▶ coding-agent (sandboxed session)
  gateway (long-running process/session server) ──▶ coding-agent
  web-ui (browser chat, IndexedDB) ──▶ @draht/ai directly (does not go through coding-agent)
```

`@draht/tui` is a second shared kernel (terminal rendering), consumed directly by both `coding-agent` and `web-ui`.

## Module Boundaries

- Business-capability extensions (tier 3) **do not import each other** — confirmed no cross-imports. Each is conformist to `coding-agent`'s Extension API only (Open-Host Service pattern), keeping the seven capabilities isolated.
- Anti-corruption layers exist at every external-service boundary: `invoice/src/{lexoffice,toggl}.ts`, `mom/src/slack.ts`, `pods` (SSH/vLLM), `ci` (GitHub API), `ai/src/api/*` (per-LLM-provider wire format translation).
- **Known boundary leak**: test-only imports cross the kernel split — `ai/test` reaches into `coding-agent/src/core/auth-storage.ts`, and `coding-agent/test` reaches into `ai/src/api/openai-codex-responses.ts`. This doesn't affect runtime but would complicate extracting either package standalone.
- `draht-claude` and `draht-codex` mirror `@draht/tools` (GSD CLI) content into plugin-specific formats; this is enforced by `scripts/check-plugin-mirrors.mjs` as a packaging invariant, not a runtime dependency.

## Infrastructure Deployment Shape

- `packages/infra` — SST v4 targeting AWS (Lambda, API Gateway, DynamoDB).
- `packages/landing` — SST v4 targeting Cloudflare (Workers, D1, KV), Astro for the site itself. Vendored SST platform code lives at `packages/landing/.sst/platform/` (not draht's own code — exclude from domain/architecture analysis).
