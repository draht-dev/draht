# draht agent framework — v1 Implementation Plan

- **Date:** 2026-06-17
- **Source:** multi-agent orchestration (ultracode `/draht:orchestrate`), run `wf_c3eb872b-732` — 16 agents (4 research + 7 design + 4 adversarial-verify + synthesis), ~1.6M tokens.
- **Companion:** [`./2026-06-17-draht-agent-framework-design.md`](./2026-06-17-draht-agent-framework-design.md) (approved design)
- **Status:** Draft input for `/new-project`. All 4 adversarial claims were **refuted as originally designed**; every must-fix is folded into the plan below, and the corrections are recorded verbatim in Appendix A.

---
# draht — v1 Implementation Plan

> **Naming locked (2026-06-17, supersedes OQ1 below):** framework name = **`platine`** (German: *circuit board* — *draht* is the wire, *platine* is the board you wire agents onto). CLI bin = `platine`; headline package = `@draht/platine` (`npx @draht/platine init`); modular packages = `@draht/core`, `@draht/manifest`, `@draht/model`, `@draht/runtime-aws`, `@draht/sst`; the SST namespace re-export stays `draht.Agent(...)`. Scope `@draht/*` is owned by draht-dev (shared with draht-mono) — confirm npm org ownership/access before first publish. Any older `@drahtdev/*` or `draht`-bin references below are pre-decision and should read as `@draht/*` / `platine`.

> Decision-grade architecture for a greenfield, Apache-2.0, SST/Pulumi-native agent framework by draht-dev. fr3n is consumer #0. This plan folds in every adversarial must-fix; where a design-track claim was refuted, the plan states the corrected approach inline.

---

## 1. Positioning

**The one sentence:**
> **draht is the only Apache-2.0 agent framework that compiles a typed agent graph into a versioned, inspectable manifest and deploys it as a single drop-in Pulumi/SST component into your own AWS account — no runtime license fees, no vendor-managed infra, no Vercel.**

**The 4 wedges, honestly graded** (verification refuted the naive framing — this is the corrected matrix):

| Pillar | Status | Honest claim |
|---|---|---|
| **Apache-2.0 across the whole runtime** | **Unoccupied — lead with this.** | LangGraph's production server is ELv2 (a verified self-host trap). draht is permissive end-to-end. |
| **Single Pulumi/SST drop-in component into the customer's own AWS account** | **Unoccupied — lead with this.** | No surveyed framework ships an IaC component you add to an existing `sst.config.ts`. fr3n's 193-line hand-wired `agent-studio.ts` proves the demand. |
| **Typed-graph: tsc *rejects* a mis-wired edge** | **Narrow differentiator.** | Mastra *does* infer types across `.then()` steps. draht's edge is **compile-time assignability rejection at the call site** + the `FanoutHandle`/`[]` brand — not "the only one with inference." |
| **Multi-tenant-ready interface seam** | **Seam only in v1.** | Ship the `Tenancy` interface + single-tenant default (locked decision #9). AWS Bedrock AgentCore beats us on raw per-session isolation *today*; we win on cloud-agnostic + SaaS data-ownership + manifest-carried tenant metadata. Say "multi-tenant-**ready**," never "multi-tenant." |
| **Playbooks** | **Differentiator (1 shipped).** | One installable, typed, end-to-end playbook in the distribution. |

**Demoted to table-stakes parity (required for the demo, NOT the pitch):** checkpoint/resume-across-redeploy and approval-gated tools — OpenAI Agents SDK + Temporal and eve already ship durable execution + HITL.

**GTM:** "Pulumi-ComponentResource-native, drops into any SST **or** raw-Pulumi app." SST is in maintenance mode (creator moved to OpenCode); treat the SST community as advocacy, not a channel. The Pulumi-direct path is first-class. **The load-bearing proof is the fr3n consumer-#0 deployment** — one real agent re-expressed in fr3n's SST app — because "has one real non-toy user on this exact stack" is the only claim none of eve/LangGraph/Mastra/OpenAI-SDK can make.

---

## 2. Package & repo layout

**Repo home (OQ5): a NEW dedicated repo** `github.com/draht-dev/platine` (pnpm workspace). Do **not** co-locate in `draht-mono` (unrelated Bun/Biome project; both repos publish under the shared, draht-dev-owned `@draht/*` scope).

**Naming (OQ1):** framework name = **platine** (bin `platine`) — the CLI ships as `@draht/platine` (`npx @draht/platine init`). Publish modular packages under **`@draht/*`** (draht-dev-owned scope): `@draht/core`, `@draht/manifest`, `@draht/model`, `@draht/runtime-aws`, `@draht/sst`. Re-export the SST surface as a `draht` namespace for `draht.Agent(...)` ergonomics.

**License (OQ3): Apache-2.0** across authoring library *and* runtime host. SPDX headers + NOTICE file. This is the sharpest verified wedge (LangGraph ELv2).

**Monetization (OQ4): open-core-by-add-on, never by relicense.** Core/compiler/manifest/seams/serverless-runtime/SST-component/CLI/reference-playbook stay Apache-2.0 forever. Revenue from a **separate** `@draht/enterprise` package (commercial EULA, separate repo, never imported by the Apache-2.0 runtime): hosted playbook registry, hosted observability Console, enterprise Tenancy (SSO/audit/RBAC), support/SLA.

```
platine/                          # NEW repo
  pnpm-workspace.yaml                      # packages: ['packages/*','examples/*','fixtures/*']
  tsconfig.base.json                       # strict, module NodeNext, target ES2022
  LICENSE  NOTICE                          # Apache-2.0
  .changeset/                              # versioning + canary publish
  .github/workflows/
    ci.yml                                 # typecheck + test + build
    type-fixtures.yml                      # the mis-wire tsc fixture suite (§3.2 MUST-FIX)
    canary.yml                             # merge→main: changeset --snapshot canary → publish --tag canary
    real-aws.yml                           # deploy a throwaway stage; redelivery+redeploy conformance (§4)
    release.yml                            # on tag: publish stable
  packages/
    core/                                  # @draht/core — ZERO aws/node-only deps, no barrel
      src/
        define-tool.ts                     # defineTool({inputSchema,execute}) — zod, MCP-interop
        define-agent.ts
        define-workflow.ts                 # b.node(def).from(up, mapper) — single-call-site inference
        manifest/{schema.ts,version.ts,validate.ts,field-schema.ts}  # ONE FieldSchema derive()
        seams/{model.ts,storage.ts,runtime.ts,channel.ts,event-bus.ts,tenancy.ts}
        compile.ts                         # authoring → Manifest (pure; sole writer of derived fields)
      # exports map = deep subpaths only:
      #  ./define-tool ./define-agent ./define-workflow ./manifest ./seams
    manifest/                              # @draht/manifest — re-exports core/manifest as a stable pin
    model/                                 # @draht/model — AnthropicModel + BedrockModel (NO Vercel AI SDK)
      src/{anthropic.ts,bedrock.ts,cost.ts,index.ts}
    runtime-aws/                           # @draht/runtime-aws — executor + AWS seam impls
      src/
        executor.ts                        # level scheduler, Engine-3 flush-drain, fan-out, approval gate
        storage-dynamo.ts                  # ElectroDB single-table; transactWrite step+sideeffect
        event-eventbridge.ts  channel-http.ts  channel-slack.ts
        runtime-local.ts                   # MemoryStorage/Queue/Bus — SAME executor.ts behind seams
        handlers/{executor.ts,trigger.ts,resume.ts,ingress.ts}  # SST bundles these at deploy
      # exports: "." and "./handlers" (stable, require.resolve-able paths)
    sst/                                   # @draht/sst — the ONLY deploy surface
      src/index.ts                         # export const draht = { Agent, Workflow }  (FACTORY funcs)
      src/globals.d.ts                     # ambient: aws, sst, $util, $app, $jsonStringify
      # peerDependency: sst ^4.15.x  | ZERO top-level @pulumi/* or @sst/platform imports
    cli/                                   # @draht/platine  (bin: platine)
      src/{init.ts,dev.ts,build.ts,deploy.ts,runs.ts,index.ts}
  examples/
    reference-playbook/                    # the ONE shipped playbook
  fixtures/
    miswire/                               # intentionally broken workflows; tsc must error at exact line
```

**Build tooling:** `tsup` (esbuild) for libs+CLI — dual ESM+CJS+`.d.ts`, one entry per subpath export (tree-shakeable, **no barrels** — the documented `@fr3n/core` footgun). Do **not** pre-bundle Lambda handlers; SST's esbuild bundles them at deploy (handlers exposed at the stable subpath `@draht/runtime-aws/handlers`, resolved via `require.resolve`).

**fr3n consumes pre-1.0 via published `0.0.x-canary`** (publish-on-merge, ~2-3 min), pinned exactly — NOT a cross-repo `link:` (SST Bundler moduleResolution + Lambda bundling need a real `node_modules`-resolvable package). Optional `dev:link` (pnpm overrides), default OFF.

**Toolchain alignment with fr3n:** pnpm, TS 5.9, AWS SDK v3, `sst` ^4.15.x peer, Node 20+, vitest, ESLint.

---

## 3. Core interfaces & schemas

### 3.1 The Manifest (`@draht/manifest`)

Single source of truth: exports the Zod schema, the inferred `Manifest` type, and `parseManifest()`. Both the SST component (Pulumi-program time) and the Runtime (execution time) import from here — neither hand-rolls a type. Declarative, NOT an executable IR.

```ts
import { z } from "zod";
export const SCHEMA_VERSION = "1.0.0" as const;

// FieldSchema — fr3n's recursive full-dot-path tree, lifted in. '[]' marks
// array-element descent; isTemplatable === false for any path containing '[]'.
// PRODUCED BY THE SAME derive() the typed-graph generics use (hard cross-track rule).
export type FieldSchema = {
  path: string;
  type: "string"|"number"|"boolean"|"object"|"array"|"unknown";
  isTemplatable: boolean;        // false iff path contains '[]'
  fields?: FieldSchema[]; items?: FieldSchema;
};
const FieldSchemaZ: z.ZodType<FieldSchema> = z.lazy(() => z.object({
  path: z.string(), type: z.enum(["string","number","boolean","object","array","unknown"]),
  isTemplatable: z.boolean(), fields: z.array(FieldSchemaZ).optional(), items: FieldSchemaZ.optional(),
}));

const EventFilterZ = z.object({ field: z.string(),
  operator: z.enum(["eq","neq","contains","regex","gt","gte","lt","lte"]), value: z.string() });
const TriggerZ = z.discriminatedUnion("type", [   // fr3n trigger-config verbatim; cron PORTABLE not aws cron(...)
  z.object({ type: z.literal("schedule"), schedule: z.enum(["hourly","daily","weekly"]),
             time: z.string().optional(), dayOfWeek: z.number().int().min(0).max(6).optional(),
             timezone: z.string().optional(), cron: z.string() }),   // compiler-computed, portable
  z.object({ type: z.literal("event"), eventType: z.string(), filters: z.array(EventFilterZ).default([]) }),
  z.object({ type: z.literal("webhook"), channelRef: z.string() }),
  z.object({ type: z.literal("manual") }),
]);

const ToolRefZ = z.object({         // ONE registry (replaces fr3n's MCP_ACTIONS+STUDIO_TOOLS split)
  toolId: z.string(), name: z.string(), description: z.string(),
  kind: z.enum(["local","mcp","http"]),
  inputSchema: z.object({ type: z.literal("object"), properties: z.record(z.unknown()),
                          required: z.array(z.string()).default([]) }),
  requiresApproval: z.boolean().default(false), dangerous: z.boolean().default(false),
  requiresPermission: z.string().optional(),  // REAL RBAC perm (app:view/app:edit) — never app:config:*
  connectionRef: z.string().optional(),        // iff kind==='mcp'
});

const NodeZ = z.object({ nodeId: z.string(), label: z.string().optional(),
  outputSchema: z.array(FieldSchemaZ) })       // compiler-computed via shared derive()
.and(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentRef: z.string() }),
  z.object({ kind: z.literal("tool"), toolRef: z.string(),
             requiresApproval: z.boolean().default(false), params: z.record(z.unknown()).default({}) }),
  z.object({ kind: z.literal("transform"), transform: z.discriminatedUnion("type", [
     z.object({ type: z.literal("map"), mappings: z.array(z.object({ from: z.string(), to: z.string() })) }),
     z.object({ type: z.literal("filter"), field: z.string(), operator: z.string(), value: z.string() }),
     z.object({ type: z.literal("split"), arrayField: z.string() }),
     z.object({ type: z.literal("http_request"), method: z.enum(["GET","POST","PUT","DELETE"]),
                url: z.string(), headers: z.record(z.string()).optional(), bodyTemplate: z.string().optional() }),
  ]) }),
  z.object({ kind: z.literal("fanout"), elementSubgraph: z.array(z.string()), concurrency: z.number().int().default(5) }),
]));
const EdgeZ = z.object({ edgeId: z.string(), source: z.string(), target: z.string() });
const SecretRefZ = z.object({ name: z.string(), from: z.enum(["sst-secret","ssm"]), key: z.string() });

export const ManifestZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),     // gates back-compat on load
  revision: z.string(),                          // sha256 of CANONICAL body (excl. revision) = resume anchor
  kind: z.enum(["agent","workflow"]),
  agent: z.object({
    agentId: z.string(), name: z.string(),
    model: z.object({ provider: z.enum(["anthropic","bedrock"]), modelId: z.string(),
                      maxOutputTokens: z.number().optional() }),  // NO temperature on opus-4-8/fable
    instructionsRef: z.object({ contentHash: z.string(), inline: z.string().optional() }),
    skills: z.array(z.object({ id: z.string(), description: z.string(), contentHash: z.string(),
                               inline: z.string().optional() })).default([]),
    maxIterations: z.number().int().default(5),
    maxToolCallsPerIteration: z.number().int().default(3),
    circuitBreakerErrorThreshold: z.number().int().default(5),
  }),
  tenancy: z.object({ mode: z.enum(["single","multi"]).default("single") }),  // seam only in v1
  triggers: z.array(TriggerZ).default([]),
  channels: z.array(z.object({ channelId: z.string(), kind: z.enum(["http","slack","discord"]),
                               path: z.string().optional(), auth: z.string().optional() })).default([]),
  connections: z.array(z.object({ connectionRef: z.string(), mcpUrl: z.string(),
                                  authStrategy: z.enum(["none","bearer","oauth"]) })).default([]),
  tools: z.array(ToolRefZ).default([]),
  nodes: z.array(NodeZ).default([]),
  edges: z.array(EdgeZ).default([]),
  resources: z.object({ needsHttpEgress: z.boolean().default(false), needsBedrock: z.boolean().default(false),
    needsEventBus: z.boolean().default(true), secrets: z.array(SecretRefZ).default([]),
    extraIam: z.array(z.object({ actions: z.array(z.string()), resources: z.array(z.string()) })).default([]) }),
  resume: z.object({ via: z.literal("api"), holdsApproval: z.boolean() }),
});
export type Manifest = z.infer<typeof ManifestZ>;

export function parseManifest(raw: unknown): Manifest {
  const v = ManifestZ.safeParse(raw);
  if (!v.success) throw new ManifestValidationError(v.error.message);
  if (v.data.schemaVersion.split(".")[0] !== SCHEMA_VERSION.split(".")[0])
    throw new ManifestVersionError(`schemaVersion ${v.data.schemaVersion} != runtime ${SCHEMA_VERSION}`);
  return v.data;
}
export class ManifestValidationError extends Error {}
export class ManifestVersionError extends Error {}
```

**Rules baked in:** node-level `requiresApproval` overrides tool-level (inherit if omitted). `inputSchema` is the serialized form of a JSON-Schema-expressible Zod *subset* — compilation **fails** on unsupported constructs (recursive `$ref`, etc.). Instructions/skills inline under a size threshold, else persisted per-revision. The `revision` hash is over canonical JSON with stable key ordering, excluding `revision` itself.

**Small example** (`support-triage`: HTTP-in → classify agent → approval-gated escalate tool):

```jsonc
{
  "schemaVersion": "1.0.0", "revision": "rev_a3f91c08b7", "kind": "workflow",
  "agent": { "agentId": "support-triage", "name": "Support Triage",
    "model": { "provider": "bedrock", "modelId": "eu.anthropic.claude-haiku-4-5" },
    "instructionsRef": { "contentHash": "sha256:9f2a", "inline": "You triage support tickets..." },
    "maxIterations": 5, "maxToolCallsPerIteration": 3, "circuitBreakerErrorThreshold": 5 },
  "tenancy": { "mode": "single" },
  "triggers": [{ "type": "event", "eventType": "ticket.created",
                 "filters": [{ "field": "priority", "operator": "eq", "value": "high" }] }],
  "channels": [{ "channelId": "http-in", "kind": "http", "path": "/v1/triage", "auth": "bearer" }],
  "tools": [{ "toolId": "escalate_ticket", "name": "Escalate Ticket", "description": "Escalate to human queue",
    "kind": "local", "requiresApproval": true, "dangerous": true, "requiresPermission": "app:edit",
    "inputSchema": { "type": "object",
      "properties": { "ticketId": { "type": "string" }, "reason": { "type": "string" } },
      "required": ["ticketId","reason"] } }],
  "nodes": [
    { "nodeId": "classify", "kind": "agent", "agentRef": "support-triage",
      "outputSchema": [ { "path": "classification", "type": "string", "isTemplatable": true },
                        { "path": "ticketId", "type": "string", "isTemplatable": true } ] },
    { "nodeId": "escalate", "kind": "tool", "toolRef": "escalate_ticket", "requiresApproval": true,
      "params": { "ticketId": "{{ticketId}}", "reason": "{{classification}}" },
      "outputSchema": [{ "path": "queued", "type": "boolean", "isTemplatable": true }] }
  ],
  "edges": [{ "edgeId": "e1", "source": "classify", "target": "escalate" }],
  "resources": { "needsBedrock": true, "needsEventBus": true,
    "secrets": [{ "name": "ESCALATION_API_KEY", "from": "sst-secret", "key": "EscalationApiKey" }] },
  "resume": { "via": "api", "holdsApproval": true }
}
```

### 3.2 Authoring DSL — `defineTool` / `defineAgent` / `defineWorkflow`

**Schema lib (OQ2): zod (^3.25, the v4 codepath — `z.toJSONSchema` + `~standard`).** One declaration → static type (`z.infer`) + model schema (`z.toJSONSchema`). Accept any Standard Schema at the seam (`<I extends StandardSchemaV1>`), but **ship/document zod** because only zod self-emits JSON Schema; non-zod requires an explicit `jsonSchema` override. *(Note: `@standard-schema/spec` must be added as a dep — verified absent from the fr3n root lockfile.)*

**CRITICAL — the builder is redesigned per the adversarial refutation.** The `Pipe<Out,In>`-as-return-type + variadic `chain(...)` design was empirically refuted on TS 5.9.3 (WiringError-as-return-value is inert and errors one hop later at the wrong line; `chain` folds a mid-chain mis-wire to `never` and reports nothing). The corrected primitive is **single-call-site mapper functions** with a **negative fan-out brand**:

```ts
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
type Schema<T = unknown> = StandardSchemaV1<unknown, T>;
type Infer<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

// ── defineTool: ONE declaration → static type + model JSON Schema ──
export function defineTool<I extends Schema, O extends Schema>(d: {
  description: string; inputSchema: I; outputSchema?: O;
  needsApproval?: boolean | ((args: Infer<I>) => boolean);
  jsonSchema?: Record<string, unknown>;            // required only for non-zod validators
  execute: (args: Infer<I>, ctx: ToolCtx) => Promise<Infer<O>>;
}): ToolDef<I, O> { /* name inferred from filename at compile */ return d as any; }

// ── Node handles. NEGATIVE brand on the NORMAL handle is load-bearing:
//    only this shape makes tsc REJECT piping a fan-out branch (probe5). ──
interface NodeHandle<Out> { readonly id: string; readonly __out?: Out; readonly __fanout?: never; }
interface FanoutHandle<Elem> { readonly id: string; readonly __elem?: Elem; readonly __fanout: true; }

// ── defineWorkflow: edges are LOCALIZED .from(upstream, mapper) calls.
//    The mapper's PARAM type = inferred upstream output (TS2339/TS2322 at the
//    mapper body); the mapper RETURN type is constrained to the node's input
//    schema (TS2741/TS2353 at the return). Native errors, exact line. ──
interface Builder {
  trigger<P extends Schema>(cfg: TriggerConfig & { payload: P }): NodeHandle<Infer<P>>;

  // node(): both In and Out inferred AT ONE CALL SITE. Never split In/Out across
  // chained generic calls — probe8 showed that loses Out to `unknown`.
  node<I extends Schema, O extends Schema, Up>(
    def: ToolDef<I, O> | AgentRef<I, O>,
    from: NodeHandle<Up>,
    mapper: (out: Up) => Infer<I>,                  // ← param=upstream out; return constrained to I
    opts?: { requiresApproval?: boolean }
  ): NodeHandle<Infer<O>>;

  // pure transform: both types inferred at one call site
  transform<Up, Out>(from: NodeHandle<Up>, fn: (out: Up) => Out): NodeHandle<Out>;

  // split: array → FanoutHandle of the element. Piping this anywhere is a tsc error
  // because every wiring method takes NodeHandle (with __fanout?: never), which a
  // FanoutHandle (__fanout: true) is NOT assignable to.
  split<Up extends readonly unknown[]>(from: NodeHandle<Up>): FanoutHandle<Up[number]>;

  // fanout: the ONLY consumer of a FanoutHandle.
  fanout<Elem, R>(from: FanoutHandle<Elem>, body: (item: NodeHandle<Elem>) => NodeHandle<R>,
                  opts?: { concurrency?: number }): NodeHandle<R[]>;

  // merge: collision is surfaced by forcing a REQUIRED downstream mapper to READ the
  // intersection (a never-typed key fails at the read), NOT by an inert WiringError.
  merge<A, B>(a: NodeHandle<A>, b: NodeHandle<B>): NodeHandle<A & B>;

  output<T>(h: NodeHandle<T>): NodeHandle<T>;

  // escape hatch — drops the compile-time check; runtime zod parse still guards values
  unsafeNode<I extends Schema, O extends Schema, Up>(
    def: ToolDef<I, O>, from: NodeHandle<Up>, mapper: (out: Up) => any): NodeHandle<Infer<O>>;
}
export function defineWorkflow(fn: (b: Builder) => NodeHandle<any>): WorkflowDef { /* records → .compile() */ }
export function defineAgent<I extends Schema, O extends Schema>(d: {
  model: string; instructions?: string; inputSchema?: I; outputSchema?: O;
  tools?: ToolDef<any, any>[]; maxIterations?: number; maxToolCallsPerIteration?: number;
}): AgentDef<I, O> { return d as any; }
```

**Authoring example — a mis-wire fails tsc at the exact line:**

```ts
const classify = defineTool({ description: "classify ticket",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({ summary: z.string(), severity: z.enum(["low","med","high"]) }),
  execute: async ({ body }) => ({ summary: body.slice(0,80), severity: "high" as const }) });
const createTicket = defineTool({ description: "open ticket",
  inputSchema: z.object({ subject: z.string(), priority: z.enum(["low","med","high"]) }),
  needsApproval: true, execute: async (i) => ({ ticketId: "t_1" }) });

export default defineWorkflow((b) => {
  const t = b.trigger({ type: "event", eventType: "ticket.created",
                        payload: z.object({ body: z.string() }) });
  const c = b.node(classify, t, (p) => ({ body: p.body }));         // ✓ p: {body}
  const t2 = b.node(createTicket, c, (out) => ({
    subject: out.summary,                                            // ✓
    priority: out.severity,                                         // ✓ both enums match
    // priority: out.nope,                                          // ✗ TS2339 HERE, exact line
  }));
  // const bad = b.node(classify, b.split(b.transform(t, p => [p.body])), m => m); // ✗ FanoutHandle rejected
  return b.output(t2);
});
```

**MUST-FIX locked into the plan:** (1) no `Pipe<>`-as-return-type; (2) **deleted** the variadic `chain()` sugar — a linear chain is a sequence of localized `.from()` edges; (3) fan-out brand is **negative on the normal handle**; (4) merge collisions surface via a required downstream read; (5) In+Out inferred at **one** call site; (6) a **CI fixture suite** (`fixtures/miswire/`, gate `type-fixtures.yml`) of intentionally mis-wired workflows asserts each errors at the expected line — this is the only way to lock the "readable error at the right location" guarantee since it regresses silently.

### 3.3 Adapter seams (`@draht/core/seams`) — pure interfaces, zero AWS imports

```ts
export type TenantId = string & { __brand: "TenantId" };
export type RunId    = string & { __brand: "RunId" };
export type StepId   = string & { __brand: "StepId" };
export const DEFAULT_TENANT = "default" as TenantId;

// 1) MODEL — our thin adapter over Anthropic SDK + Bedrock Converse. NO Vercel.
export type ModelMessage =
  | { role:"system"; text:string } | { role:"user"; text:string }
  | { role:"assistant"; text:string; toolCalls?: ToolCall[] }
  | { role:"tool"; results: ToolResult[] };          // plural forces batching (alternation safe)
export interface Usage { inputTokens:number; outputTokens:number; cacheReadTokens?:number; cacheWriteTokens?:number; }
export interface ModelRequest { modelId:string; messages:ModelMessage[]; tools?:ToolSpec[]; maxTokens:number;
  effort?: "low"|"medium"|"high"|"xhigh"|"max"; }    // no temperature/top_p on opus-4-8/fable
export type ModelStreamEvent =
  | { type:"text"; delta:string }
  | { type:"tool_call"; call: ToolCall }             // emitted ONLY after input JSON fully accumulated
  | { type:"done"; stopReason:"end_turn"|"tool_use"|"max_tokens"|"refusal";
      text:string; toolCalls:ToolCall[]; usage:Usage; modelId:string };
export interface Model {
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
  chat(req: ModelRequest, signal?: AbortSignal): Promise<Extract<ModelStreamEvent,{type:"done"}>>;
  supports(modelId: string): boolean;                // eager validation; throws loud on mismatch
}
export function estimateCostUsd(modelId: string, u: Usage): number;  // pure pricing table, NOT inside Model

// 2) STORAGE — single durability surface. FORCES Engine-3 flush+drain.
export type RunStatus = "queued"|"running"|"awaiting_approval"|"completed"|"failed"|"cancelled"|"paused";
export type StepStatus = "pending"|"running"|"completed"|"skipped"|"awaiting_approval"|"failed";
export interface Storage {
  ensureRun(r: { tenantId:TenantId; runId:RunId; manifestId:string; manifestRevision:string }): Promise<RunRecord>; // patch-not-create
  getRun(t:TenantId, runId:RunId): Promise<RunRecord|null>;
  loadStepOutputs(t:TenantId, runId:RunId): Promise<Map<string, unknown>>;         // rehydrate the Map, never a single previousOutput
  // Engine-3: the ONLY checkpoint method serializes onto an internal per-run chain.
  appendCheckpoint(c: StepCheckpoint): Promise<void>;
  // co-writes STEP#completed + SIDEEFFECT# in ONE transactWrite (ElectroDB 3.7.5)
  commitStepWithSideEffect(step: StepCheckpoint, ledger: SideEffectRow): Promise<void>;
  hasSideEffect(t:TenantId, runId:RunId, nodeId:string): Promise<SideEffectRow|null>;  // mandatory PRE-CHECK
  // awaits the full chain BEFORE any terminal status write
  setRunStatus(t:TenantId, runId:RunId, status:RunStatus, fin:{usage?:Usage; costUsd?:number; error?:string}): Promise<void>;
  // manifest is persisted PER-REVISION, never overwritten
  putManifest(manifestId:string, revision:string, blob:string): Promise<void>;
  loadManifest(manifestId:string, revision:string): Promise<string>;               // resume loads THIS revision
  createPendingApproval(a: ApprovalRow): Promise<void>;                             // idempotent on (runId,stepId)
  resolveApproval(actionId:string, verdict:"approved"|"rejected"): Promise<void>;
  getPendingByAction(actionId:string): Promise<ApprovalRow|null>;
}

// 3) RUNTIME — the swap seam. MINIMAL: no scheduling/level/fanout/continuation leaks.
export interface Runtime {
  submitRun(i: { runId:RunId; manifestId:string; manifestRevision:string; tenantId:TenantId;
                 trigger:TriggerEnvelope; input:Record<string,unknown>; chainDepth:number }): Promise<{status:RunStatus}>;
  resumeRun(i: { kind:"approval"; runId:RunId; approvalId:string; decision:"approved"|"rejected"; by?:string }
             | { kind:"signal"; runId:RunId; signal:string; payload?:Record<string,unknown> }
             | { kind:"continue"; runId:RunId }): Promise<{status:RunStatus}>;
  cancelRun(runId:RunId): Promise<void>;
  getRun(runId:RunId): Promise<RunRecord|null>;
}

// 4) CHANNEL — inbound (verify+normalize) split from outbound (deliver/stream).
export interface InboundChannel {                    // returns a discriminated result, NOT bare null
  parse(req:{headers:Record<string,string>; body:string; rawBody:Buffer}):
    Promise<{kind:"run"; env:InboundEnvelope} | {kind:"ack"; response:unknown} | {kind:"reject"}>;
}
export interface OutboundChannel {
  deliver(target:OutboundTarget, message:string): Promise<void>;
  stream(target:OutboundTarget, tokens:AsyncIterable<string>): Promise<void>;       // NDJSON/SSE
}

// 5) EVENTBUS — chainDepth loop guard; filter eval lives HERE not in the compiler.
export interface EventBus {
  publish(e: DrahtEvent): Promise<void>;             // refuses past MAX_CHAIN_DEPTH; best-effort, never throws into the run
  subscribe(p:{eventType:string; filters?:EventFilter[]}, h:(e:DrahtEvent)=>Promise<void>): void;
}
export function matchesFilter(e: DrahtEvent, filters: EventFilter[]): boolean;       // AND-logic, string-coerced

// 6) TENANCY — single-tenant default; the seam that unlocks multi-tenant.
export interface Tenancy {
  resolveTenant(env: InboundEnvelope | DrahtEvent): Promise<TenantId>;              // DEFAULT_TENANT in v1
  checkQuota(t:TenantId, kind:"run"): Promise<{allowed:boolean; used:number; limit:number; remaining:number}>;
  recordUsage(t:TenantId, usage:Usage, costUsd:number): Promise<void>;
  shouldBreak(t:TenantId, agentId:string): Promise<boolean>;                        // errorCount>=5 — v1, NOT deferred
  tripBreaker(t:TenantId, agentId:string): Promise<void>;
}

// Injected into the executor as one bundle (fr3n ExecutorDependencies pattern).
// v2 Temporal/Restate swaps ONLY Runtime; reuses Model/Storage/Channel/EventBus/Tenancy unchanged.
export interface Adapters {
  model: Model; storage: Storage; eventBus: EventBus; tenancy: Tenancy;
  inbound: Record<string, InboundChannel>; outbound: Record<string, OutboundChannel>;
}
```

**v1 concrete impls:** `AnthropicModel`, `BedrockModel`, `DynamoStorage` (ElectroDB single-table), `EventBridgeBus`, `HttpChannel`, `SlackChannel`, `SingleTenantContext`. R5 provider differences (tool-block shapes, `role:tool` normalization, consecutive same-role merge, system separation, streaming tool-call accumulation to `contentBlockStop`, model-id namespace + region routing) live **entirely inside** the two Model impls.

### 3.4 SST component — REDESIGNED as a factory (`@draht/sst`)

**The "extends SST's `Component`" decision is DROPPED** — verified: `sst@4.15.2` exports map has no `Component`, and the injected `sst` global re-exports `linkable.js` but **not** `component.js`. The supported, fr3n-proven pattern is composing public `sst.aws.*` + raw `aws.*` via globally-injected namespaces. Linkability uses only `sst.Linkable`.

```ts
// @draht/sst — FACTORY funcs instantiated INSIDE run(). ZERO top-level @pulumi/* or @sst/platform imports.
// aws.*, sst.aws.*, $util, $app, $jsonStringify accessed via ambient globals (src/globals.d.ts).
import type { Manifest } from "@draht/manifest";

export interface DrahtAgentProps {
  manifest: Manifest | string;                       // inline OR path to `platine build` JSON (read at Pulumi-program time)
  model: { provider:"anthropic"|"bedrock"; apiKey?: any /*sst.Secret*/; defaultModel:string; fallbacks?:string[] };
  storage?: { mode:"managed"; retain?: boolean }     // DEFAULT — own DynamoDB, removal:'retain'+deletionProtection
           | { mode:"shared"; table:any; keyPrefix?:string };  // OPT-IN, high-risk — gated by isolation test
  bus?: any;                                          // reuse host Bus, else create own
  channels?: ({ kind:"http"; router?:any; path?:string; cors?:boolean })[];  // router optional → fallback url:true
  tenancy?: { mode:"single" } | { mode:"multi"; resolveTenant:string };       // multi = SEAM only, unproven
  provider?: any;                                     // aws.Provider — cloud-agnostic seam (only AwsCloudAdapter in v1)
  link?: any[]; permissions?: { actions:string[]; resources:string[] }[]; environment?: Record<string,string>;
  timeout?: `${number} minutes`;                      // set near 15 min so the soft-budget math holds
  memory?: `${number} MB`;
}

export function Agent(name: string, props: DrahtAgentProps) {
  // 1) read manifest synchronously; branch provisioning on its contents
  // 2) compose: sst.aws.Queue(+DLQ, visibilityTimeout > executor timeout)
  //             sst.aws.Function(executor, handler=@draht/runtime-aws/handlers/executor, manifest baked as asset)
  //             sst.aws.Bus (or linked) + trigger-subscriber Lambda for event triggers
  //             managed sst.aws.Dynamo (retain) OR shared table with DRAHT#<name># namespace
  //             one sst.aws.Cron per schedule trigger; one route per http channel (router OR url:true)
  //             aws.cloudwatch.MetricAlarm on the DLQ
  // 3) snapshot the FULL manifest blob into the table at deploy (MANIFEST#<id>#<revision>, never overwritten)
  const linkable = new (globalThis as any).sst.Linkable(name, {
    properties: { queueUrl, busName, tableName, httpUrl, manifestRevision },
    include: [ /* sst.aws.permission: PutEvents + SQS:Send + Dynamo RW */ ],
  });
  return { queueUrl, httpUrl, busName, tableName, manifestRevision, getSSTLink: () => linkable.getSSTLink() };
}
export function Workflow(name: string, props: DrahtAgentProps) { return Agent(name, props); } // same impl; manifest.kind differs
export const draht = { Agent, Workflow };
```

**Sample `infra/draht.ts` + `sst.config.ts` usage (fr3n consumer #0):**

```ts
// fr3n/infra/draht.ts
import { draht } from "@draht/sst";
import { table, agentBus } from "./database";        // reuse fr3n resources by reference
import { router } from "./api";
export const supportAgent = draht.Agent("Fr3nSupportAgent", {
  manifest: "./agents/support/.platine/manifest.json",
  model: { provider: "bedrock", defaultModel: "eu.anthropic.claude-haiku-4-5" },
  storage: { mode: "managed", retain: true },        // own table (shared mode gated by isolation test)
  bus: agentBus,
  channels: [{ kind: "http", router, path: "/draht/v1/support" }],
  tenancy: { mode: "single" },
  link: [table],                                      // tools call fr3n's API
  permissions: [{ actions: ["bedrock:InvokeModel"], resources: ["*"] }],
  timeout: "14 minutes",
});

// fr3n/sst.config.ts run()  — one added dynamic import, mirrors existing style
async run() {
  const db = await import("./infra/database");
  const draht = await import("./infra/draht");
  return { SupportAgentUrl: draht.supportAgent.httpUrl };
}
```

---

## 4. Runtime & durability design

**Scope honesty (verification must-fix):** the agent-studio reference runs an entire workflow in ONE Lambda with **no** checkpoint/resume — step-checkpoint, time-budget continuation, manifest-version-pinned resume, deterministic runId, and the side-effect ledger are **all greenfield**. v1's exactly-once contract is at the **step boundary only**; **sub-step (mid-agent-loop) checkpointing is explicitly v2.** An agent node that makes N tool calls then dies re-runs the whole node — the ledger is the only thing preventing double effects there, so **the ledger is non-optional and on the hot path.**

**Executor loop** (one Lambda, SQS-driven, one DAG-level pass per the readiness gate; `runtime-local.ts` runs the *same* `executor.ts` behind Memory adapters):

```ts
async function drive(ctx: ExecutorContext, s: Storage, deps: ExecutorDeps) {
  const run = await s.getRun(ctx.tenantId, ctx.runId);
  // idempotent no-op on redelivery (matches agent-studio skip-on-duplicate)
  if (!run || isTerminal(run.status) || run.status === "awaiting_approval" || run.status === "paused") return;
  if (await deps.tenancy.shouldBreak(ctx.tenantId, run.agentId)) { await s.setRunStatus(ctx.tenantId, ctx.runId, "paused", {}); return; }

  const manifest = parseManifest(JSON.parse(await s.loadManifest(run.manifestId, run.manifestRevision))); // PINNED revision
  const done = new Set(run.steps.filter(x => x.status==="completed"||x.status==="skipped").map(x=>x.nodeId));
  const outputs = await s.loadStepOutputs(ctx.tenantId, ctx.runId);   // rehydrate the Map

  let flush: Promise<void> = Promise.resolve();                       // Engine-3 chain
  const checkpoint = (r: StepCheckpoint) => { flush = flush.then(() => s.appendCheckpoint(r)).catch(logFlushErr); };

  while (done.size < manifest.nodes.length) {
    if (Date.now() >= ctx.deadlineAt) {                              // SOFT TIME BUDGET (~12 min)
      await flush; await deps.queue.enqueueContinuation(ctx.runId, run.continuations + 1); return; // same anchor → idempotent
    }
    const ready = manifest.nodes.filter(n => !done.has(n.nodeId) && upstreams(manifest, n.nodeId).every(u => done.has(u)));
    if (ready.length === 0) { await flush; await failRun(ctx, s, "scheduling stalled"); return; }
    const results = await Promise.all(ready.map(n => runStep(n, outputs, manifest, ctx, deps, checkpoint, s)));
    for (const r of results) {
      if (r.kind === "held")   { await flush; await s.setRunStatus(ctx.tenantId, ctx.runId, "awaiting_approval", {}); return; } // ZERO compute; NO re-enqueue
      if (r.kind === "failed") { await flush; await failRun(ctx, s, r.error); return; }
      outputs.set(r.nodeId, r.output); done.add(r.nodeId);
      for (const h of r.fanoutHandled ?? []) done.add(h);            // mark split descendants AFTER settle
    }
    accumulateUsage(run, results);                                   // deltas summed POST-Promise.all (no shared-accumulator race)
  }
  await flush;                                                       // DRAIN before terminal
  await s.setRunStatus(ctx.tenantId, ctx.runId, "completed", { usage: run.usage, costUsd: run.costUsd });
  await deps.events.emitOutputs(ctx, run);                           // chainDepth+1; guard MAX_CHAIN_DEPTH
}

async function runStep(n, outputs, manifest, ctx, deps, checkpoint, s: Storage): Promise<StepResult> {
  const input = resolveInput(n, manifest, outputs);                  // 0→trigger, 1→upstream, N→merge; '[]' paths non-templatable
  const idemKey = `${ctx.runId}#${n.nodeId}`;
  if (n.kind === "tool") {
    if (effectiveApproval(n, manifest)) {                            // node overrides tool default
      const approvalId = await deps.approvals.hold({ runId: ctx.runId, node: n, input, idemKey });
      checkpoint({ tenantId: ctx.tenantId, runId: ctx.runId, stepId: n.nodeId, status: "awaiting_approval", heldApprovalId: approvalId });
      return { kind: "held", nodeId: n.nodeId, approvalId };
    }
    const prior = await s.hasSideEffect(ctx.tenantId, ctx.runId, n.nodeId);   // MANDATORY pre-check
    if (prior) return { kind: "done", nodeId: n.nodeId, output: prior.result, fanoutHandled: [] };
    const out = await deps.tools.execute(n.toolRef, input, { idempotencyKey: idemKey, tenantId: ctx.tenantId });
    await s.commitStepWithSideEffect(                                // transactWrite: STEP#completed + SIDEEFFECT# atomically
      { tenantId: ctx.tenantId, runId: ctx.runId, stepId: n.nodeId, status: "completed", output: out },
      { tenantId: ctx.tenantId, runId: ctx.runId, nodeId: n.nodeId, idempotencyKey: idemKey, toolName: n.toolRef, result: out });
    return { kind: "done", nodeId: n.nodeId, output: out };
  }
  // 'agent' → model tool-loop bounded by MAX_ITERATIONS / MAX_TOOL_CALLS, allowlist-before-dispatch
  // 'transform'/'fanout' → pure; split = bounded-concurrency per-item w/ FANOUT#<node>#<idx> checkpoints, resumable
}
```

**Checkpoint record shape** (DynamoDB single-table, ElectroDB; `PK=RUN#<runId>` so one Query rehydrates everything; `GSI1 = TENANT#<tenantId> / STATUS#<status>#<ts>` for the dashboard):

```
PK=RUN#<runId>  SK=META               → RunMeta {manifestId, manifestRevision (pinned), status, chainDepth, attempt, continuations, usage, costUsd}
PK=RUN#<runId>  SK=STEP#<nodeId>       → StepCheckpoint {status, input?, output?, idempotencyKey?, heldApprovalId?}
PK=RUN#<runId>  SK=SIDEEFFECT#<nodeId> → SideEffectRow {idempotencyKey, toolName, result}   ← exactly-once ledger
PK=RUN#<runId>  SK=APPROVAL#<actionId> → ApprovalRow {nodeId, toolName, paramsJson, status, idempotencyKey, decidedBy?}
PK=RUN#<runId>  SK=FANOUT#<nodeId>#<i> → FanoutItemRow {itemIndex, status, output?}
PK=MANIFEST#<id> SK=REV#<revision>     → full manifest blob   ← NEVER overwritten; resume loads exact revision
```

**Idempotency / exactly-once rules (all verification must-fixes):**
1. `runId` is a **deterministic hash of trigger-source + dedupKey computed at the channel/trigger boundary BEFORE enqueue** — `nanoid()`-in-executor is forbidden. The RUN row is pre-created; executor **patches, never creates**, and **no-ops on redelivery** when status is terminal/`awaiting_approval`/the step already completed.
2. **Mandatory `SIDEEFFECT#` pre-check on every tool dispatch**, co-written with the step-completed checkpoint via **ElectroDB `transactWrite`** (verified available in 3.7.5). Documented limit: exactly-once holds **only** for tools that honor a provider idempotency key OR are idempotent under the ledger pre-check; an external effect crashing in the post-effect/pre-ledger window can still double-fire — the irreducible limit of hand-rolled vs Temporal/Restate.
3. **SQS visibility timeout strictly > executor Lambda timeout** (else a mid-step run is redelivered concurrently and double-executes).
4. **Soft time budget** (`getRemainingTimeInMillis()` − 3 min): persist, drain, re-enqueue a continuation under the **same anchor**, with **`maxContinuations` → DLQ** guard against infinite loops.

**Resume-on-redeploy:** the RUN row pins `manifestRevision`; the executor loads exactly that revision's `MANIFEST#<id>#REV#<revision>` blob (snapshotted in full at run-creation, never overwritten). The SST component sets the state table **`removal:'retain'` + deletionProtection** or the "survives redeploy" demo silently fails on SST's default `removal:'remove'`.

**Approval gate:** `requiresApproval` tool → write `APPROVAL#` row, set step+run `awaiting_approval`, checkpoint, drain, **return without re-enqueuing** (zero compute). Resume is the explicit `ResumeApproval(runId, approvalId, decision)` API (an HTTP route → `Runtime.resumeRun({kind:"approval"})`) → flip the row, re-enqueue **one** continuation. Redelivery while held = no-op.

**Conformance gate:** a **real-AWS redelivery + redeploy harness** (`real-aws.yml`) is a v1 gate — the dev in-process `MemoryQueue` provably cannot surface at-least-once async-flush ordering races (precedent: fr3n's real-AWS playbook harness). The minimal `Runtime` seam (`submit/resume/cancel/getRun`, **no** scheduling/level/fanout/continuation leakage) is the real risk hedge: a Temporal/Restate adapter replaces the unproven scheduler wholesale in v2.

**`platine dev` fidelity:** does NOT spawn a second `sst dev` multiplexer (fr3n CLAUDE.md). Runs `executor.ts` in-process against `MemoryStorage` (JSON under `.platine/dev-runs/`) / `MemoryQueue` (with a `--redeliver` at-least-once toggle) / `MemoryBus`. MemoryStorage **snapshots** the pinned manifest per run (must not reference the live one) so hot-reload can't corrupt in-flight runs. Default model provider = Anthropic (`ANTHROPIC_API_KEY`); deployed default = Bedrock (execution-role IAM). The tool-loop/checkpoint/approval code is identical regardless of provider.

---

## 5. Phased v1 roadmap

Builds to the **6 acceptance truths** (T1 typed agent as a directory; T2 `platine deploy` into an AWS SST app; T3 answers on HTTP; T4 typed wiring error fails tsc; T5 in-flight run survives redeploy + resumes; T6 approval-gated tool holds→queues→resumes) **+ the fr3n dogfood gate (G)**.

| Phase | Goal | Tasks (file/package) | Depends on | Acceptance |
|---|---|---|---|---|
| **P0 — Foundation** | Repo, scope, license, CI skeleton | new repo + pnpm workspace; `tsconfig.base.json`; Apache LICENSE+NOTICE; verify+lock `@draht/*`; add `@standard-schema/spec` dep; tsup configs; `ci.yml` | — | `pnpm build` green; `@draht/*` reserved on npm |
| **P1 — Manifest** | `@draht/manifest` + shared `FieldSchema` derive | `manifest/{schema,version,validate,field-schema}.ts`; `parseManifest`; canonical-hash `revision`; round-trip Zod→JSON-Schema subset + fail-on-unsupported | P0 | example manifest parses; bad schemaVersion throws; non-canonical input → same revision |
| **P2 — Typed DSL** | `defineTool/defineAgent/defineWorkflow` + compiler | `define-*.ts`; negative fan-out brand; single-call `.from()` mapper; `merge`; `compile.ts` (sole writer of derived fields); **`fixtures/miswire/` + `type-fixtures.yml`** | P1 | **T1, T4**: typed agent dir compiles to manifest; every mis-wire fixture errors at expected line |
| **P3 — Model adapter** | `@draht/model` (Anthropic + Bedrock) | `anthropic.ts`, `bedrock.ts` (R5 normalization + streaming tool-call accumulation), `cost.ts`; conformance test: same `ModelMessage[]` through both impls → identical tool-loop | P0 | both providers run a tool loop with identical observable behavior |
| **P4 — Runtime core** | `executor.ts` behind seams + `runtime-local.ts` | level scheduler, Engine-3 flush-drain, deterministic-runId no-op, mandatory SIDEEFFECT# pre-check, soft-budget continuation, approval hold, fan-out per-item checkpoints, circuit breaker, chainDepth guard | P1,P3 | local executor: checkpoint/resume, approval hold/resume, `--redeliver` no double-fire, circuit breaker trip |
| **P5 — AWS impls** | `DynamoStorage` + `EventBridgeBus` + `HttpChannel`/`SlackChannel` | `storage-dynamo.ts` (ElectroDB single-table, `transactWrite` step+sideeffect, versioned MANIFEST# rows), `event-eventbridge.ts`, `channel-http.ts` (POST `/v1/sessions` + GET `/v1/sessions/:id/stream` NDJSON), Lambda `handlers/*` | P4 | storage round-trips all row types; HTTP session API matches the eve-parity surface |
| **P6 — SST component** | `@draht/sst` factory (`draht.Agent/Workflow`) | factory composing `sst.aws.*` + raw `aws.*` via globals; `sst.Linkable`; managed-table retain+deletionProtection; Cron per schedule; route via router-or-`url:true`; DLQ alarm; manifest baked as asset + snapshotted at run-create; `globals.d.ts`; **`real-aws.yml` smoke `sst deploy`** | P5 | **T2, T3**: deploys into a throwaway SST stage; agent answers on HTTP |
| **P7 — Durability gate** | Prove resume + approval on real AWS | redelivery + redeploy conformance harness; assert in-flight run resumes from pinned revision; approval hold→queue-drained→`ResumeApproval`→completes | P6 | **T5, T6** pass on a deployed stage |
| **P8 — CLI** | `@draht/platine` (`init/dev/build/deploy/runs`) | `init` (minimal + `-t workflow` templates); `dev` (in-process executor); `build` (tsc `--check` then compile→`.platine/manifest.json`); `deploy` (build → `sst deploy`); `runs list/get/tail/approve/resume` (reads Storage directly; `--table`/`DRAHT_TABLE` override for non-SST) | P2,P4,P6 | `platine init` → edit `agent.md` → `platine dev` answers in <1 min; `runs approve <actionId>` resumes a hold |
| **P9 — Reference playbook** | One installable typed playbook | `examples/reference-playbook/` full authoring→compile→deploy→run | P8 | playbook deploys and runs end-to-end |
| **P10 — fr3n dogfood (G)** | One real fr3n agent re-expressed | re-author one fr3n agent on the DSL; `fr3n/infra/draht.ts`; pin `0.0.x-canary`; deploy in fr3n's SST app; shared-table isolation test if `mode:"shared"` used | P7,P9 | **G**: real fr3n agent deployed in fr3n's SST stage, answering on HTTP, surviving a redeploy |

**Explicitly deferred to v2:** sub-step (mid-agent-loop) checkpointing; multi-tenant runtime impl (seam only); Slack/Discord/SSE-WebSocket beyond HTTP+Slack-inbound; sandbox component; GCP/Azure CloudAdapters; `sst add draht` Pulumi-provider wrapper; visual builder; OTel export wiring (seam only); webhook-signature-verification UI; Temporal/Restate Runtime adapter; eval framework (`defineEval`) — stub the seam, do not build.

---

## 6. Risk register

| ID | Risk | Mitigation baked into plan |
|---|---|---|
| **R1** | **Typed-graph errors are unreadable / regress silently** (refuted as originally designed) | Single-call-site `.from()` mappers (native TS2339/2322/2741 at exact line); deleted `chain()` sugar; negative fan-out brand on `NodeHandle`; merge collision read by required downstream mapper; `fixtures/miswire/` CI gate. Inference depth a non-issue at realistic scale (probe: 86K instantiations, 0.49s). |
| **R2** | **Hand-rolled durability is unproven** (refuted: agent-studio has no checkpoint/resume) | Step-boundary exactly-once via mandatory `SIDEEFFECT#` pre-check + `transactWrite`; deterministic runId at trigger boundary; no-op on redelivery; versioned never-overwritten MANIFEST# rows + full-blob snapshot; SQS visibility > Lambda timeout + soft-budget continuation + maxContinuations→DLQ; real-AWS conformance gate (P7); minimal Runtime seam as the Temporal/Restate hedge. Sub-step checkpoint = v2; ledger is hot-path non-optional. |
| **R3** | **Resume across redeploy silently fails** | Pin `manifestRevision` per run; snapshot full blob at run-create; state table `removal:'retain'`+deletionProtection; only verifiable on deployed stage (P7). |
| **R4** | **SST component can't extend `Component`** (refuted: not exported, verified) | Dropped subclassing; factory composing public `sst.aws.*` + raw `aws.*` via globals; `sst.Linkable` only; zero top-level `@pulumi/*`/`@sst/platform` imports; ship own ambient `globals.d.ts`; `sst` pinned peerDep + real `sst deploy` smoke in CI (platform internals unversioned). |
| **R5** | **Provider wire-format divergence (Anthropic vs Bedrock)** | All normalization inside the two Model impls; buffer streaming tool-calls to `contentBlockStop`; `role:tool` results plural (batched); eager model-id validation throws loud; cross-provider conformance test (P3). |
| **R6** | **Trigger filters not compile-checked** | Filter eval lives in EventBus/Runtime (string-coerced AND-list), documented as config not graph-wiring; compiler validates filter *shape* only. SSRF-safe `http_request` does DNS pre-resolution + IP deny-ranges + redirect refusal + size cap. |
| **V-tenancy** | Multi-tenant overclaim | "multi-tenant-**ready** seam, single-tenant default in v1" everywhere; never "multi-tenant"; position vs AgentCore on cloud-agnostic + data-ownership only. |
| **V-shared-table** | draht rows collide with fr3n's `electro` GSIs | Default managed own table; shared mode opt-in, draht-owned ElectroDB entities, hard `DRAHT#<name>#` namespace, gated by an isolation test (P10). |
| **V-naming** | shared `@draht/*` scope (draht-dev-owned) | Confirm draht-dev owns the `@draht` npm org (draht-mono already publishes there) before any publish/pin; framework = `platine`, headline pkg `@draht/platine`, bin `platine`. |
| **V-positioning** | Marketing trivially refuted | Lead with Apache-2.0 + SST/Pulumi drop-in (the two unoccupied pillars); demote durability/approval to table-stakes; restate typed-graph as "tsc rejects mis-wired edge"; honest competitive matrix in docs. |
| **V-barrel** | `@draht/core` barrel pulls Node-only deps, breaks Next build | Deep-subpath exports only, no barrel; zod reachable only via `@draht/core/define-*`; CI builds an `apps/fan`-style client to catch it. |
| **V-dev-fidelity** | dev passes while a prod-only race exists | dev runs the *same* `executor.ts`; `--redeliver` toggle; flush-chain ordering verified only on deployed stage (P7). |

---

## 7. Resolved open questions

| OQ | Answer | Rationale |
|---|---|---|
| **OQ1 — naming** | Framework **platine** (bin `platine`); headline pkg `@draht/platine`; modular `@draht/core|manifest|model|runtime-aws|sst` | `@draht` is the draht-dev-owned scope (shared w/ draht-mono); draht=wire + Platine=circuit board. Confirm npm org access before publish. |
| **OQ2 — schema lib** | **zod** (^3.25 v4 codepath); accept any Standard Schema at the seam, zod is the documented default; non-zod needs explicit `jsonSchema` | One declaration → `z.infer` + `z.toJSONSchema`; only zod self-emits JSON Schema today. Add `@standard-schema/spec` dep. |
| **OQ3 — license** | **Apache-2.0** across library + runtime; SPDX + NOTICE | Locked decision; the sharpest verified wedge (LangGraph ELv2); patent grant de-risks enterprise/AWS adoption. |
| **OQ4 — monetization** | Open-core-by-add-on, never relicense; separate `@draht/enterprise` (commercial EULA, separate repo, never imported by the runtime) | Mirrors Temporal/Inngest; avoids recreating the ELv2 trap. |
| **OQ5 — repo home** | **New dedicated repo** `platine` (pnpm) | `draht-mono` is an unrelated Bun/Biome project; keep platine in its own repo with separate tooling/release cadence (shared `@draht/*` scope is fine). |
| **OQ6 — dev model default** | `platine dev` → Anthropic direct via `ANTHROPIC_API_KEY`; falls back to Bedrock if AWS creds + `DRAHT_MODEL_PROVIDER=bedrock`; deployed default = Bedrock (execution role) | Lowest-ceremony local path; model string (`anthropic/...` vs `bedrock/...`) picks the adapter; runtime semantics identical across providers. |

---

## 8. Immediate next actions (the `/new-project` kickoff)

1. **Confirm the `@draht` npm org + brand (prerequisite).** Confirm draht-dev owns the `@draht` npm org (draht-mono already publishes there) and that you can publish `@draht/platine` (CLI, bin `platine`), `@draht/core`, `@draht/manifest`, `@draht/model`, `@draht/runtime-aws`, `@draht/sst`. Block all publishing/pinning until confirmed.
2. **Stand up the repo (P0).** Create `github.com/draht-dev/platine`, pnpm workspace, `tsconfig.base.json` (strict, NodeNext, ES2022), Apache-2.0 LICENSE + NOTICE, tsup configs, changesets, `ci.yml`. Add `@standard-schema/spec`. Confirm `@draht/core` builds with deep-subpath exports and **no barrel**.
3. **Author the Manifest + shared `FieldSchema` derive (P1).** Implement `ManifestZ`/`parseManifest`/canonical `revision` hashing and the **one** `derive()` that both the typed-graph generics and the manifest serializer call — this single function is the hard cross-track contract; get it right before the DSL lands.
4. **Build the typed DSL + the mis-wire fixture suite first (P2, T4).** Implement `.from()` mappers + negative fan-out brand, then immediately write `fixtures/miswire/` and `type-fixtures.yml` asserting each broken workflow errors at the expected tsc line — this gate must exist before the API surface can drift.
5. **Prove the SST factory composes (P6 spike, ahead of order).** Write a throwaway `sst.config.ts` that calls a stub `draht.Agent` factory (composing `sst.aws.Queue/Function/Dynamo/Bus` via injected globals, zero `@pulumi/*` imports) and run a real `sst deploy` to a throwaway stage — confirm the dropped-`Component` factory pattern and `sst.Linkable` work against `sst@4.15.x` before building the full runtime on top of it.

---

## Appendix A — Adversarial verification record

Each riskiest claim was handed to an independent skeptic instructed to refute it using the research + design outputs. All four were refuted *as designed*; the evidence below is why, and the fixes are already in §1–§8.

### A.1 — REFUTED (confidence: high)

**Claim:** The typed defineWorkflow builder can infer each node's input type from upstream node outputs at compile time in real TypeScript AND produce readable errors WITHOUT inference complexity that makes the DX unusable.

**Strongest objection (evidence):** The claim is refuted AS DESIGNED, because the two mechanisms the type-system track committed to both fail the "readable errors" half empirically on TS 5.9.3 (the monorepo's own compiler). I built and compiled probe files:

(1) The `Pipe<Out,In>` conditional that resolves to a `WiringError<msg>` literal as the RETURN type does NOT fail tsc at the mis-wired `.pipe()` call. A `WiringError` is a legal value to bind to a const, so the mis-wire site is SILENT. The error only surfaces one hop later when the WiringError value is consumed by the next `.pipe()` or `.compile()`, reported as a generic `TS2345: Property 'id' is missing in type 'WiringError<...>'` pointing at the WRONG line (probe1, probe2).

(2) The `merge()`-returns-WiringError collision guard produced ZERO errors (probe4) — same root cause: an unconsumed WiringError value is inert.

(3) The `FanoutHandle<Elem>` brand does NOT exclude assignment to a plain `NodeHandle<Out>` — it leaks structurally (probe5: `wantsHandle(fanoutHandle)` compiled clean). The brand only works if `NodeHandle` itself declares the conflicting field as `__brandFan?: never`.

(4) The variadic `b.chain(trigger, n1, n2, ...)` sugar proposed AS THE "gentle on-ramp" mitigation is the worst case: a mid-chain mis-wire silently collapses the type-level `Fold` to `never`, and `never` is assignable to everything, so tsc reports NOTHING (probe7).

Crucially, the claim CAN be salvaged: the `b.tool(def).from(upstream, (out) => ({...mapped}))` mapper-at-single-call-site shape (CLI track) produces NATIVE, exactly-located errors — TS2339/TS2322/TS2741 at the precise mapper line (probe3, probe9). Inference depth is a non-issue at realistic scale (probe6: deep nesting + 20-step chain + 4-deep fold = 86K instantiations, 0.49s). So the wedge is real, but ONLY with a different builder API than the one designed.

**Resolution:** Redesign the builder around single-call-site mapper functions and abandon both the `Pipe<Out,In>`-as-return-type pattern and the variadic `chain(...)` sugar. The wiring primitive must be `b.node(def).from(upstream, (out) => mappedInput)` (or `b.transform(upstream, fn)` with BOTH In and Out inferred at one call site), where (a) the mapper's parameter type is the inferred upstream output (field-path/type errors are native TS2339/TS2322 at the mapper body) and (b) the mapper return type is constrained to the downstream node's input schema (missing/extra fields are native TS2741/TS2353 at the mapper return). Never route assignability through a WiringError-valued return type — TS reports it one hop later at the wrong line. For the fan-out boundary, put a NEGATIVE brand on the normal handle (`NodeHandle<Out>{ readonly __fanout?: never }` vs `FanoutHandle<E>{ readonly __fanout: true }`) so a FanoutHandle is structurally rejected by any normal wiring method (probe5 proves this is the only brand shape that excludes). For merge collisions, force the never-typed intersection key to be read by a required downstream mapper rather than returning an inert WiringError. Keep zod as the schema source (`z.infer` produces exactly the structural object types the probes used; zod@3.25.76 confirmed present). Document that split `.transform<Out>().from<In>()` two-call shapes lose Out to `unknown` (probe8) — inference must happen at ONE call site. Add a CI fixture suite of intentionally mis-wired workflows asserting each errors at the expected line.

**Must-fixes (folded into the plan):**
- Replace the `Pipe<Out,In>` conditional-type-that-resolves-to-WiringError-as-return-type mechanism with single-call-site mapper functions: `b.node(def).from(upstream, (out)=>mappedInput)`. Empirically WiringError-as-return-type does NOT fail tsc at the mis-wired edge — it surfaces one hop later as a generic 'Property id is missing' error on the wrong line (probe1/probe2). Mapper functions produce native, exactly-located TS2339/TS2322/TS2741 errors (probe3/probe9).
- DELETE the variadic `b.chain(trigger, n1, n2, ...)` sugar (it was the gentle-on-ramp mitigation). A type-level Fold over a tuple collapses a mid-chain mis-wire to `never`, which is assignable to everything, so tsc reports NOTHING (probe7). A linear chain must be a sequence of localized `.from()` edges so each mis-wire errors at its own call site.
- Re-specify the fan-out `[]`-boundary brand as a NEGATIVE brand on the NORMAL handle (`NodeHandle<Out>{ readonly __fanout?: never }`), NOT a positive brand on `FanoutHandle`. A positive-only brand leaks: a FanoutHandle is structurally assignable to a plain NodeHandle (probe5). Only the negative-brand-on-target shape causes tsc to reject piping a fan-out branch.
- Re-specify merge-collision detection so it produces an actual tsc error, not an inert WiringError value. The designed `HasNever`->WiringError return produced ZERO errors because nothing consumes the WiringError (probe4). Force the never-typed collision field to be read by a required downstream mapper, or make the merge return type structurally unusable.
- Mandate that every node's In AND Out generics be inferred at a SINGLE call site. The split factory shape `b.transform<Out>().from<In>(up, fn)` loses the output type to `unknown` via TS inference ordering (probe8); the single-call `b.transform(up, fn)` infers both correctly (probe9). The API surface (one call vs chained generic calls) is load-bearing for correctness.
- Add a CI typecheck fixture suite of intentionally mis-wired workflows (wrong field, type mismatch, missing required field, fanout-piped-as-normal, merge collision, mid-chain break) asserting each produces a tsc error AT THE EXPECTED LINE. This is the only way to lock the 'readable error at the right location' guarantee, since it depends on subtle API shape that regresses silently — every broken variant above compiled clean.

### A.2 — REFUTED (confidence: high)

**Claim:** Hand-rolled checkpoint/resume on Lambda + DynamoDB gives CORRECT durability for v1 (idempotent, no double side-effects, resumes across redeploys), so Temporal/Restate is not needed in v1.

**Strongest objection (evidence):** The "we already proved this in agent-studio" framing is false, and the parts that make the claim TRUE are precisely the parts that do not exist in the reference. Reading the reference (packages/core/src/agent-studio/workflow-engine.ts executeWorkflow, lines 376-1297) shows it runs an ENTIRE workflow in ONE Lambda invocation with NO mid-run checkpoint and NO resume path: nodeResults flushing (the Engine-3 chain) is observability only, read back by a poller, never by a resume routine. A grep across the whole agent-studio dir for resumeRun/continuation/loadStepOutputs/manifestVersion/stepRunId/SIDEEFFECT/idempotencyKey returns ZERO hits. The workflowRunId is nanoid() generated fresh inside the function (line 380) — it is NOT a deterministic idempotency anchor. So step-granular checkpoint, time-budget continuation, manifest-version-pinned resume, and the side-effect ledger are ALL greenfield code with no production proof. Worse, the proven SQS handler (packages/functions/agent-executor/index.ts, lines 127-160) does coarse RUN-level dedup via create()+ConditionalCheckFailed and SKIPS the message on duplicate — the OPPOSITE of the design's executor, which patches-and-continues and then re-runs every executeToolFn in the agent loop (agent-executor.ts lines 217-515 have no per-tool ledger). The design's own RISKS section concedes this is "the single biggest exactly-once gap." Exactly-once side effects therefore rest entirely on an unbuilt SIDEEFFECT# ledger whose transactional co-write (ElectroDB 3.7.5 does expose transactWrite, so it is implementable) still cannot wrap an EXTERNAL effect (HTTP/email) inside the DynamoDB transaction — there is an irreducible crash window between "external effect committed" and "ledger row written," so a non-idempotent tool can still double-fire on redelivery. The claim conflates "the serverless topology is proven (queue+DLQ+executor+table — fr3n's agent-studio.ts confirms it)" with "checkpoint/resume durability is proven" — only the former is true.

**Resolution:** Constrain the claim to: "a hand-rolled, checkpoint-between-steps serverless runtime is SUFFICIENT for v1 correctness IF AND ONLY IF the following are all built and verified against real AWS (not dev): (1) a deterministic runId computed at the channel/trigger boundary BEFORE enqueue (never nanoid() in the executor); (2) a mandatory SIDEEFFECT# ledger PRE-CHECK on every tool dispatch path, co-written transactionally with the step-completed checkpoint via ElectroDB transactWrite, and documented as 'exactly-once effects for tools that EITHER honor a provider idempotency key OR are guarded by the ledger pre-check' — and explicitly NOT a guarantee for tools with non-idempotent external effects that crash in the post-effect/pre-ledger window; (3) the executor must DETECT terminal/awaiting_approval/pending state on redelivery and no-op (matching agent-studio's skip-on-duplicate), never re-run the tool or re-create the approval; (4) MANIFEST# rows keyed by version and never overwritten, with the FULL manifest blob snapshotted at run-start, and the state table set removal:'retain'+deletionProtection; (5) SQS visibility timeout > Lambda timeout AND the soft time-budget continuation re-enqueues under the SAME deterministic anchor with a maxContinuations->DLQ guard. Reframe v1 positioning as 'sub-step (mid-agent-loop) checkpointing is explicitly v2; v1's exactly-once contract is at the STEP boundary only.' The Runtime SEAM (submit/resume/cancel/getRun) is the actual hedge: it is what lets Temporal/Restate replace the scheduler later — keep it minimal so the unproven hand-rolled scheduler is swappable, which is the honest mitigation for the durability risk this claim understates.

**Must-fixes (folded into the plan):**
- Add a mandatory SIDEEFFECT# ledger pre-check to EVERY tool/agent dispatch path, co-written with the step-completed checkpoint via ElectroDB transactWrite (verified available in 3.7.5); document explicitly that exactly-once holds only at the step boundary and only for tools that honor a provider idempotency key OR are idempotent under the ledger pre-check — external side effects (HTTP/email send) crashing in the post-effect/pre-ledger window can still double-fire, which is the irreducible limit of hand-rolled vs Temporal/Restate.
- Move runId derivation to the channel/trigger boundary as a deterministic hash of trigger-source+dedupKey computed BEFORE enqueue; forbid nanoid()-in-executor (the reference's actual pattern). Pre-create the RUN row; the executor must PATCH-not-create AND must no-op on redelivery when status is terminal/awaiting_approval/already-completed-step — not re-run.
- Persist manifests as versioned, never-overwritten MANIFEST#<id>#<version> rows AND snapshot the FULL manifest blob (not just the version string) into storage at run-start; the draht.Agent SST component MUST set the state table removal:'retain'+deletionProtection or the 'survives redeploy' demo silently fails on the SST default removal:'remove'.
- Set SQS visibility timeout strictly greater than the executor Lambda timeout, and implement the soft time-budget continuation (re-enqueue under the same deterministic anchor) with a maxContinuations->DLQ guard to prevent infinite continuation loops; without this, a run that exceeds visibility timeout mid-step is redelivered concurrently and double-executes the in-flight step.
- Build a real-AWS redelivery+redeploy conformance harness (the dev in-process MemoryQueue path provably cannot surface at-least-once async-flush ordering races, per the design's own dev-fidelity caveat); make passing it a v1 gate, since NONE of checkpoint/resume/continuation/ledger exists in the proven reference and all of it is greenfield.
- State the v1 scope honestly: NO sub-step (mid-agent-loop) checkpointing; an agent node that makes N tool calls then dies re-runs the whole node, so the ledger is the ONLY thing preventing double effects there — make the ledger non-optional and on the hot path, not a deferred 'nice-to-have'.
- Keep the Runtime seam (submitRun/resumeRun/cancelRun/getRun) strictly minimal and free of any scheduling/level/fanout/continuation leakage so a Temporal/Restate adapter can replace the unproven hand-rolled scheduler wholesale in v2 — this seam is the real risk hedge and must be proven by writing the serverless adapter entirely behind it.

### A.3 — REFUTED (confidence: high)

**Claim:** A third-party npm package CAN ship an SST/Pulumi ComponentResource that a user instantiates in their own sst.config.ts, which provisions cleanly AND composes/links with fr3n's existing SST components.

**Strongest objection (evidence):** The claim is true in spirit but the design's load-bearing mechanism is provably unsupported. The sst@4.15.2 npm package's `exports` map (verified in node_modules/sst/package.json) exposes ONLY `.`, `./resource`, `./auth`, `./event`, `./realtime`, and a `./*` glob to `./dist/*` — it does NOT export the `Component` base class or `Link.Linkable`. The actual `Component` class lives in `.sst/platform/src/components/component.ts`, which is a DOWNLOADED, UNVERSIONED internal artifact (its package.json shows `name: @sst/platform`, `version: None`, no `exports` map), and it imports `@pulumi/pulumi` directly at the top level. Worse, the global `sst` namespace injected into run() is `components/index.ts`, and I verified that file re-exports `linkable.js` (giving `sst.Linkable`/`sst.Resource`) but does NOT re-export `component.js` — so `sst.Component` is not reachable even as a global. Therefore the design's central Decision ("export draht.Agent/draht.Workflow as subclasses of SST's Component base class") cannot be implemented as written: there is no importable, stable `Component` symbol. Confirming the supported pattern: fr3n's own infra/agent-studio.ts (and every other infra/*.ts) NEVER subclasses Component — it composes public `sst.aws.Bus/Queue/Function/Dynamo` + raw `aws.iam.Role`/`aws.cloudwatch.MetricAlarm` via globally-injected `aws.*`/`sst.*`/`$jsonStringify`. The research note that 'third-party Component subclasses work identically to SST's own Nextjs/Bus' is an over-read: those classes are SST's OWN code inside the platform bundle; they are not subclassable by external packages because the base is not exported. Secondary refutation on the 'links with fr3n's existing components' half: the only SUPPORTED third-party linking API is `sst.Linkable.wrap(cls, fn)` / `new sst.Linkable(...)` / implementing `getSSTLink()` on a wrapped resource — NOT 'implements Link.Linkable' on a Component subclass. And the shared-table linking decision is unsound: fr3n's `electro` table has a FIXED `pk`/`sk` primary index plus 10 pre-assigned GSIs (gsi1pk..gsi10pk) with existing ElectroDB semantics; draht's runtime row design assigns its own meaning to `gsi1pk=TENANT#` / `gsi1sk=STATUS#`, which would collide with fr3n's existing GSI1 usage, and a pk-prefix bug would mix draht rows into fr3n's live GSIs (the exact isolation hazard the design itself flags).

**Resolution:** Re-found the deploy surface on the ACTUALLY-supported APIs, dropping the 'extends SST Component' decision entirely. Two viable shapes: (1) a FACTORY FUNCTION `createDrahtAgent(name, props)` (not a class) that, when called inside run(), composes public `sst.aws.Queue/Function/Bus/Dynamo/Cron` + raw `aws.*` resources via globally-injected namespaces — byte-for-byte the proven agent-studio.ts pattern, just packaged — and returns an object exposing `.queueUrl/.httpUrl/...` plus a linkable made via `sst.Linkable.wrap(...)` or `new sst.Linkable(name, { properties, include })`; or (2) a genuine `class extends $util.ComponentResource` (Pulumi's ComponentResource via the injected `$util` global, NOT SST's `Component`) that registers children and then wraps itself with `sst.Linkable.wrap`. Option (1) is lower-risk and matches fr3n exactly. For TS: ship the package with NO top-level `@pulumi/aws`/`@pulumi/pulumi` imports, declare `aws`/`sst`/`$util`/`$jsonStringify`/`$app` as ambient globals (the package's own d.ts mirrors the platform's global.d.ts), and document that consumers add `/// <reference path="./.sst/platform/config.d.ts" />`. For linking with fr3n: use Linkable.wrap and pass fr3n's `table`/`agentBus` IN via props (link:[table]) and forward them to child resource link arrays — never reach into fr3n's table schema. Default to MANAGED (own) DynamoDB with removal:'retain'; make shared-table mode opt-in, isolated to a draht-owned set of UNUSED gsi indexes or (better) its OWN table, and gate it behind an isolation test. Pin `sst` as a peerDependency with a tested range and add a real sst-app smoke deploy in CI because the platform internals are unversioned and can break across minor SST releases.

**Must-fixes (folded into the plan):**
- Drop the 'draht.Agent/draht.Workflow extend SST's Component base class' decision — `Component` is NOT in sst's npm exports map nor in the injected `sst` global namespace (verified: components/index.ts re-exports linkable.js but not component.js). Use either a factory function that composes public sst.aws.* components, or a class extending Pulumi's ComponentResource via the injected `$util` global — never SST's internal Component.
- Implement linkability ONLY via the supported public API: `sst.Linkable.wrap(cls, fn)` or `new sst.Linkable(name, { properties, include })` returning {queueUrl,busName,tableName,httpUrl,manifestVersion} + an sst.aws.permission include. Do NOT claim 'implements Link.Linkable' on a Component subclass — that interface/base is internal and unexported.
- The package must contain ZERO top-level `@pulumi/aws`/`@pulumi/pulumi`/`@sst/platform` imports. Access aws.*, sst.aws.*, $util, $jsonStringify, $app, aws.iam.Role, aws.cloudwatch.MetricAlarm strictly through globally-injected scope (mirror agent-studio.ts). Ship the package's own ambient .d.ts declaring these globals so it typechecks in isolation, and document the `/// <reference path="./.sst/platform/config.d.ts" />` requirement for consumers.
- Default storage to a MANAGED own DynamoDB table (removal:'retain' + deletionProtection). Treat 'shared-table' mode as opt-in and high-risk: fr3n's electro table has fixed pk/sk + 10 pre-assigned GSIs (gsi1pk..gsi10pk) with live ElectroDB semantics; draht's gsi1pk=TENANT#/gsi1sk=STATUS# design WOULD collide. Require draht's own ElectroDB entity defs, a hard pk-prefix namespace, and a passing isolation test before shared mode is allowed.
- Pin `sst` as a peerDependency with a verified version range (tested against 4.15.x) and add a CI smoke test that actually runs `sst deploy` of a draht component in a throwaway stage. The platform internals (`@sst/platform`) are downloaded and UNVERSIONED (version: None, no exports), so any reliance on internal shapes will silently break across SST minor releases — unit tests cannot catch this.
- Provide the HTTP-channel both ways: when the host app supplies a shared `sst.aws.Router`, attach via url.router; otherwise fall back to a plain Function URL (`url: true`). The design assumes a Router exists, which fr3n may not expose to the component.
- Snapshot the FULL manifest blob into the linked/managed table at run-creation (keyed MANIFEST#<id>#<version>, never overwritten), not just the version string baked into the bundle — otherwise checkpoint/resume across a redeploy that ships a new manifest version cannot reload the original graph and the headline demo fails.

### A.4 — REFUTED (confidence: medium)

**Claim:** draht has a DEFENSIBLE reason to exist next to eve / LangGraph / Mastra / OpenAI Agents SDK — the SST-native + cloud-agnostic + multi-tenant + typed-graph + playbook combination is a real wedge, not dead-on-arrival, and the SST-partnership angle is realistic.

**Strongest objection (evidence):** The claim holds only in a narrowed form; as written it overstates three of its five pillars and one GTM sub-claim, and two of the five are no longer differentiators. (1) TYPED-GRAPH: the design repeatedly asserts "Mastra has NO automatic TypeScript type inference from upstream output to downstream input." Mastra's own docs (verified) say the opposite — steps chain via .then() and "the step's output schema will match your provided schema, enabling type-safe chaining... TypeScript can infer the correct types as data flows from one step to the next." The real, much narrower differentiator is compile-time REJECTION of a mis-wired edge (Pipe<Out,In> resolving to a WiringError literal that fails tsc at the call site) plus the FanoutHandle '[]' brand — NOT "no inference." Marketed as written, the typed-graph wedge is refutable and a credibility risk. (2) DURABILITY + APPROVAL-GATE are no longer wedges: OpenAI Agents SDK + Temporal (verified, public preview in 2026) already ships durable execution, checkpoint/resume across restarts, human-in-the-loop interrupts (pause-state-surface-resume-on-approval), AND self-host (download the SDK, run it yourself, SQLite/Redis/SQL stores). eve ships the same via Workflow SDK. So checkpoint/resume + approval gate — which the brief and designs treat as headline v1 demo goals — are TABLE-STAKES, not differentiators. (3) SST-PARTNERSHIP REALISTIC is the weakest sub-claim: SST is confirmed in maintenance mode ("active development shifted to OpenCode," per Northflank), its creator Dax Raad has moved to OpenCode, there is no SST partner program / component registry / 'sst add' path (research confirms), and 'sst add draht' requires a full Pulumi-provider wrapper the design explicitly defers. (4) MULTI-TENANT: AWS Bedrock AgentCore now offers Firecracker per-session microVM tenant isolation natively on AWS — draht's exact target cloud — while draht v1 ships only the Tenancy SEAM + single-tenant default (locked decision 9), i.e. an unproven interface, not a capability. (5) NAMING/SCOPE is a hard blocker the claim glosses: @draht/* is already used by draht-mono's local workspace and the unscoped npm 'draht' bin name is TAKEN (npm returns 200); only @draht/* and @draht-dev/* are free (verified 404). What genuinely survives and IS unoccupied: Apache-2.0 across the ENTIRE stack (LangGraph's langgraph-api production server is ELv2 — verified, GA'd — a real legal landmine for enterprise self-host) + a single Pulumi-ComponentResource/SST drop-in that provisions Lambda+SQS+DynamoDB+EventBridge into the customer's OWN AWS account (no surveyed agent framework ships this) + compile-time edge-assignability rejection + a versioned inspectable manifest the visual builder/CI can read + installable typed playbooks, all validated by a real consumer #0 (fr3n). That specific intersection is empty. So the claim is not dead-on-arrival, but the HEADLINE version (all five pillars co-equal + SST partnership realistic) is refuted; only a constrained version holds.

**Resolution:** Reframe the wedge around the two pillars that are genuinely unoccupied and durable, and demote the two that are now table-stakes. Lead with: (a) Apache-2.0-across-the-whole-runtime (the LangGraph ELv2 production-server trap is the sharpest, most legally-concrete wedge — verified real) and (b) a single Pulumi/SST-native ComponentResource that deploys a typed agent graph into the customer's own AWS account (verified absent from the market; fr3n's 193-line hand-wired agent-studio.ts proves the demand). Restate typed-graph honestly as 'tsc REJECTS a mis-wired edge at the call site' (compile-time assignability + the FanoutHandle/'[]' brand), explicitly NOT 'the only framework with inter-step type inference' — Mastra has inference, draht has stricter edge rejection. Move checkpoint/resume + approval-gate from 'differentiator' to 'table-stakes parity' messaging (still required for the demo, just not the pitch). Recast the GTM as 'Pulumi-ComponentResource-native, works in any SST OR raw-Pulumi app' — NOT 'SST partnership' — because SST is in maintenance mode; pursue Dax Raad/SST community as advocates, not as a channel. State multi-tenant as 'multi-tenant-READY interface seam (single-tenant default in v1)', never 'multi-tenant', and acknowledge Bedrock AgentCore's native per-session isolation as the AWS-native alternative draht's seam must out-flex on cross-cloud + SaaS-data-ownership grounds. Lock the npm scope to @draht/* (verified free) before any publish or fr3n pin; pick a CLI bin name that is not the taken 'draht' on npm (or scope the bin). Make the fr3n consumer-#0 demo the single load-bearing proof — a real agent re-expressed and deployed in fr3n's SST app — because the wedge is credibility-bound to having ONE non-toy user, and that is the only thing none of eve/LangGraph/Mastra/OpenAI-SDK can claim for THIS exact stack.

**Must-fixes (folded into the plan):**
- Rewrite the typed-graph positioning to claim 'tsc rejects a mis-wired edge (assignability + FanoutHandle/[] brand)', NOT 'Mastra/competitors have no inter-step type inference' — the latter is factually false (Mastra propagates types via .then()) and is a refutable credibility risk; keep the WiringError<msg> + FanoutHandle brand as the real, narrow differentiator.
- Demote checkpoint/resume-across-redeploy and approval-gated tools from 'differentiator' to 'table-stakes parity' in all positioning — OpenAI Agents SDK + Temporal and eve already ship durable execution + HITL interrupts + self-host stores; these remain required for the v1 demo but must not be pitched as the wedge.
- Recast the deploy/GTM story as 'Pulumi-ComponentResource-native, drops into any SST OR raw-Pulumi app' rather than an 'SST partnership' — SST is confirmed in maintenance mode (creator moved to OpenCode); there is no partner program, registry, or 'sst add' path in v1. Treat SST community as advocacy, not a distribution channel, and keep the Pulumi-direct fallback as a first-class path.
- State multi-tenancy strictly as 'multi-tenant-READY interface seam, single-tenant default in v1' everywhere; never claim 'multi-tenant'. Explicitly position against AWS Bedrock AgentCore's native Firecracker per-session isolation on the axes draht can actually win (cloud-agnostic seam + SaaS data-ownership + manifest-carried tenant metadata), since AgentCore beats draht on raw isolation today on draht's own target cloud.
- Resolve the npm namespace as a hard prerequisite BEFORE any publish or fr3n pin: @draht/* is already used by the draht-mono workspace and the unscoped 'draht' npm package name is TAKEN; lock @draht/* (verified free), and either scope the CLI bin or choose a non-colliding bin name.
- Anchor the entire defensibility argument on the two pillars that are genuinely unoccupied and verified — (a) Apache-2.0 across the whole runtime vs LangGraph's ELv2 production-server trap, and (b) a single drop-in component that deploys a typed agent graph into the customer's OWN AWS account — and make the fr3n consumer-#0 deployment (one real agent re-expressed in fr3n's SST app) the load-bearing proof, since 'has one real non-toy user on THIS exact stack' is the only claim none of the four named competitors can make.
- Add an explicit, honest competitive-matrix slide/section that maps each of the 5 pillars to which competitor already covers it (durability→OpenAI+Temporal/eve; approval→OpenAI+Temporal/eve/LangGraph; inference→Mastra; AWS-native isolation→AgentCore; license→draht-only; SST/Pulumi drop-in→draht-only) so the team does not internally over-believe its own differentiation and ship marketing that is trivially refuted.
