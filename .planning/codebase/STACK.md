# Technology Stack

Generated: 2026-07-08 · Filled in during `/map-codebase`.

## Language & Runtime

- **TypeScript** everywhere (`^5.9.3`), `strict: true`, target `ES2022`, module/resolution `Node16`, decorators enabled (`tsconfig.base.json`). `@typescript/native-preview` (`tsgo`) is used for fast `--noEmit` type checking in the `check` script, alongside the standard `tsc` build.
- **Node.js** `>=20.0.0` is the declared engine; **Bun** (`1.4.0-canary.1` observed) is used as the install/script/test runtime for several packages — the repo runs on both, not one exclusively (see below).
- ESM throughout (`"type": "module"` at the root).

## Package Management & Monorepo

- **npm workspaces** is the authoritative workspace mechanism (root `package.json` → `workspaces: ["packages/*", ...example extension dirs]`). 22 packages under `packages/*` plus several example-extension workspaces under `packages/coding-agent/examples/extensions/*`.
- A `bun.lock` also exists alongside `package-lock.json` — Bun is used to run scripts/tests fast, but npm workspaces remains the dependency-resolution source of truth.

## Build & Dev Tooling

- **esbuild** (`^0.28.1`) for bundling; **tsx** (`^4.23.0`) for running TypeScript scripts directly in dev.
- Root `build` script builds packages in explicit dependency order: `tui → ai → agent → coding-agent → mom → web-ui → pods`.
- **Biome** (`2.3.5`) is the sole linter/formatter (no ESLint/Prettier) — see CONVENTIONS.md for the configured rules.
- **Husky** (`^9.1.7`) runs a `pre-commit` hook that executes `npm run check` (Biome + `tsgo --noEmit` + browser-smoke check + plugin-mirror check + draht-tools sync check) and restages formatted files.
- Custom release tooling: `scripts/sync-versions.js`, `scripts/release.mjs` — calendar-style versioning observed at the root (`2026.7.7-1`).

## Testing

Split between **Vitest** (`3.2.4`) and **Bun test** across packages, with no coverage instrumentation anywhere. Full breakdown in `.planning/TEST-STRATEGY.md`.

## Infrastructure & Deployment

- **SST v4** — Infrastructure-as-Code for two targets: `packages/infra` (AWS: Lambda, API Gateway, DynamoDB) and `packages/landing` (Cloudflare, via vendored `.sst/platform`). Per project constraints, `sst deploy` is never run during development.
- **Astro** is the framework for `packages/landing` (the marketing site), per project constraints (not Next.js).

## Core Domain Stack (draht's own libraries, not third-party frameworks)

- `@draht/ai` — hand-rolled unified LLM provider gateway (no LangChain/Vercel AI SDK — all ~40 provider integrations are first-party).
- `@draht/agent-core` — provider-agnostic agent loop.
- `@draht/tui` — first-party terminal rendering library (no external TUI framework like Ink/blessed).
- `@draht/coding-agent` — the application built on the above; extension host for all business-capability packages.

## Key Dependencies (root)

- `@mariozechner/jiti` — runtime TS loading.
- `koffi` — native FFI bindings (used by `packages/tui/native`).
- `@anthropic-ai/sandbox-runtime` (dev) — sandboxed execution, used by `coding-agent`/`mom` for isolated sessions.

## External Service Integrations (ACL boundaries)

- **Lexoffice** + **Toggl** — `packages/invoice` (accounting + time tracking).
- **Slack** — `packages/mom`.
- **GitHub** — `packages/ci`.
- **SSH / vLLM** — `packages/pods`.
- ~40 LLM providers (Anthropic, OpenAI, Google, Bedrock, xAI, Mistral, Cerebras, and China-region providers) — `packages/ai/src/api/*`.
