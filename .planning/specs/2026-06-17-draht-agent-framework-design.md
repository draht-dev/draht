# draht agent framework — Design Spec (v1)

- **Date:** 2026-06-17
- **Approver:** Oskar Freye (oskar@fr3n.tech)
- **Status:** ✅ Approved (design). A phased v1 implementation plan is being generated via multi-agent orchestration (`/draht:orchestrate`, ultracode).
- **Owner / maintainer / distributor:** draht-dev
- **Consumer #0 (dogfood):** fr3n
- **Name (locked 2026-06-17):** framework = **`platine`** (German: *circuit board* — draht is the wire, platine is the board you wire agents onto). Scope `@draht/*` (draht-dev-owned); CLI bin `platine`; headline package `@draht/platine`.
- **Next step:** `/new-project` (greenfield). Repo home TBD — see OQ5.

> One-line: **"eve is to Vercel as draht is to SST."** A greenfield, OSS, cloud-agnostic agent framework that deploys via a single SST/Pulumi component into any cloud — winning the four axes eve deliberately ignores.

---

## Context

Vercel launched **eve** — an open-source, file-based, durable agent framework ("Next.js for agents") — on **2026-06-17** (the day of this spec). It builds on Vercel's stack (AI SDK, AI Gateway, Workflow SDK, Sandbox, Chat SDK, Connect) and is Vercel-native.

fr3n already operates a **hosted, multi-tenant, no-code Agent Studio** (`packages/core/src/agent-studio/`, `infra/agent-studio.ts`, `apps/tech/.../agent-studio/`): a Bedrock tool-calling executor, a typed workflow-DAG engine, approval gates, quotas, circuit-breakers, an EventBridge trigger model, and 5 production playbooks. That system is **proof the concepts work** and a **design reference** — but it is tightly coupled to fr3n's tenant/DynamoDB model and is *not* the product here.

This project: **draht-dev builds a new, clean-room, minimalistic OSS agent framework** inspired by eve, distinct from it on four axes, with fr3n as the first consumer.

---

## Decisions log (locked — do not relitigate; design *within* these)

1. **Audience / ownership:** OSS product, **owned/maintained/distributed by draht-dev**; **fr3n is consumer #0** (dogfood). (Mirrors the eve↔Vercel relationship.)
2. **Wedges (all four = the north star, vs eve):** cloud-agnostic/self-hostable · typed-graph-first · multi-tenant-ready · playbook-equipped.
3. **Greenfield, clean-room, minimalistic.** Do **not** port/reuse agent-studio's code; it is reference + a future consumer only.
4. **Authoring = HYBRID:** markdown for instructions/skills (`agent.md`, `skills/*.md`) + TypeScript tools (`defineTool` w/ schema) + a **typed** TS workflow graph (`defineWorkflow((b)=>…)`) with **compile-time** node-IO inference (upstream output → downstream input) + an `sst.ts` adding the SST component. A future visual builder reads/writes the same artifacts.
5. **Deploy = a single SST component** (`draht.Agent` / `draht.Workflow`), a **Pulumi ComponentResource** underneath, that drops into any existing SST app (e.g. fr3n's `sst.config.ts`) and provisions on any cloud (AWS first). This is both the cloud-agnostic story and the **GTM wedge** (SST/Ion + their network as distribution partner — a door eve can't open).
6. **Runtime/durability (v1) = SERVERLESS:** Lambda + SQS + DynamoDB + EventBridge; state **checkpoints to storage** between steps; executor sits behind **one small `Runtime` interface** so a durable-execution engine (Temporal/Restate) can replace it in v2 with no rewrite. Checkpoint/resume across redeploys is a v1 requirement.
7. **Model layer = OUR OWN thin adapter** over provider SDKs (Anthropic + Bedrock for v1), behind a minimal `Model` interface. **No Vercel / no Vercel AI SDK anywhere** (independence + clean SST-partner narrative).
8. **Compilation:** authoring artifacts compile to a **Manifest** — a single **versioned, schema-validated, declarative** description (nodes/edges/triggers/channels/tools/resource-needs) consumed by **both** the SST component and the Runtime. A declarative manifest, **not** a heavy executable IR.
9. **Adapter seams (the agnosticism):** `Model`, `Storage`, `Runtime`, `Channel`, `EventBus`, `Tenancy`. v1 ships the **interfaces for all four wedges** but **implements** only: serverless runtime, single-tenant-default (multi-tenant via the `Tenancy` interface, not fully built), and **one** example playbook.

---

## 1. Goal & Non-Goals

**Goal.** A greenfield, minimalistic, OSS agent framework by draht-dev where a developer defines a production agent as *a small directory of files* (markdown instructions + skills, TypeScript tools, a typed TS workflow graph) and deploys it to **any cloud via one SST component** (Pulumi underneath). Differentiated from eve on the four wedge axes. fr3n is consumer #0.

**Non-goals (v1).**
- Not an extraction/refactor of agent-studio (clean-room; agent-studio is reference + a future consumer).
- No draht-hosted control plane / managed runtime (bring-your-own-cloud).
- No visual builder yet (typed-TS graph + files are the authoring surface).
- No per-agent sandbox/VM isolation yet (eve's Sandbox equivalent is v2).
- **No Vercel dependency anywhere.** Not locked to any single model provider or cloud.

---

## 2. User stories / observable truths

**OSS developer (external):** `npx draht init my-agent` → a 2-file agent + dev server; write `tools/refund.ts`, wire it in a typed `workflow.ts` where `b.pipe(trigger, agent)` autocompletes the agent's input from the trigger's output and **wiring mistakes fail `tsc`**; `draht dev` runs locally on my key with hot reload; `draht deploy` provisions to my AWS because I added `new draht.Agent(...)` to my `sst.config.ts` — durability, an approval queue, runs/observability, and channel delivery included, no infra written by me.

**fr3n / multi-tenant SaaS embedder (consumer #0):** add `draht.Agent` components to fr3n's existing `sst.config.ts` sharing its table/bus; agents are tenant-scoped via a `Tenancy` adapter (quotas/billing/isolation); install a parameterized, KB-scaffolded **playbook** → a working multi-step automation deploys.

**Acceptance (observable truths):**
1. A 2-file agent deploys to AWS via SST and answers on an HTTP channel — end-to-end.
2. A typed workflow with a wiring type-error fails `tsc`, not runtime — *the wedge is real.*
3. An in-flight run survives a Lambda cold redeploy mid-workflow and resumes from the last checkpoint — *durability.*
4. An approval-gated tool holds → surfaces in a queue → resumes on approve — *HITL.*
5. The cloud-agnostic seam is demonstrated (a non-AWS Pulumi target, even if documented/stubbed).
6. One real fr3n agent is re-expressed on the framework and deployed in fr3n's SST app — *dogfood gate.*

---

## 3. Domain model (bounded contexts + key nouns)

1. **Authoring** (design-time, pure): `Agent` (dir), `Tool`, `Skill`, `Workflow` (typed DAG of `Node` + `Edge`), `Trigger`, `Playbook`.
2. **Compilation** (build-time): artifacts → **Manifest** (the single declarative, versioned, schema-validated contract shared by the SST component and the Runtime).
3. **Provisioning** (deploy-time): the **SST component** (`draht.Agent` / `draht.Workflow`) reads the Manifest → Pulumi resources (function, queue, table, bus, schedule, route). Cloud-agnostic via provider abstraction.
4. **Runtime** (run-time): the **`Runtime`** interface executes a Workflow — agent tool-calling loop, transform/tool nodes, checkpoints, approval gates, events, channels. v1 impl = serverless.
5. **Tenancy & quotas** (cross-cutting adapter): `Tenant` / `Quota` / `Plan` — single-tenant default, multi-tenant when configured.

**Public surface:** `defineAgent()`, `defineWorkflow((b)=>…)` (typed `b.trigger<T>/agent/transform/tool/pipe/fanout/merge`), `defineTool({ input: schema, run })`, `defineTrigger()`, `definePlaybook()`. **Adapter seams:** `Model`, `Storage`, `Runtime`, `Channel`, `Tenancy`, `EventBus`.

---

## 4. Architecture sketch

```
AUTHORING (files)        →  COMPILE         →  PROVISION (SST/Pulumi)        →  RUNTIME (v1 = AWS serverless)
my-agent/                   draht build         sst.config.ts                    EventBridge ┐
  agent.md          ┐       ┌──────────┐        new draht.Agent('saver',{        Schedule ───┤
  skills/*.md       ├─────► │ Manifest │ ─────► manifest })  ──(Pulumi)──►       Webhook ────┼─► Queue ─► Executor λ
  tools/*.ts        │       │ nodes/   │             │                           HTTP/API ───┤        │
  workflow.ts (typed)┘      │ edges/   │             ▼                           Channel in ─┘        ▼
  sst.ts ─────────────────► │ triggers/│        λ + Queue + Table        ┌─────────────────────────────────┐
                            │ channels │        + Bus + Schedule + Route │ Runtime.execute(workflow, event) │
 ADAPTER SEAMS:             └──────────┘                                 │  topo-sort DAG                   │
  Model (Anthropic/Bedrock — no Vercel)                                  │  agent node → Model.loop(tools)  │
  Storage (DynamoDB v1)                                                  │  transform/tool nodes            │
  Runtime (serverless v1 → Temporal v2)                                  │  checkpoint→Storage each step    │
  Channel / Tenancy / EventBus                                          │  approval gate → hold/resume     │
                                                                         │  emit events → EventBus (chain)  │
                                                                         └─────────────────────────────────┘
```

**Flow:** trigger event → queue → `Runtime.execute(manifest.workflow, event)` → topo-sorted nodes; agent nodes run the `Model` tool-calling loop (approval + safety hook); **every completed node checkpoints to `Storage`**; on cold-start/redeploy the executor reloads the last checkpoint and resumes; outputs emit to `EventBus` (chaining with depth guard) and reply via `Channel`.

**Baked-in decisions:** Manifest-not-IR · one `Runtime` seam (serverless now → durable engine later, no rewrite) · adapters wherever a cloud/provider/tenant choice exists · typed graph via builder generics (`b.pipe(a,b)` constrains `b.input` to `a.output`).

---

## 5. v1 scope vs v2 / out-of-scope

**v1 — "deploy a typed agent to your own cloud via SST, durably":**
- **CLI:** `init`, `dev` (local + hot reload), `build` (→ Manifest), `deploy` (via SST), `runs`.
- **Authoring:** `agent.md`, `skills/*.md`, `tools/*.ts` (`defineTool` + schema), `workflow.ts` (`defineWorkflow`: trigger→agent→transform→tool, pipe + basic fan-out, fully typed).
- **SST component:** `draht.Agent` / `draht.Workflow` → Lambda + Queue + DynamoDB + EventBridge + HTTP route.
- **Runtime (serverless):** tool-calling loop, transform/tool nodes, **checkpoint/resume**, approval hold→queue→resume, event emit + chain-depth guard.
- **Adapters shipped:** `Model` (Anthropic + Bedrock), `Storage` (DynamoDB), `Channel` (HTTP/web + one chat), `EventBus` (EventBridge), `Runtime` (serverless), `Tenancy` (single-tenant default **+ the interface** for multi-tenant).
- **Obs/docs:** runs + checkpoints + cost persisted; quickstart; one playbook example.
- **Dogfood gate:** one real fr3n agent re-expressed on the framework, deployed in fr3n's SST app.

**v2+:** durable-engine `Runtime` (Temporal/Restate) · visual builder (same artifacts) · full multi-tenant adapter + playbook *library*/installer/KB scaffolding · per-agent sandbox · subagents/delegation · evals/test-suites · more channels/providers/clouds · non-AWS target proven in CI · SST-partnership launch artifacts.

**Out of scope (explicit):** a draht-hosted control plane/runtime · porting agent-studio's code / wholesale fr3n migration (incremental, agent-by-agent) · a Vercel deploy target.

---

## 6. Open questions & risks

**Risks:**
- **R1 — eve's launch-day distribution.** Don't out-feature eve; win the SST/cloud-agnostic/multi-tenant niche eve ignores, and lock the SST partnership early as the distribution wedge.
- **R2 — four wedges at once.** v1 ships the *seams* (adapters/interfaces) for all four but *implements* only serverless + single-tenant + one playbook; the wedges become real over v2 without rearchitecture.
- **R3 — hand-rolled durability correctness** (idempotency / exactly-once side effects). Mitigation: deterministic run keys, idempotent steps, terminal-status flush ordering (patterns proven in agent-studio's engine); the `Runtime` seam lets us swap to Temporal if DIY frays.
- **R4 — typed-graph DX complexity** (heavy generics → unreadable type errors kill typed builders). Mitigation: invest early in error ergonomics; cap inference depth; provide an untyped escape hatch.
- **R5 — "no Vercel" means we maintain provider streaming/tool-call quirks.** Mitigation: keep the `Model` interface tiny; start with 2 providers (Anthropic, Bedrock); community adds more.
- **R6 — Manifest drift** between SST component and Runtime. Mitigation: single versioned, schema-validated artifact both sides import.

**Open questions (non-blocking; resolve in `/new-project` / early design):**
- **OQ1** — ✅ Resolved: framework = **platine**; packages under the draht-dev-owned `@draht/*` scope; headline package `@draht/platine`; CLI bin `platine`. Prereq: confirm `@draht` npm org ownership/access before first publish.
- **OQ2** — schema lib for tool/node IO: zod vs Standard Schema vs valibot (affects bundle size + typed-graph inference).
- **OQ3** — license: MIT vs Apache-2.0 vs source-available (eve is OSS; matching matters).
- **OQ4** — draht-dev monetization (pure OSS + services? hosted option later? SST rev-share?) — informs license + non-goals.
- **OQ5** — repo home: a **new repo** vs a package in `draht-mono` (which already hosts an active GSD project, phases 10–18); how fr3n consumes pre-1.0 (workspace link vs published canary).
- **OQ6** — local-dev fidelity: which provider key `draht dev` uses by default; how faithful the local executor is to the Lambda one.

---

## Self-review notes (skill step 6)

- **Contradiction check:** "cloud-agnostic" (Decision 2/5) vs "AWS-first serverless v1" (Decision 6) — reconciled: v1 *implements* the AWS adapter, the *seam* keeps it agnostic. Consistent, recorded as R2.
- **Contradiction check:** "minimalistic / clean-room" vs "four wedges" — reconciled by shipping interfaces for all four but implementing one path each (Decision 9, R2). Consistent.
- **Gap check:** every acceptance truth (§2) has architectural support in §4 — durability (checkpoint/resume), typed wedge (builder generics), HITL (approval gate), deploy (SST component), agnostic (adapter seam). No orphan story.
- **Premature-commitment check:** Manifest is declarative-not-IR (avoids premature VM design); `Runtime` is one interface, not a full IR/adapter framework (avoids generalizing before the 2nd target). Schema lib + name + license deliberately left open (OQ1–3).
- **Domain-language drift:** "Manifest" used consistently for the compiled contract; "adapter/seam" consistently for the agnosticism interfaces; "wedge" consistently for differentiators.

## Next step

`/new-project` (greenfield). Decide OQ5 (repo home) first. A multi-agent orchestrated **v1 implementation plan** (concrete interfaces, Manifest schema, typed-builder design, checkpoint/resume design, SST component design, CLI design, phased roadmap, dogfood plan) is generated alongside this spec and saved as `2026-06-17-draht-agent-framework-v1-plan.md`.
