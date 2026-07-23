# SPEC — Agent Graph Event Producer & Capture

> **Date:** 2026-07-23
> **Status:** proposed
> **Owner:** Oskar Freye
> **Product:** Drahtwerk
> **Repo:** `draht-mono` (the agent harness — PRODUCER & CAPTURE)
> **Consumer / contract owner:** `2026-07-23-agent-graph-observability-projection.md` (in the `drahtwerk` repo — the Command Center PROJECTOR)
> **Domain-ownership invariant (ADR-0010 §4):** `Drahtwerk retains domain ownership; the harness owns run state. The Command Center mints no node/edge/run/verdict state the domain did not emit.`

---

## 1. One line

Turn the `draht-mono` harness into the **authoritative producer** of a versioned `draht.*` run-event stream — a `run-append` capture subcommand fired from the one reliable call site (`gsd-post-task.cjs`, mirrored across `draht-claude` and `draht-codex`), an orchestrator engine that **journals instead of deleting** run state and captures token usage verbatim, and three authoring lint smell-tests — so that a downstream projector (`2026-07-23-agent-graph-observability-projection.md`) can fold a live, honest node-edge picture of an agent run **without the harness ever committing a raw brief, losing a run on completion, or attributing its own events to the wrong domain.**

## 2. Problem and desired outcome

A GSD run today is a fan-out of subagents dispatched by the `@draht` harness and the `draht-claude` / `draht-codex` plugins: an architect plans, implementers work in parallel, reviewers and verifiers gate the result, loops retry until a check passes. That structure — a graph of typed jobs joined by hand-off edges — is real and load-bearing, but its traces are **ephemeral and destroyed exactly when they matter most:**

- `@draht/orchestrator`'s `engine.ts` writes `.orchestrator/state.json` while running (`saveState`, engine.ts:57/207) and then **deletes it on completion** (`cleanState()`, engine.ts:127/214). The graph exists only for the duration of the run.
- `executeSubTask` calls `messages.create` (engine.ts:140) and returns `{ output, duration }` (engine.ts:152-155) — the `message.usage` (tokens, cost, model) is **dropped at the return boundary.**
- The real GSD runtime — the spawn-based subagent path in `packages/coding-agent` — spawns children `--no-session` (subagent.ts:199) and returns a `RunResult` (subagent.ts:152-159) that carries `exitCode`/`output`/`stderr` but **no usage and no model**. Per-turn cost dies at the subprocess boundary.
- The only persisted trace, `.planning/execution-log.jsonl` (`gsd-post-task.cjs:54`), records at phase/plan/task granularity and **knows nothing of edges, gates, barriers, or loops.**

When a run stalls, the human silently becomes the verification loop. When it finishes, the graph is destroyed.

The desired outcome: after v1, every real GSD fan-out leaves behind a **replayable, append-only `.draht/runs/<runId>.jsonl` journal** of canonical `draht.*` records — role-typed nodes carrying a four-value lifecycle, directed hand-off edges carrying a payload **hash + size + type (never content)**, and honest `null` gaps wherever the domain has not yet emitted a number. The harness is the sole writer of this state; the Command Center projector reads it as canonical events and folds the graph. And an author can lint a plan **before** dispatch so a loop without a check, or an owner gate a green check would auto-clear, fails at authoring time.

This spec owns **production and capture only.** The read-model, the route, and the canvas belong to `2026-07-23-agent-graph-observability-projection.md`; this file never specifies a renderer (Invariant 9 — see §5).

## 3. Product principles

1. **The harness produces; it does not render.** Every node, edge, gate, and cost originates here as a domain-emitted canonical event written to an append-only journal. The projector folds it; this repo ships **no observability UI**. `draht-tools run-serve` (a would-be HTTP+SSE renderer reusing `map-serve`, draht-tools.cjs:5161) is a second observability origin and is **out of program** (ADR-0010 §9).
2. **The edge is the data flow — carried by reference, never by value.** Subagents cannot see the parent conversation, so the whole hand-off is a self-contained brief. The producer emits the edge as `{ artifactType, payloadHash, payloadBytes }` — a *reference* to that brief, never the brief. Committing `SubTaskResult.output` (types.ts:20) or a raw prompt into a journal is a leak-guard violation and is forbidden by contract.
3. **A status without an evidence label is unemittable.** Every emitted status/verdict carries `evidenceLabel ∈ { observed | derived | assumed }`. A producer-self-reported status defaults to `assumed`; a verdict inherits the **weakest** label it rests on. The harness never launders trust by emitting an unlabeled green.
4. **Owner gates are non-check-satisfiable.** The producer marks `gateKind = owner-sign-off` on a sign-off node; a passing check may advance a *data* edge but the harness **never** emits a transition that clears an owner gate. Clearing it is a domain approval, not a run event.
5. **Never fabricate a number the domain owns.** Token counts, cost, and model tier are forwarded **verbatim** from `Usage` (`packages/ai`) — or emitted as an explicit `null` gap. The producer never estimates.
6. **The plan is a hypothesis, not a ledger.** The runtime is emergent and self-routing. The lint surface checks a plan for authoring smells; it never enforces an authored topology onto the run.
7. **Disabled by default.** The journaling flag ships **off**; with it off, no `.draht/runs/` file is written and behavior is byte-for-byte today's. Journals are **gitignored** (`.gitignore:14`, `packages/*/.draht/`).
8. **One emitter, two plugins, zero drift.** The capture logic lives once in `packages/draht-tools/bin/draht-tools.cjs` and is vendored to both plugins by `sync-draht-tools.mjs`; `check-plugin-mirrors.mjs` fails CI if `draht-claude` and `draht-codex` ever emit different run records.

## 4. Goals and non-goals

### 4.1 Goals (v1)

- A `draht-tools run-append` subcommand writing normalized, append-only NDJSON to `.draht/runs/<runId>.jsonl` (gitignored; hash + size + type only), invoked from `gsd-post-task.cjs` in **both** `draht-claude` and `draht-codex` (parity guaranteed by `sync-draht-tools.mjs` + `check-plugin-mirrors.mjs`).
- `@draht/orchestrator` `engine.ts` that **journals instead of `cleanState()`** on completion and captures `message.usage` **verbatim** at the `executeSubTask` boundary; a new `journal.ts` append-only writer/reader.
- v1 anchored on the **spawn-based subagent path** (`packages/coding-agent`) where real GSD runs flow; the in-process `@draht/orchestrator` engine is a **secondary** emitter.
- Emitted records that **conform to the wire contract defined in `2026-07-23-agent-graph-observability-projection.md`** — three v1 event types (`draht.run.started`, `draht.node.status`, `draht.edge.handoff`), deterministic ids, required `evidenceLabel` — restated in §8. This repo **consumes** the contract; it does not redesign the wire shape.
- Three additive `validate-plans` graph-lint smell-tests (loop-without-check fails; owner-gate never auto-advanceable; disjoint-impact chain warns "parallelize") wired into the existing `plan-phase` step-8 gate.

### 4.2 Non-goals for v1

- **A standalone renderer in this repo.** `draht-tools run-serve` reusing `map-serve`'s HTTP+SSE (draht-tools.cjs:5161) is a second observability origin against ADR-0010 §9. Tolerable *only* as an unshipped local-dev debug aid; **out of this program.** The Command Center Hermes plugin is the sole sanctioned renderer.
- **Committing raw hand-off briefs or `SubTaskResult.output` into journals.** Leak-guard violation. Edges carry `payloadHash + payloadBytes + artifactType` only; journals are gitignored. **Killed.**
- **Anchoring v1 on the in-process `@draht/orchestrator` engine as canonical.** Its subtasks are single, tool-less `messages.create` calls (engine.ts:140) — a *second* emitter, not the flagship. Real runs flow through the spawn-based subagent + plugin `execute-phase` path.
- **Hook-driven subagent capture** (`PreToolUse`-on-Task / `SubagentStop`) as an MVP dependency — hook availability in Claude Code / Codex is unverified (`generate-hooks-json.mjs` regenerates both plugins, but the matchers are deferred). Instruction-path capture at the `gsd-post-task.cjs` call site is the reliable v1.
- **Redesigning the wire shape.** Field names, event-type names, and the envelope live in `2026-07-23-agent-graph-observability-projection.md`. This repo emits to that shape; a divergence is a bug here, not a design choice.
- **Any producer-computed cost/token rollup, inferred router rationale, or unlabeled green status.** Forward `Usage` verbatim or emit `null`/`unknown`.
- **Widening the harness to emit every forward-declared record.** v1 emits three event types; `Verdict` / `Barrier` / `Cycle` / `TokenCost` / `ModelTier` are forward-declared and populate as null-honest gaps until the harness emits them (§8, §11 milestone M6).
- **The full planning-authoring stack** — typed topology schema, a `@draht/graph-templates` / `.claude/workflows` home (exists nowhere in either repo), a web authoring pane, planned-vs-actual overlay. The runtime self-routes and there is no emitted actual graph to diff against yet. **Deferred.**

## 5. Users and trust roles

| Role | In this repo | May do | Hard boundary |
| --- | --- | --- | --- |
| **Owner / operator** (Oskar) | Runs GSD; authors and lints plans | Turn the journaling flag on; run `validate-plans`; clear owner gates *through the owning domain's approval path* | Clearing an owner gate is never a run event the harness emits; the harness only records that a sign-off gate exists and is pending. |
| **The harness (`draht` domain)** | The producer itself | **Emit** run/node/edge events; own and write the `.draht/runs/` journal | It is the only writer of run state. It never attributes its events to source `"drahtwerk"` (that is the projector/command-API domain — see §8). |
| **Command Center projection** (`drahtwerk`) | — | Read canonical events, fold, render (specified in the sibling spec) | Never tails `.draht/runs/` from disk; domain state crosses only as canonical envelopes through the projector's write path. |
| **Plugin author** | Edits `execute-phase.md`, `gsd-post-task.cjs` | Add capture calls | Any capture edit must land in **both** plugin mirrors or `check-plugin-mirrors.mjs` blocks the commit. |

Trust roles inherit ADR-0010's security consequences: a tailnet request grants no application identity; the browser receives no service credentials; reusing the dashboard session does not flatten service authorization. **In this repo, the operative consequence is upstream:** the harness must not write anything into a journal that would launder a raw payload, a secret, or an unattributable status across the projection boundary.

## 6. Ubiquitous language

These terms are the emitted records' vocabulary. They must mean the same thing in the harness, the journal, the canonical event, and the projector's fold. The **field names and canonical definitions are owned by** `2026-07-23-agent-graph-observability-projection.md`; restated here so a producer author can emit correctly.

- **Node** — one atomic unit of agent work dispatched to one specialist: a `SubTask` (`packages/orchestrator/src/types.ts:9`) in the in-process engine, or one `runAgentWithLifecycle` invocation (`packages/coding-agent/src/core/builtins/subagent.ts:350`) in the spawn runtime. Typed by **role** — the nine `packages/draht-claude/agents/*.md` files: `architect`, `implementer`, `spec-reviewer`, `reviewer`, `verifier`, `debugger`, `security-auditor`, `git-committer`, `advisor`. Carries a lifecycle chip, a role, a checkpoint SHA, isolation, and a cost reference (or `null`).
- **Edge** — a directed hand-off carrying a *reference* to one node's output into the next node's brief. `kind ∈ { handoff, fanout, fanin, back-edge, router-branch }`; annotated with `artifactType`, `payloadHash`, `payloadBytes`. **Never content.** In the spawn runtime, `runParallelTasks` (subagent.ts:433) posts to the shared `TaskBoard` = a **fan-out**; `runChainTasks` (subagent.ts:481) resolves `{previous}` from the relay mailbox = a **data edge**.
- **Run** — one `correlationId` chain: a `TaskPlan.taskId` (`types.ts:27`) or top-level dispatch. `runId = correlationId`. The journal is keyed by `runId`.
- **Verdict** — a check result or fresh-context evaluation interposed on an edge, carrying a REQUIRED `evidenceLabel`, an `evaluatorNodeId` that MUST differ from the produced-work node, and a `gateKind`. Forward-declared in v1 (§8).
- **Lifecycle / STATUS** — the four-value node status carried by `draht.node.status`: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`, plus the transient `queued | running`. `BLOCKED` and `NEEDS_CONTEXT` are first-class pause/terminal states that stop propagation — not error toasts. `execute-phase.md` already recognizes `STATUS: BLOCKED` as a hard stop ("never retry blindly"); the harness `SubTaskStatus` (`types.ts:7`) is still `pending|running|completed|failed|skipped`, so widening it is v1 producer work.
- **Journal** — the append-only NDJSON `.draht/runs/<runId>.jsonl` the harness writes and replays. It is the **ledger of record for a run** (ADR-0010 says the domain owns state); the projector's read-model is a throwaway fold over the canonical events derived from it.
- **Evidence label** — `observed | derived | assumed`. Producer-self-reported status defaults to `assumed`. A verdict inherits the weakest label it rests on.

## 7. Architectural position — who owns what

```
   draht-mono (this repo — PRODUCER & CAPTURE, owns run state)
   ┌────────────────────────────────────────────────────────────────┐
   │  @draht/orchestrator engine.ts     packages/coding-agent         │
   │  (in-process, 2nd emitter)         spawn subagent (CANONICAL v1) │
   │        │ journal.ts append           │ RunResult + message_end   │
   │        │ + message.usage verbatim    │ usage (subagent.ts:231)   │
   │        ▼                             ▼                            │
   │        draht-tools run-append  ◄── gsd-post-task.cjs call site    │
   │        (single vendored writer; mirror-checked to both plugins)  │
   │        .draht/runs/<runId>.jsonl  (gitignored; hash+size+type)   │
   │                                                                  │
   │        validate-plans graph-lint  ── plan-phase step-8 gate      │
   └────────────────────────────────────────────────────────────────┘
                          │  canonical draht.* events
                          │  (source="draht"; NOT tailed from disk)
                          ▼   ── THE SEAM ──
   drahtwerk  (2026-07-23-agent-graph-observability-projection.md)
   ┌────────────────────────────────────────────────────────────────┐
   │  §10 canonical envelope (EVENT_SOURCES += "draht")               │
   │  drahtSource.ts normalizer → buildCorrelatedEvent                │
   │  → ProjectionRouter.project() → agentGraphReadModel fold         │
   │  → GET /api/projects/:id/runs/:runId/graph (404-off)             │
   │  → RunGraphCanvas (Sessions sub-view, Hermes plugin)             │
   └────────────────────────────────────────────────────────────────┘
```

**The seam.** This repo emits `draht.*` canonical events; the `drahtwerk` projector consumes them. The boundary is the canonical envelope at `command-center/packages/transport/src/envelope.ts` and the `ProjectionRouter` write path — **not the filesystem**. The projector must never tail `.draht/runs/` from a working tree (it bypasses the projection contract and breaks under worktree/container isolation anyway). Domain state crosses the boundary only as canonical envelopes. The record shapes and the registry are **defined canonically in `2026-07-23-agent-graph-observability-projection.md`** because the envelope lives in the `command-center` repo; this repo restates and conforms (§8).

## 8. The shared wire contract (restated — owned by the projection spec)

> **Contract ownership.** This registry is **defined canonically in `2026-07-23-agent-graph-observability-projection.md`** (the drahtwerk PROJECTOR spec), because `command-center/packages/transport/src/envelope.ts` lives in that repo. This section **restates the exact record shapes the harness emits** so a producer author can conform. It is **not** a redesign; any divergence between this section and the projection spec is a bug in this file. Field names, event-type names, and the envelope shape are authoritative there.

### 8.1 Transport — ride the existing envelope, add one source

Graph events ride the **existing** `canonicalEventSchema` (`command-center/packages/transport/src/envelope.ts`): `{ id, type, occurredAt, actor, projectId, sessionId?, source, sensitivity, payload, correlationId, causationId? }`. The contract seam both specs state **identically**:

- `source = "draht"` is a **NEW distinct owning domain** added to `EVENT_SOURCES` (`envelope.ts`), landing as an additive **protocol MINOR bump**. Harness events are **never** attributed to source `"drahtwerk"` — that is the projector / command-API domain, and attributing harness run-state to it would misassign ownership under ADR-0010 §4 (domain-ownership invariant). Old consumers degrade (drop unknown fields), never reject.
- Event ids are minted by the **already-landed** `buildCorrelatedEvent` / `deterministicEventId` (`command-center/packages/projection/src/correlation.ts`): `sha256("<source> <type> <naturalKey>") → evt-<hex>`. `correlationId = runId` (the whole-graph chain); `causationId =` the parent event id (gate→node, dispatch→subagent). A stable `naturalKey` (e.g. `draht:${runId}:node:${nodeId}:${lifecycle}`) makes a re-emit a first-write-wins no-op — this is what makes the projector's fold idempotent, and it is the producer's responsibility to mint the natural key deterministically.

### 8.2 v1 event registry (`source = "draht"`)

v1 emits **three** event types. The rest are forward-declared and populate as null-honest gaps once the harness emits them (§11 M6).

| Event type | v1? | Carries |
| --- | --- | --- |
| `draht.run.started` | **v1** | `runId`, `projectId`, `description`, `origin: "observed"` |
| `draht.node.status` | **v1** | `nodeId`, `runId`, `role`, the four-value **STATUS** (`DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED`), `evidenceLabel` (REQUIRED; producer-self-reported defaults to `"assumed"`), `checkpoint` (SHA or `null`) |
| `draht.edge.handoff` | **v1** | `fromNodeId`, `toNodeId`, `kind`, `artifactType`, `payloadHash`, `payloadBytes` — **ONLY**. Never the payload/brief itself. |
| `draht.node.queued` / `.started` / `.finished` | forward | lifecycle transitions |
| `draht.gate.evaluated` | forward | Verdict (check cmd, exit code, `evidenceLabel`, `evaluatorNodeId`, `gateKind`) |
| `draht.barrier.state` | forward | Barrier (fan-in join) |
| `draht.loop.round` | forward | Cycle (bounded loop) |
| `draht.cost.recorded` | forward | TokenCost (forwarded verbatim from `Usage`) |
| `draht.advisor.consulted` | forward | advisor tier consult |

### 8.3 Record shapes the harness emits (restated from the contract owner)

```ts
// Run — one correlationId chain; runId = TaskPlan.taskId / top-level dispatch id.
type Run = {
  runId: string; projectId: string; correlationId: string; // = runId
  description: string;
  status: "planned" | "running" | "done" | "blocked" | "stalled";
  origin: "planned" | "observed";          // producer emits "observed"
  schemaVersion: string;
  rollup: {
    peakConcurrency: number;
    totalCostUsd: number | null;           // null until draht.cost.recorded arrives
    tierSplit: { steering: number; executor: number } | null;
  };
};

type Role =
  | "architect" | "implementer" | "spec-reviewer" | "reviewer"
  | "verifier" | "debugger" | "security-auditor" | "git-committer" | "advisor";

type Lifecycle =
  | "queued" | "running"
  | "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";
  // BLOCKED / NEEDS_CONTEXT stop propagation — not error toasts.

type Node = {
  nodeId: string; runId: string; role: Role;
  purpose: string;                         // one sentence
  lifecycle: Lifecycle;
  checkCmd: string | null;
  startedAt: string | null; finishedAt: string | null;
  modelTier: "steering" | "executor" | "advisor" | null;
  checkpoint: { commitSha: string; progressLogOffset: string } | null; // null → stall/missing flag
  isolation: {
    worktreePath: string | null; branch: string | null;
    network: boolean; readOnlyRoot: boolean; profileMutexHeld: boolean;
  } | null;
  costRef: string | null;                  // → TokenCost.nodeId; null = honest gap
  gateKind: "check" | "owner-sign-off" | null;
};

type Edge = {
  edgeId: string; runId: string;
  fromNodeId: string; toNodeId: string;
  kind: "handoff" | "fanout" | "fanin" | "back-edge" | "router-branch";
  artifactType: "plan" | "diff" | "check-output" | "failure-evidence" | "text-output";
  payloadHash: string;                     // REFERENCE ONLY — never content
  payloadBytes: number;
  routerPredicate: string | null;          // domain-emitted; NEVER inferred
  taken: boolean;
  gateRef: string | null;                  // → Verdict.verdictId
};

// FORWARD-DECLARED in v1 — the harness does not yet emit these; they render as
// null-honest gaps until it does. Restated so producers emit to the right shape.
type Verdict = {
  verdictId: string; subjectRef: string;   // edgeId | nodeId
  checkCmd: string; exitCode: number; result: "pass" | "fail";
  evidenceLabel: "observed" | "derived" | "assumed"; // REQUIRED; inherits weakest
  evaluatorNodeId: string;                 // MUST differ from produced-work node
  evaluatorRole: Role;
  gateKind: "check" | "owner-sign-off";    // owner-sign-off is NEVER check-satisfiable
  findings: { severity: string; category: string; summary: string }[];
};
type TokenCost = {
  nodeId: string; runId: string;
  modelId: string; modelTier: "steering" | "executor" | "advisor";
  inputTokens: number | null; outputTokens: number | null;
  costUsd: number | null;                  // folded VERBATIM from draht.cost.recorded
  evidenceLabel: "observed" | "derived" | "assumed"; source: "draht";
};
type Barrier = { barrierId: string; runId: string; joinNodeId: string;
  inEdges: string[]; arrivedCount: number; pendingCount: number;
  satisfied: boolean; waitDriverNodeId: string; };
type Cycle = { loopId: string; runId: string; backToNodeId: string;
  round: number; maxRounds: number;
  stopCondition: "check-pass" | "max-iter" | "stall" | "BLOCKED";
  failureSignature: string; stalled: boolean; committedThisRound: boolean; };
```

### 8.4 The five contract rules the producer must uphold

1. **`source = "draht"`, never `"drahtwerk"`.** Misattribution breaks domain ownership (ADR-0010 §4).
2. **Deterministic ids.** `buildCorrelatedEvent` / `deterministicEventId`; `correlationId = runId`; `causationId =` parent event id. Re-emit is a no-op.
3. **Required `evidenceLabel` on every status/verdict** (`observed | derived | assumed`); producer-self-reported status defaults to `assumed`; a verdict inherits the weakest label it rests on.
4. **`gateKind = owner-sign-off` is non-check-satisfiable.** The harness never emits a transition that clears an owner gate; a passing check may advance a data edge only.
5. **`cost` / `tokenCost` / `checkpoint` are forwarded verbatim or emitted as explicit `null` gaps** — never estimated. `Verdict` / `Barrier` / `Cycle` / `TokenCost` / `ModelTier` are forward-declared null-honest gaps in v1.

## 9. Owned surface A — `@draht/orchestrator` producer (secondary emitter)

The in-process engine is the **secondary** emitter (its subtasks are single, tool-less `messages.create` calls). It is included in v1 because its two defects are the clearest statement of the problem and both are code-verified.

| Path (`draht-mono`) | Change |
| --- | --- |
| `packages/orchestrator/src/types.ts:5` | Widen `AgentType` (currently `research \| implement \| test \| review`) toward the 9-role taxonomy, or map it to `Role` at emit time. |
| `packages/orchestrator/src/types.ts:7` | Widen `SubTaskStatus` (`pending\|running\|completed\|failed\|skipped`) to carry the four-value STATUS (`DONE \| DONE_WITH_CONCERNS \| NEEDS_CONTEXT \| BLOCKED`). Add `role`, `model`, `modelTier`, `usage`, `checkpoint` to `SubTask` (types.ts:9-17); promote `dependsOn: string[]` (types.ts:14) into first-class `Edge[]` `{ from, to, artifactType, payloadHash, payloadBytes, kind }`. Add the `GraphEvent` union + `RunHeader` + `evidenceLabel`. |
| `packages/orchestrator/src/engine.ts:127` / `:214` | **Replace `cleanState()` delete-on-complete with an append-only journal write** so the graph survives. `execute()` currently calls `this.cleanState()` at engine.ts:127 (unlinking `state.json` at :214-219). Journal the terminal state instead; emit a normalized `draht.*` `GraphEvent` per transition alongside the existing `onProgress` callback (engine.ts:70/89/106). |
| `packages/orchestrator/src/engine.ts:140-155` | **Capture `message.usage` verbatim** in `executeSubTask`. `messages.create` returns at :140; the result at :152-155 is `{ output, duration }` — extend to carry `message.usage` (input/output/cache tokens, model, cost) and emit it as `draht.cost.recorded` / `TokenCost` when M6 lands. **Hash the `depContext` output (engine.ts:73-80) as the edge `payloadHash` + `payloadBytes`; never journal the output itself.** |
| `packages/orchestrator/src/journal.ts` | **New.** Append-only NDJSON `RunJournal` writer/reader; `.draht/runs/<runId>.jsonl` (**gitignored**). `replay(runId)` rehydrates from the log without re-running. Models the append-only discipline; keeps `loadState()` (engine.ts:221) working so the `/orchestrate resume` path (extension.ts:43-61) still resumes against the journal. |
| `packages/orchestrator/src/decomposer.ts:5-36` | Emit richer planning attributes (the 9-role taxonomy, `modelTier`, uncertainty × blast-radius risk rank) as planned-vs-actual seed data. Currently emits only `research\|implement\|test\|review` + `dependsOn` (decomposer.ts:29/80). |
| `packages/orchestrator/src/extension.ts:43-61` | **Verify unchanged externally.** The `/orchestrate resume` handler loads state and re-executes; it must resume from the new journal, not the deleted `state.json`. Regression-guarded (§ Testing). |

**Leak-guard here.** `SubTaskResult.output` (types.ts:20) and the synthesized result (engine.ts:115) are raw model output — they are hashed for the edge reference and **never written to a journal**.

## 10. Owned surface B — spawn-based subagent runtime (canonical v1 emitter)

`packages/coding-agent` is where **real GSD runs flow** (`execute-phase.md` dispatches implementer/spec-reviewer/reviewer via the Task tool; those funnel into this runtime). This is the canonical v1 emitter.

| Path (`draht-mono`) | Change |
| --- | --- |
| `packages/coding-agent/src/core/builtins/subagent.ts:152-159` | `RunResult` drops usage/model (`{ agent, task, exitCode, output, stderr, step }`). **Recover usage** by reading `message_end` / `tool_result_end` from the child's NDJSON stream — already parsed at subagent.ts:231 (`event.message` is pushed to `messages`; its `usage`/`model` are on the `AssistantMessage`). Add `usage` + `model` to `RunResult`. |
| `packages/coding-agent/src/core/builtins/subagent.ts:433-462` | `runParallelTasks` posts every item to the shared `TaskBoard` (subagent.ts:438-440) = **fan-out**; emit a `draht.node.status` per worker and a `draht.edge.handoff` (`kind: "fanout"`) per dispatch. |
| `packages/coding-agent/src/core/builtins/subagent.ts:481-525` | `runChainTasks` resolves `{previous}` from the relay mailbox (subagent.ts:498/514-518) = a **data edge**; emit `draht.edge.handoff` (`kind: "handoff"`) with the prior step's output **hashed**, never carried. |
| `packages/coding-agent/src/core/builtins/subagent.ts:350-389` | `runAgentWithLifecycle` is the single funnel every mode passes through; wire `draht.node.status` emission around its FSM transitions (`REQUEST → WORKING → RESPOND → IDLE`, subagent.ts:365-382) and capture the `checkpoint` SHA + `worktree` isolation (subagent.ts:368-375) into `Node.isolation`. |
| `packages/coding-agent/src/core/builtins/subagent.ts:56` / `:199` | `onAgentFsmTransition` (subagent.ts:56) is the registration point for per-node lifecycle emission. **Note the constraint:** children run `--no-session` (subagent.ts:199), so this subgraph is currently ephemeral — the journal is what makes it survive. |
| `packages/coding-agent/src/core/multi-agent/fsm.ts:18` | **Consume.** `AgentFSMTransitionEvent` (fsm.ts:18-25) is the canonical per-node lifecycle source; `serialize`/`deserialize` (fsm.ts:111/121) already support crash-recovery rehydration for `replay`. |
| `packages/coding-agent/src/modes/print-mode.ts:106` | **Consume/extend.** `writeRawStdout(JSON.stringify(event))` (print-mode.ts:106) is the existing NDJSON transport out of every subprocess; the `GraphEvent` stream rides it. `getHeader()` (print-mode.ts:113) is the `RunHeader` precedent. |
| `packages/ai/src/types.ts` / `models.ts:386` | **Consume only.** `Usage` (input/output/cacheRead/cacheWrite + `cost`) and `provider`/`model` live on every `AssistantMessage`; `calculateCost(model, usage)` (models.ts:386-405) already derives `cost.total` from emitted token units and per-model `ModelCostRates`. Forward this **verbatim** as `TokenCost` — the harness owns these numbers; **the platform must never re-estimate them.** |

## 11. Owned surface C — plugin capture (`run-append` + `gsd-post-task`)

The single cheapest reliable capture of real runs today: one `run-append` subcommand in the vendored `draht-tools.cjs`, called from the deterministic `gsd-post-task.cjs` call site. Parity is free — the emitter is vendored to both plugins by `sync-draht-tools.mjs` (SRC at sync-draht-tools.mjs:23, `TARGETS` at :24-28: draht-claude, draht-codex, coding-agent) and every edit is guarded by `check-plugin-mirrors.mjs`.

| Path (`draht-mono`) | Change |
| --- | --- |
| `packages/draht-tools/bin/draht-tools.cjs` | **Add a `run-append` subcommand** writing normalized NDJSON `{ ts, runId, kind: "node"\|"edge", role, status, commit, parent, artifactType?, payloadHash?, payloadBytes? }` to `.draht/runs/<runId>.jsonl` — the single shared writer for both plugins. Register it alongside the existing `commands[...]` table (e.g. `validate-plans` at draht-tools.cjs:612). **Do NOT add `run-serve`** as a program surface (it would clone the `map-serve` HTTP+SSE server at draht-tools.cjs:5161 — a second observability origin; ADR-0010 §9). |
| `scripts/sync-draht-tools.mjs` | **No change beyond continuing to run.** Copies `draht-tools.cjs` from the source of truth (`packages/draht-tools/bin/draht-tools.cjs`, sync-draht-tools.mjs:23) into both plugin copies + the coding-agent bin (`TARGETS`, :24-28), so both plugins inherit identical emission for free. |
| `packages/draht-claude/scripts/gsd-post-task.cjs` | The existing recording call site: `LOG_FILE = .planning/execution-log.jsonl` (gsd-post-task.cjs:54); args `{phase, plan, task, status, commit}` (:16). **Extend** to also invoke `run-append` from the args it already receives — maps task-level records onto node/edge with **no new call sites**; keeps the **3-failure hard-stop** (gsd-post-task.cjs:150-157 — the stall bound) and the checkpoint SHA. |
| `packages/draht-codex/scripts/gsd-post-task.cjs` | **Byte-identical mirror** of the draht-claude copy (verified: `diff` reports identical today). The `run-append` extension must land here too or `check-plugin-mirrors.mjs` blocks the commit. |
| `packages/draht-claude/commands/execute-phase.md` + `packages/draht-codex/commands/execute-phase.md` | Add `run-start` before fan-out and `run-node` / `run-edge` at each dispatch and the two-stage-review edges (instruction-path capture). `execute-phase.md` already recognizes `STATUS: BLOCKED` as a hard stop — map that to `Lifecycle: BLOCKED`. Must edit **both** copies (mirror-checked; commands are checked at check-plugin-mirrors.mjs:130-132, tolerating only path-token + dispatch-phrasing dialect differences). |
| `scripts/generate-hooks-json.mjs` | **Deferred.** Where confirmed available, add a `PreToolUse`-on-Task matcher (edge-on-dispatch) and `SubagentStop` to the generated `hooks/hooks.json`; regenerates both plugins identically. **Not an MVP dependency** (hook availability unverified). |
| `scripts/check-plugin-mirrors.mjs` | The drift gate: scripts checked at :125-127, commands at :130-132, `hooks/hooks.json` at :134-139, skills at :141-157. **This is the invariant guaranteeing identical run records across Claude and Codex.** |

**Store unification.** `.planning/execution-log.jsonl` (phase/plan/task granularity, gsd-post-task.cjs:54/104) and the new node/edge journal must not become two drifting sources. The `gsd-post-task.cjs` writer is the natural single point to decide whether the journal is a superset that `execution-log.jsonl` projects from, or two stores the projector joins (Open decision §16.4).

**Leak-guard here (binding).** `run-append` records carry `payloadHash + payloadBytes + artifactType` only. Raw briefs, `SubTaskResult.output`, tool I/O, and reasoning **never** enter a journal. `.draht/runs/` is gitignored (`.gitignore:14`). The journal is written at the *consuming project's* working directory; the gitignore guard must cover `.draht/` at that project root, not only `packages/*/.draht/` (Open decision §16.3).

## 12. Owned surface D — authoring lint (three `validate-plans` graph-lint smell-tests)

Give a human a version-controlled way to lint a plan **before** dispatch. v1 keeps **only three additive smell-tests** in the existing `validate-plans` (draht-tools.cjs:612), runnable inside the current `plan-phase` step-8 gate, reusing the already-present `graph-impact` (draht-tools.cjs:5420). Everything else defers (§4.2). The tests extend the existing `issues[]` accumulation and `process.exit(1)` discipline (draht-tools.cjs:652-658), so they slot into the current gate without new plumbing.

1. **Loop-without-check fails.** Any task described as a loop/iterate that lacks a concrete `<verify>` check **plus** stop conditions is rejected (non-zero exit). Extends the existing `<verify>`/`<done>` presence checks (draht-tools.cjs:628-629). "Refuse to plan a loop node whose only stop signal is *looks done*."
2. **Owner gate never auto-advanceable.** A `checkpoint:decision` / owner-gate task must not be authored as `auto`-advanceable. Owner gates are non-check-satisfiable — a later green verifier may advance a data edge but can never clear a sign-off (mirrors §8.4 rule 4).
3. **Spurious-edge warning ("parallelize instead of chain").** Two ordered tasks whose `<files>` `graph-impact` (draht-tools.cjs:5420 — reverse-transitive blast radius) sets are **disjoint** and that name no shared hand-off artifact warn "spurious edge — parallelize." **Honest limit:** `graph-impact` reasons over the *code* knowledge graph, not agent-hand-off semantics, so it gives false confidence for non-code hand-offs (e.g. research→decision); treat this test as **advisory** for those.

Deferred authoring work, when it lands, echoes **stable planned-node ids** into the event payload so the projector's diff can join on the `naturalKey`; the authored artifact stores **only** the hypothesis + ids, never actual run state (else it becomes a second source of truth that drifts).

## 13. Security & audit

- **Disabled by default (Inv 7).** The journaling flag defaults off; with it off, no `.draht/runs/` file is written and behavior is today's. The lint tests are additive and behave as today when a plan has no loop/gate/chain smells.
- **No standalone origin (Inv 9).** This repo ships **no renderer.** `draht-tools run-serve` (a `map-serve` clone, draht-tools.cjs:5161) is explicitly out of program; the Command Center Hermes plugin is the only sanctioned renderer.
- **Payload minimization / leak-guard (binding).** Every emitted edge and journal record carries `artifactType + payloadHash + payloadBytes` **only**; raw prompts, `SubTaskResult.output` (types.ts:20), tool I/O, and reasoning never cross a boundary just to draw an edge. `.draht/runs/` journals are gitignored. Hashing happens at emit time in `engine.ts` (of `depContext`, engine.ts:73-80) and in `run-append`.
- **Correct domain attribution.** Every emitted event carries `source = "draht"`, never `"drahtwerk"`. A journal record or canonical event attributed to the projector domain is a contract violation (ADR-0010 §4).
- **No trust laundering at the source.** The harness never emits a status/verdict without an `evidenceLabel`; producer-self-reported status defaults to `assumed`. It never emits a transition clearing a `gateKind: owner-sign-off`. It never emits a `costUsd` it computed itself beyond forwarding `Usage.cost` (models.ts:386, domain-owned).
- **Parity is a security property.** `check-plugin-mirrors.mjs` guarantees `draht-claude` and `draht-codex` emit identical run records; a capture edit landing in one plugin but not the other is blocked at `npm run check` / pre-commit.
- **The projector never tails the journal.** State crosses only as canonical envelopes through the projector's write path; the harness does not expose the journal as a network surface.
- **Protocol evolution is safe.** Adding `"draht"` to `EVENT_SOURCES` plus the three v1 event types is an additive **minor** bump; fielded old consumers degrade (drop unknown fields), never reject.

## 14. Testing strategy

- **Producer regression — no more delete-on-complete.** `engine.ts` no longer calls `cleanState()` to destroy run state on completion (regression test against engine.ts:127/214); the run survives as a replayable `.draht/runs/<runId>.jsonl`. The `/orchestrate resume` path (extension.ts:43-61) still resumes against the journal.
- **Usage captured verbatim.** After a subtask, `message.usage` is present on the result (engine.ts:152-155 no longer drops it); `RunResult` (subagent.ts:152) carries usage/model recovered from `message_end` (subagent.ts:231). A `TokenCost` with a producer-recomputed `costUsd` (not forwarded from `Usage.cost`) fails a schema test.
- **Leak-guard.** Assert no edge/journal record contains raw brief content — only `payloadHash + payloadBytes + artifactType`. Assert `SubTaskResult.output` never appears in a journal. Assert `.draht/runs/` is gitignored. Adversarial: attempt to journal a brief and assert refusal.
- **Provenance is mandatory.** A `draht.node.status` / verdict serialized without `evidenceLabel` fails a schema test; producer-self-reported status defaults to `assumed`. `cost: null` / `checkpoint: null` render as explicit gaps, asserted.
- **Owner-gate non-satisfiability (at the source).** The producer never emits a transition clearing a `gateKind: owner-sign-off`; a passing check on such a node does not produce a "cleared" event. Adversarial: feed a green check and assert no clearing event is emitted.
- **Disabled-by-default.** With the journaling flag off, a real GSD fan-out writes no `.draht/runs/` file and behaves byte-for-byte as today.
- **Parity.** `check-plugin-mirrors.mjs` proves `draht-claude` and `draht-codex` emit identical run records; `sync-draht-tools.mjs --check` proves the vendored `draht-tools.cjs` matches across all `TARGETS`.
- **Deterministic ids / replay idempotency (producer half).** Re-running `run-append` with the same natural key produces a byte-identical record line; `journal.replay(runId)` rehydrates without re-executing and yields the same event sequence.
- **Lint gate.** The three smell-tests: loop-without-check exits non-zero; owner-gate `auto` fails; disjoint-impact chain warns. Runs inside `plan-phase` step 8, extending `validate-plans` (draht-tools.cjs:652-658).

## 15. Milestones and acceptance gates

The recommended v1 is **one real GSD fan-out captured end-to-end into a replayable journal of canonical events, nothing fabricated** — ready for the projector to fold. Sequenced so each step ships something testable.

- **M1 — Contract conformance (blocks on the projection spec).** The `draht.*` registry v1 (three event types), `EVENT_SOURCES += "draht"`, protocol-minor bump, and the record shapes are **defined in `2026-07-23-agent-graph-observability-projection.md`**. This repo restates them (§8) and emits to that shape.
  **Gate:** a fixture event emitted here validates against the projection spec's schema; `source = "draht"`, not `"drahtwerk"`.
- **M2 — Emission & capture (this repo, the core deliverable).** `draht-tools run-append` + `gsd-post-task.cjs` extension (mirror-gated to both plugins) emitting keystone-shaped records; `engine.ts` journals instead of `cleanState()` and captures usage verbatim; `journal.ts` new; journals gitignored, hash+size+type only.
  **Gate:** a real GSD fan-out produces a replayable `.draht/runs/<runId>.jsonl`; parity + leak-guard + producer-regression tests green.
- **M3 — Lint (parallel with M2, independent).** The three `validate-plans` smell-tests in the `plan-phase` step-8 gate. No contract dependency.
  **Gate:** loop-without-check / owner-gate-auto / disjoint-chain cases behave as specified.
- **M4 — Spawn-runtime enrichment.** Recover per-node usage from the subagent `message_end` NDJSON (subagent.ts:231); wire `onAgentFsmTransition` (subagent.ts:56) into `draht.node.status`; emit fan-out/data edges from `runParallelTasks` / `runChainTasks`.
  **Gate:** a spawn-based fan-out emits per-node lifecycle + fan-out/handoff edges with usage; still `--no-session`-tolerant via the journal.
- **M5 — Enrichment follow-ons, in priority order.** `BLOCKED` / `NEEDS_CONTEXT` as first-class emitted transitions → verifier-gate events (`draht.gate.evaluated`: check cmd + exit code + `evidenceLabel`) → `draht.cost.recorded` per node → hook-based subagent capture (once hook availability confirmed via `generate-hooks-json.mjs`) → cross-session causation for fan-out/fan-in → and **only then** planned-node ids for the projector's planned-vs-actual diff.

## 16. Open decisions

These are owner calls; the spec does not decide them. They are the producer/capture-scoped subset of the program's open questions.

1. **runId minting & stability.** Who mints `runId`, and how does it survive a fan-out and the "resume the same run, retry failed agents fresh" flow — a SessionStart id, `TaskPlan.taskId` (types.ts:27), or the orchestrator? This sets the `correlationId` and the journal key.
2. **Node key for a multi-subagent run.** Is a Node 1:1 with a geist ACP session (`nodeId ↔ sessionId`), or a sub-agent dispatch *within* a session? Determines whether `@draht` must emit a per-subagent `actor.id` the projector can group on, and whether `correlationId` is `runId` or `sessionId`.
3. **Journal ownership & location.** Per-project `.draht/runs/<runId>.jsonl`, or `CustomEntry` rows inside the existing per-session JSONL? The current gitignore (`.gitignore:14`) covers `packages/*/.draht/`; a project-root `.draht/runs/` needs its own guard. Who is the ledger of record (ADR-0010 says the domain owns state)?
4. **Store unification.** Is the node/edge journal a superset that `.planning/execution-log.jsonl` (gsd-post-task.cjs:54) becomes a projection of, or two stores the projector joins? Decided at the `gsd-post-task.cjs` writer.
5. **Cross-session causation.** Does `@draht` thread `causationId` across the dispatch→subagent→verdict hand-off (so fan-out/fan-in edges are real), or only within a single session's linear chain? Without cross-session causation, v1 emits a spine, not a graph.
6. **modelTier resolution.** Derived from the model id, read off `@draht/ai` `ModelCost` (models.ts:386), or a per-agent pinned attribute set at decompose time (decomposer.ts)?
7. **Edge payload minimization vs. debuggability.** Store only hash+size+type (spec default, leak-guard), or a redacted excerpt behind a scope check? Any excerpt needs an explicit owner decision.
8. **Hook availability.** Does Claude Code fire `SubagentStop` / `PreToolUse`-on-Task, and does Codex have an equivalent (`generate-hooks-json.mjs`)? Determines whether M5 subagent capture is hook-driven (reliable) or stays instruction-driven.
9. **Non-idempotent mutex emission.** How is the single-persistent-profile-job mutex / no-auto-resume-after-reboot constraint emitted so `Node.isolation.profileMutexHeld` renders as a **hard constraint**, not a layout hint? (No mutex/no-resume signal is emitted today.)
10. **Lint hardness.** Is `graph-lint` a hard gate (exit non-zero blocks like `validate-plans` at draht-tools.cjs:657) or advisory, given legitimate emergent divergence and the risk that an over-strict gate pushes authors to bypass it?