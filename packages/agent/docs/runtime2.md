# AgentHarness `runtime2/` implementation status

## Goal

Build a second AgentHarness runtime from the bottom up under:

```text
packages/agent/src/harness/runtime2/
```

It must eventually export:

```ts
export async function createAgentHarness<
  TContext extends object | undefined = object | undefined,
>(
  options: AgentHarnessOptions<TContext>,
): Promise<{
  harness: AgentHarness<TContext>;
  suspended: SuspendedOperation[];
}>;
```

Runtime2 replaces runtime1 through [WP00](work-packages/00-runtime1-removal.md), before further execution behavior is added. [WP01](work-packages/01-bound-values-lists.md) then converts the retained Session/storage surface across all existing backends. Do not release while the public runtime2 execution path is incomplete.

`harness.md` Part 8 and concrete `work-packages/*.md` files are the only active package plan. The R2.x sections below record historical checkpoints and design evidence; they are not executable work packages and must not override a handoff.

## Current baseline

Current pushed `dev` head:

```text
03f576f54 feat(agent): inspect restored runtime2 operations
├── 5030a5f53 feat(agent): add runtime2 harness config
├── d5d656d4e feat(agent): add runtime2 lane creation
├── 0697589ac fix(agent): tighten runtime2 harness boundaries
└── earlier runtime2 restore/facade/close commits
```

Runtime2 currently consists only of concrete `Harness` and `Lane` implementations plus restore/types. There is no separate runtime/controller abstraction. The oversized R2.4 acceptance/drive attempt was deliberately reverted in full; no TypeScript or test changes from that attempt remain. The focused runtime2 suite is back to the committed 44 tests across:

- `runtime2/restore.test.ts`
- `runtime2/lane.test.ts`
- `runtime2/harness.test.ts`

Current invariants:

- one restore constructs authoritative owned `LaneState`;
- all lane-control writes route through `Lane.command()` and `Session.mutate()`;
- command planners make state-dependent decisions under the lane line and return explicit `commit`, `return`, or `reject` outcomes;
- commit commands publish memory after commit and synchronously materialize from `CommitResult`;
- committed values and owned state are immutable snapshots updated only by replacement;
- providers, tools, hooks, timers, events, and task waits stay outside the lane line;
- the Lane-backed `sessionTree` routes leaf/branch reads and idle/run appends through owned state;
- close/fault seal lanes before queued work can proceed, while admitted successful commits still publish;
- harness creation never writes durable suspension; `suspension` is process-local inspection metadata and clears when committed ownership moves to another operation or idle;
- durable control `running` means open/permitted; public `running` will mean a real process-local drive owns an actual continuation;
- do not install a process owner, join promise, or `running` status around an effect-free classification shell; ownership lands with the first real drive procedure;
- missing identity payloads are `{ tools: string[]; model?: string }`; one lane configuration can reference only one model;
- runtime1 remains production-selected only until WP00 switches the factory and deletes it.

Latest committed validation before the reverted experiment: 44 focused runtime2 tests, 156 focused tests, full TypeScript, `git diff --check`, and `npm run check` passed. Revalidate after implementing the redesigned contract below.

## Slice completeness rule

A slice must close the entire named concern at parity, not only its immediately callable methods. Before editing, inventory all related constructor inputs, owned state, defaults, validation, public accessors, events, lifecycle behavior, recovery implications, and tests. Do not defer adjacent behavior merely because no current procedure consumes it yet. If scope must be deferred, name that boundary before implementation and get explicit agreement.

## Reading policy

`packages/agent/docs/harness.md` is the normative source. Until their designs are folded into it, `registers.md`, `tool-durability.md`, and `assistant-durability.md` are binding handoffs for bound typed value/list addresses, tool outcomes/checkpoints/memos, and assistant frames. Runtime1 is implementation inspiration only: do not preserve its abstractions, internal bookkeeping, or accidental behavior unless the normative contract independently requires them. For each slice, read its listed sections completely. If any handoff or `harness.md` changed since the previous slice, inspect that diff and reread affected sections.

Read a source or test file completely before editing that file. For dependencies that will not be edited, begin with the relevant exported types or functions and expand only when a concrete question requires it.

Do **not** pre-read later runtime phases. In particular, R2.0 must not load assistant procedures, tool procedures, or the complete R2–R4 behavioral suites. The purpose of the slices is to keep both implementation and reasoning local.

This plan is implementation guidance, not source authority. `harness.md` remains normative; correct this file whenever it disagrees with committed behavior or that contract.

### R2.0 — Restore one lane

Read:

- `harness.md`: §§0.2–0.3, 0.7–0.8, 1.3–1.4, 3.1–3.3, and 4.4;
- the lane/configuration/operation definitions in `packages/agent/src/harness/session/types.ts` and built-in address constructors in `session/values.ts`;
- repository/session helpers needed by the focused restore test;
- only the exported shape of the existing `restoreLane()` when comparing terminology.

Do not read runtime1 procedures or R2–R4 behavior tests. Runtime2 intentionally trusts committed internal values and does not copy runtime1's semantic restore audit.

### R2.1 — Restore a configured session

Read:

- `harness.md`: §§2.3, 2.8, and the lane inventory portions of 4.4;
- completed `runtime2/types.ts`, `runtime2/lane.ts`, and `runtime2/restore.ts`;
- address-based `Session.getValue()`, `Session.scanValues()`, `Session.readList()`, and `Session.mutate()` signatures in `session/types.ts`;
- focused session tests only when a repository helper is needed.

Do not read runtime1 initialization, provider, assistant, tool, or full harness-facade implementations.

### R2.1a — Lane owner and transition kernel

Read:

- `harness.md`: §§1.4, 3.4, 4.3, 4.7–4.8, and invariants 2, 21–23;
- completed runtime2 restore/session-loader files;
- `packages/agent/src/harness/session/lane-mutations.ts`;
- `SessionMutator`, `Transaction`, and `CommitResult` definitions in `session/types.ts`;
- focused mutation-line and instrumented-storage tests only when needed for test helpers.

Do not read provider, assistant, tool, or full harness-facade implementations.

### R2.2 — Main seeding and runtime shell

Read:

- `harness.md`: §§2.3, 2.8, 4.4–4.5, and 5.2;
- completed runtime2 restore/session-loader files;
- main-lane creation and configuration-seeding portions of `session/session.ts`;
- only constructor/seeding cases in `agent-harness-runtime.test.ts`.

Do not read live assistant or tool procedures, and do not reintroduce runtime1's semantic restore audit.

### R2.3 — In-memory reads, config, lanes, and close

Read:

- `harness.md`: §§2.3–2.4, 4.3, 4.7–4.8, 5.1–5.5;
- config, lane registry, facade delegation, close, and fault portions of `runtime/agent-harness-runtime.ts`;
- query/configuration/public-session-view portions of `runtime/lane-runtime.ts`;
- `packages/agent/src/harness/events.ts` and `hooks.ts` only for surfaces this slice instantiates;
- corresponding shell/configuration/close tests in `agent-harness-runtime.test.ts` and session tests.

Do not read operation execution procedures.

### R2.4 — Contract reconciliation and atomic run acceptance

Read completely before editing:

- this document's “Superseding hook and execution design” and R2.4 section;
- the current diff of `harness.md`, then §§3.1–3.6, 4.1–4.4, 5.1–5.3, 5.5–5.6, build rows R1–R2, and matching invariants/races; these sections still contain superseded hook semantics and must be reconciled first;
- current `runtime2/harness.ts`, `lane.ts`, `types.ts`, `restore.ts`, and all focused runtime2 tests;
- public request/result/event/hook types in `agent-harness.ts`;
- neutral `hooks.ts`, `skills.ts`, `prompt-templates.ts`, bound value/list addresses and transaction helpers, and pending-entry reads;
- runtime1 acceptance only to inventory production/public-contract consequences, never as architecture;
- acceptance and restore cases in `agent-harness-r2.test.ts` and `restore.test.ts`.

Do not read provider/tool procedures or implement ownership in a no-work shell. Neutral harness imports remain allowed; `runtime2/` must never import `harness/runtime/*`.

### R2.5 — Minimal no-tool run parity

Read:

- `harness.md`: §§3.2, 3.7, 3.12–3.13, 4.1–4.2, 5.5–5.8;
- `registers.md` assistant-frame consumer and `assistant-durability.md` fresh-stream/settlement sections;
- pi-ai's exported assistant-message frame converter/reducer;
- `execution/assistant.ts`;
- checkpoint, ordinary-ready/intent/settlement, and terminal paths in:
  - `runtime/run-driver.ts`;
  - `runtime/checkpoint-procedure.ts`;
  - `runtime/assistant-procedure.ts`;
  - `runtime/transitions.ts`;
- `execution-assistant.test.ts`;
- `agent-harness-r2.test.ts`;
- only R2-relevant restore cases in `restore.test.ts`.

Do not read R3 recovery/retry or R4 tool cases except where they share a type already established in R2.0.

### R2.6 — Generation recovery and retry parity

Read:

- `harness.md`: generation/deferred portions of §§3.2, 3.7, 4.4–4.6, and R3 rows in Parts 8–9;
- `assistant-durability.md` recovery, cancellation, deferred, snapshot, and race sections;
- assistant recovery, retry-wait, missing-identity, and deferred-suspension paths in `runtime/assistant-procedure.ts` and `runtime/run-driver.ts`;
- retry/deferred classifiers in `runtime/transitions.ts`;
- `agent-harness-r3.test.ts`;
- R3-relevant cases in `restore.test.ts`.

Do not read tool-batch implementation or R4 tests.

### R2.7 — Tool parity

Read:

- `harness.md`: §§3.8, 4.5–4.6 tool portions, 5.6–5.8 tool portions, and the R4 rows in Parts 8–9;
- `tool-durability.md` completely;
- `execution/tools.ts`;
- `runtime/tool-batch-procedure.ts`;
- the tool transition helpers used by that procedure;
- `execution-tools.test.ts`;
- `agent-harness-r4.test.ts`;
- tool-batch cases in `restore.test.ts`.

Read assistant code only in the slice where assistant settlement creates a tool plan.

### Expanding a slice's reads

If implementation exposes a concrete dependency not listed above:

1. state the specific unresolved question;
2. locate the smallest defining source or test with `rg`;
3. read that file or relevant section;
4. do not recursively read its entire dependency graph;
5. add it to this plan's slice list if future agents will need it.

## Value/list and durability prerequisites

Before further assistant/tool runtime slices, implement `registers.md` repo-wide:

- replace global namespace/value maps and register tokens with `value<T>(namespace, key?)` and `list<T>(namespace, key?)`;
- put direct built-in address constructors in `session/values.ts`, using the universal `value()`/`list()` constructors and the `pi.*` namespaces/key grammars documented by `registers.md`;
- expose `getValue`/`setValue`/`deleteValue`/`scanValues` and `readList`/`appendList`/`deleteList` without a second key argument; core lane inventory and cleanup use only the five exported `*Prefix` constructors as `scanValues` inputs;
- add backend-conformant append/read/whole-list-delete storage;
- add `pendingAssistantFrames(operationId, responseEntryId)` as a `ValueList<AssistantMessageFrame>` constructor.

Namespace `pi` and every `pi.*` namespace are reserved for built-ins by contract. Core and applications use the same `value()`/`list()` constructors; application misuse is a trusted-programming defect, not a runtime rejection. Runtime2 imports built-in addresses directly; do not add a private constructor, privilege token, bundle, catalog, runtime registry, `ValuePrefix` type, or runtime-specific storage abstraction. Every call receives an already-bound address. Stable physical namespace/key pairs preserve existing durable data; the new list table/records are a storage schema addition.

R2.5 owns fresh assistant frame append and cleanup. R2.6 owns frame-based generation/deferred recovery and snapshots. R2.7 owns `outcome_ready`, invocation memos, and tool checkpoint values exactly as specified by `tool-durability.md`.

## Non-goals until parity

Do not implement or mix in:

- R5 inbox/configuration/write behavior (`pendingNextRun` placement during R2.4 acceptance is the explicit exception; enqueue/cancel/consume behavior remains R5);
- checkpoint hook;
- caller-reserved queue IDs;
- explicit owner-requested failure;
- application-state semantics beyond migration to application-defined bound addresses;
- durable state-shape normalization unrelated to the specified tool lifecycle;
- summary/navigation slices beyond currently implemented R1–R4 behavior;
- structural-summary partial-frame persistence;
- compatibility shims between runtime1 and runtime2 internals.

## Core principle

Each lane has one in-memory owner while the harness instance exists.

```text
create harness
→ restore each lane once
→ lane owns current leaf/config/queues/operation/last-result in memory
→ all lane-affecting commands serialize through that owner
→ compute private next state + exact transaction
→ commit
→ replace in-memory state
→ publish observations
```

External effects never hold the lane command line:

```text
lane command: commit intent and publish pending state
→ provider/tool/hook/timer effect outside lane owner
→ lane command: settle against latest in-memory state
```

A crash discards memory. The next `createAgentHarness()` restores the committed state again.

### Commit ordering

Never mutate the owned state before storage commit succeeds.

Correct:

```text
current S0
→ private candidate S1
→ commit durable writes for S1
→ lane.current = S1
```

Incorrect:

```text
lane.current = S1
→ commit
→ attempt rollback on failure
```

The lane command remains serialized through commit and the memory replacement. A queued command sees either S0 before the transition or S1 after it, never an uncommitted state.

## Target directory rule

Runtime2 source must never import `../runtime/*.ts`. Copy the small primitive it needs into `runtime2/`, or move genuinely shared code to a neutral harness module. Runtime2 owns `Config`; do not reintroduce `RuntimeSettings`, a Runtime controller, or settings-line terminology.

Create files only as a slice needs them. Do not scaffold the final directory with empty modules.

Likely eventual shape—not a mandate:

```text
runtime2/
  index.ts                 eventual stable runtime2 export
  types.ts                 lane/config types
  state.ts                 exhaustive refinements/invariants
  lane.ts                  owner + commit-then-publish kernel
  restore.ts               one-time durable restore into lane memory
  harness.ts               facade, registries, config, close
  operation.ts             drive ownership/fencing
  run.ts                   direct phase dispatch
  assistant.ts             intent/effect/settlement/recovery
  tools.ts                 batch intent/effect/outcome/recovery
  checkpoint.ts            checkpoint/terminal procedure
```

Merge modules when that is easier to read. Do not create helper files solely to reduce line counts.

## Public/test switching strategy

Runtime2 currently exports `createAgentHarness()` from `runtime2/harness.ts`. Add `runtime2/index.ts` only when constructor aliasing/test-selection work begins, then make it the stable runtime2 export. Until then, unimplemented runtime2 methods use the local `SliceNotImplemented` frontier from `runtime2/types.ts`.

Do not change the production import in:

```text
packages/agent/src/harness/agent-harness.ts
```

until parity.

### Preferred test selection

Add a runtime2 Vitest config or test alias that redirects only:

```text
./runtime/agent-harness-runtime.ts
```

as imported by `agent-harness.ts`, to:

```text
./runtime2/harness.ts
```

This allows existing tests to continue importing public `AgentHarness` unchanged. First prove the alias with a tiny constructor-selection test; do not trust an unverified Vite alias.

If exact aliasing is unreliable, use a test-only constructor:

```ts
import type { AgentHarnessConstructor } from "../../src/harness/agent-harness.ts";
import { createAgentHarness } from "../../src/harness/runtime2/harness.ts";

const Runtime2AgentHarness: AgentHarnessConstructor = {
  create: createAgentHarness,
};
```

Then parameterize only the scenarios runtime2 currently supports. Do not add a mutable production-global runtime selector.

When constructor aliasing begins, add `runtime2/index.ts`, point tests at that stable export, and verify selection with a tiny constructor test. At final parity, switch the one production import to `runtime2/index.ts`, run every existing test unchanged, then remove runtime1 in a separate reviewed change.

## Size and readability gates

Measure after every slice:

```bash
find packages/agent/src/harness/runtime2 -name '*.ts' -print0 | xargs -0 wc -l
```

Targets are diagnostic, not an excuse for compressed code:

- lane transition kernel: target ≤ 250 lines;
- restore projection: target ≤ 250 lines;
- facade/settings/close at R1 parity: target ≤ 450 lines;
- no procedure file above 700 lines without explicit review;
- R2 minimal no-tool parity: target total ≤ 2,000 lines;
- R3 recovery/retry parity: target total ≤ 2,800 lines;
- R4 tool parity: target total ≤ 3,400 lines.

Stop and review if:

- runtime2 exceeds a gate by more than 20%;
- `restoreLane()` appears in an ordinary live transition;
- the same ownership/phase check appears in three procedures;
- a generic context object accumulates unrelated runtime methods;
- a module cannot explain its protocol in one sentence;
- code size is moving toward runtime1 without additional behavior.

Do not reduce lines by hiding transitions behind a generic reducer or callback framework.

# Historical runtime2 checkpoints

These sections explain how the current runtime2 shell was produced and preserve later design discoveries. They are not the active sequence. Execute only a concrete work-package handoff linked from `harness.md` Part 8.

## R2.0 — Restore one lane

### Goal

Load the current committed control values for one configured lane into a small process-local `Lane` without starting work or interpreting the state.

### Files

Create only:

```text
runtime2/types.ts
runtime2/lane.ts
runtime2/restore.ts
packages/agent/test/harness/runtime2/restore.test.ts
```

### Contract

`LaneState` is the direct in-memory projection of:

```ts
laneLeaf(lane)
laneConfig(lane)
laneState(lane)
laneLastResult(lane)       // when present
operationMeta(operationId)  // when currentOperationId is non-null
operationState(operationId) // when currentOperationId is non-null
```

`Lane` owns its name and one `LaneState`. It does not implement `AgentLane` yet.

Restore trusts committed internal values. It checks only that values required to construct the projection exist. It does not:

- validate referenced entries or semantic phase relationships;
- hydrate entries, pending payloads, preparations, or tool arguments;
- infer state from the transcript;
- enumerate lanes or seed main configuration;
- create hooks, events, effects, timers, drives, or public facade stubs.

Exact durable payload reads remain available to the later procedure that needs them. Live operation/phase/effect checks remain required when asynchronous work settles; they are concurrency fences, not restore validation.

### Tests

- idle configured lane;
- optional latest result;
- open operation metadata and state;
- no interpretation of referenced payload ids;
- missing required lane value;
- missing current operation metadata/state.

### Stop condition

Report source and test line counts, focused test result, TypeScript result, and whether any additional runtime2 abstraction was required. Do not add a lane mutation kernel or session-wide loader yet.

## R2.1 — Restore a configured session

### Goal

Load every configured lane in one existing session into memory without starting work.

### Contract

Add one small session loader:

```ts
restoreSession(session: Session): Promise<Map<string, Lane>>
```

It calls `scanValues(laneLeafInventoryPrefix())` for the trusted lane inventory, requires `main`, and calls runtime2's one-lane restore exactly once for each listed lane under that lane's session mutation line. It does not seed configuration, scan other namespaces for orphaned values/lists, validate semantic state, or construct a public harness.

### Required tests

- configured main-only session;
- multiple configured lanes;
- open operations remain loaded and inert;
- missing `main` rejects;
- no hooks, providers, tools, timers, or writes;
- each lane is restored exactly once.

### Stop condition

Report code size and focused tests. Do not add main seeding, a public factory, or lane mutation behavior.

## R2.1a — Lane owner and transition kernel

### Goal

Prove commit-then-publish on the real session mutation line without AgentHarness, providers, tools, hooks, events, or lifecycle machinery.

### Kernel contract

`Lane.transition()` accepts a synchronous planner. Inside `Session.mutate()` it:

1. plans a transaction, candidate state, and result from current memory;
2. commits the transaction;
3. replaces lane memory only after commit succeeds;
4. returns the planned result before releasing the lane line.

External async effects cannot be passed through the planner. Storage-assigned entry metadata and observation publication are added only when a concrete transition requires them.

### Required tests

1. Memory remains unchanged while commit is pending.
2. Commit failure leaves memory and storage unchanged.
3. A queued transition is not planned until the prior commit publishes memory, then sees that memory.

### Stop condition

Report line count and focused tests. Do not add lifecycle faulting, close, observations, or execution behavior.

## R2.2 — Main seeding and runtime shell

### Goal

Seed an unconfigured `main`, call `restoreSession()`, and place the resulting lane map under one runtime2 harness shell without starting work.

### Behavior

- validate only constructor options needed to build the immutable lane seed;
- commit the seed when `main` has no configuration;
- call runtime2's configured-session loader;
- create no drive task/provider/tool/hook/timer;
- expose the exact `createAgentHarness()` signature only when the shell can satisfy it without casts or a speculative abstraction framework.

### Required tests

- fresh session/main seeding;
- configured lanes are never overwritten by the seed;
- idle and open multi-lane restore;
- last result loaded once;
- no effects during create;
- no full restore after construction.

### Stop condition

The runtime2 shell owns the restored lane map. Do not implement operation acceptance or execution.

## R2.3 — In-memory reads, config, lanes, and close

### Goal

Make non-execution surfaces use owned memory.

### Completed

- `Harness` and `Lane` are the concrete `AgentHarness` and `AgentLane` implementations; there is no separate runtime/controller layer.
- `Lane.command()` is the central effect-free serialized primitive with explicit `commit`, `return`, and `reject` outcomes.
- Commit commands support bounded reads, one durable commit, memory publication, and synchronous `CommitResult` materialization.
- Lane configuration getters/setters derive queued updates from current owned memory.
- Lane lookup/listing and leaf/last-result reads use owned memory.
- The `sessionTree` facade routes leaf/branch reads and idle/run appends through `Lane`; application values and lists remain Session-owned.
- Close and fault synchronously seal every lane; close drains admitted session work without durable cancellation.
- `Harness.createLane()` calls `Session.createLane()` directly with the captured seed, publishes a known idle candidate after commit, maps expected Session errors, and emits `lane_created` after map publication.
- Harness-global config is one replace-only process-local `Config` snapshot. It captures mutable registries/policies plus immutable execution inputs (`systemPrompt`, `toolContext`, provider conversion, projectors, telemetry, drive mode, and tool-execution mode). Setters validate, publish synchronously, then emit `config_update`; no second mutation line exists.
- Shared config defaults, validators, and missing-identity classification live in `packages/agent/src/harness/config.ts` and are used by both implementations.
- Restored suspension descriptors hydrate run prompts and deferred handles once, classify captured missing identities, and stay owned by their lanes.
- `Lane.inspectExecution()` and `Harness.lanes()` read the same owned state without storage access.
- Application-defined values and lists pass directly through the Session facade while lanes are idle or active.
- Focused tests cover ordering, commit failure, fault publication, close, no-commit promise boxing, expected rejection, appends, restore, lane creation, config, inspection, suspension classification, and application values and lists.

### Remaining R2.3 work

None. Watch surfaces have no runtime1 implementation and remain a later separate concern.

### Session boundary decision

Harness-owned lane/tree/operation writes route through `Lane.command()`. Application value/list reads and writes remain direct Session operations because they do not mutate lane control state.

## Superseding hook and execution design

The earlier R2.4 plan above was wrong. It put `before_run` inside acceptance, which forced an admission reservation, waiting appends, provisional ownership, two acceptance commands, and close/fault races before any durable operation existed. The rejected implementation then rebuilt runtime1's context/procedure shape through `OperationHost`, `OperationLocalState`, arbitration unions, and a fake `ActiveDrive` around a command that had no work. All of that code was reverted.

### Contract decisions

1. **`accept()` is one atomic lane command.** It normalizes and validates state-independent input outside the line, then under `Lane.command()` checks `state.operation`, captures current `pendingNextRun`, preflights identities, and commits caller/captured entries, leaf, `pi.op.meta`, `pi.op.state`, and `pi.lane.state`. There is no hook, provider, timer, process reservation, or process owner in acceptance. Concurrent accepts serialize naturally; the loser sees the committed operation and returns `LaneBusy`. An empty caller request with no captured entry still rejects; a later hook cannot rescue it.
2. **A run is accepted in durable `{ kind: "starting" }` phase.** This payload-free phase is the only applied-once marker for initial durable extension context. It replaces acceptance-time hook output and avoids another stored value/flag.
3. **`before_run` moves to the driver and returns only durable messages.** On the first real drive of `starting`, after ownership and deadline/cancellation checks, run the hook outside the line. Its consuming command appends returned messages and commits `starting → checkpoint` atomically. Crash before that commit may rerun the hook; crash after it cannot. Hook invocation is at-least-once, while its core-interpreted durable output is applied once. Injected messages become a stable conversation prefix and preserve provider KV-cache ordering.
4. **Add `before_drive` as a pass prerequisite.** It runs once per newly installed real drive owner before recovery or ordinary effects; same-operation joiners do not rerun it. It runs again after yield, retry wait, deferred/missing-identity suspension, and process restart. Under `cancel_requested`, reconciliation wins and ordinary prerequisites do not run. A prerequisite failure rejects that drive pass without faulting the harness or writing durable progress; close/abort must interrupt or win through the normal gate.
5. **Delete `before_resume`.** Extensions should not depend on process-origin categories. Durable phase decides dispatch/recovery. There is no public or internal `fresh | continue | restore` taxonomy. An unowned `effect_pending` phase is orphaned by construction once real owners span every admitted effect.
6. **Delete `resumeData` and stable hook-ID routing.** Extension-private durable state belongs in extension-owned bound value/list addresses or audited custom entries keyed by lane/operation ID. Such writes are separate transactions and may orphan/replay; extensions own idempotency and cleanup, matching the exactly-once non-goal. Do not add transactional hook value writes until extension namespace, lane/session scope, version, and fork policy are designed explicitly.
7. **Delete hook-produced durable `systemPromptOverride`.** Remove it from `before_run`, `BeforeResumePrepared`, and `OperationMeta`. Widen request-time `transform_context` to receive/return `{ messages, systemPrompt }`. Repeating the same effective system prompt preserves its cache key; changing it or earlier messages invalidates the prefix by design. Use `before_run` for durable message injection, not per-request `transform_context`.
8. **Install a process owner only around real asynchronous work.** `before_drive`/`before_run` are real work, so the slice that implements them may install one simple Lane-owned work promise before invoking them. The model is direct: `accept()` checks durable `state.operation`; `drive()` joins the matching promise or installs one promise and starts actual work after the line. Do not add a controller, host adapter, local-state wrapper, action interpreter, or fake frontier pass.

### Hook API target

```ts
before_run: {
  event: { prompt: AgentMessage[]; resources: Resources };
  result: { messages?: AgentMessage[] } | undefined;
};
before_drive: {
  event: { operation: "run" | "compaction" | "navigation" };
  result: void;
};
transform_context: {
  event: { messages: AgentMessage[]; systemPrompt: string };
  result: { messages?: AgentMessage[]; systemPrompt?: string } | undefined;
};
```

`HookInvocation` continues to add `lane` and `runId`. `before_run` is an at-least-once durable-settlement hook. `before_drive` is a fail-closed pass prerequisite. `transform_context` is request-local and replayed per provider request. Stable registration IDs are optional metadata only, not a durability protocol.

### Durable transitions

```text
idle accept
→ TX[ captured nextRun entries, caller entries, pending deletes,
      pi.lane.leaf, pi.op.meta(run prompt ids only),
      pi.op.state(run starting, running control, captured run settings, empty inbox),
      pi.lane.state(currentOperationId, captured ids removed) ]

starting + running control
→ before_drive
→ before_run
→ TX[ injected message entries, pi.lane.leaf when injected,
      pi.op.state(checkpoint need_assistant(false), trigger=newest entry,
               skipInboxOnce=true, preserve concurrent inbox/control) ]

starting + cancel_requested
→ cancellation reconciliation and aborted terminal transaction;
  invoke neither before_drive nor before_run
```

Restoring `starting` reports the open run with caller prompt only and starts nothing. Public appends after acceptance already see an active run and enter its inbox; there is no pre-acceptance waiting window.

### Request reconstruction and cache discipline

DeepSeek Harness's useful precedent is that model-visible injected context becomes durable before dispatch, dynamic context snapshots are appended only when changed, and effective request headers can reconstruct requests. Pi should not copy Cordis or event sourcing, but R2.5 must decide before implementation whether to persist the effective model identity, stream options, system prompt, transformed message ordering, and tool schema identity before provider dispatch, or explicitly require deterministic/idempotent request transforms and accept weaker reconstruction. Do not casually use `transform_context` for timestamps, workspace notices, policy state, or other durable run context; place those through `before_run`.

### Broader hook audit to resolve before later slices

- Keep `before_request` for provider-neutral request options.
- Reconsider `before_payload`: provider-specific wire mutation likely belongs in provider-adapter middleware.
- Split tool policy from mutation: a monotonic allow/deny/ask guard cannot be overridden by listener order; an around-tool seam owns timeout/retry/tracing/cache/signal lifetime; a result transform precedes commit; a passive final-result event follows normalization and commit.
- Reconsider `before_tool.args`: rewritten effective arguments currently disappear when operation-owned values are cleaned while the assistant entry retains original arguments, weakening auditability. Either remove rewriting or preserve effective arguments durably.
- Prefer one configured compaction service and one branch-summary service over first-result-wins provider hooks; retain separate veto policy only if needed.
- Replace latest-follow-up-wins `before_run_end` with an explicit `before_finish` continuation contract if multiple handlers can contribute.
- Extension registrations eventually need scoped install/dispose and namespaced values/lists, but do not import a DI/plugin framework.

### Exactly-once statement

No external hook is globally exactly once. Core guarantees only that a hook's interpreted output commits before dependent durable progress. A crash before the consuming transaction may repeat the hook. External side effects require extension-owned idempotency keyed by stable operation/invocation IDs. `before_drive` is intentionally repeated per owned pass.

## R2.4 — Contract reconciliation and atomic run acceptance

### Required preparation

The current `harness.md`, shared `HookMap`, `OperationMeta`, runtime1 behavior, and parity tests still describe the superseded pre-acceptance hook/resumeData/systemPromptOverride contract. Reconcile the normative document and public type strategy before implementation. This is a real contract change. Because runtime1 remains production-selected and shares the public types, explicitly decide whether to update runtime1 to the new contract, isolate the experimental runtime2 contract temporarily, or move the production switch earlier. Do not silently preserve compatibility shims.

### Goal

Implement the smallest complete concern: the revised public/durable contract plus one-command prompt/skill/template acceptance into `RunPhase.starting`. Do not install drive ownership unless this same slice also implements real `before_drive`/`before_run` work and the `starting → checkpoint` transition.

### Required behavior

- prompt, skill, and prompt-template normalization;
- write-nothing `Closed`, `LaneBusy`, missing-identity, pending-assistant, unknown-resource, and empty-input results;
- captured `pendingNextRun` placement/deletion before caller entries;
- exact acceptance transaction above;
- owned memory publication after commit;
- `run_start`, message lifecycle, `entry_added`, and trailing `queue_update` after publication;
- accepted-undriven and accept→reopen `starting` inspection/restore;
- no hook, breakpoint, process reservation, process owner, provider, tool, timer, or runtime1 import.

### Required tests

- exact transaction and durable-owned equality;
- concurrent accepts serialize and only one commits;
- append-vs-accept has only the natural two orders: append first becomes an earlier tree entry; accept first routes the append into the run inbox;
- config-vs-accept snapshots one complete order;
- all expected rejections write nothing;
- commit failure leaves memory idle and faults;
- admitted commit wins close and publishes;
- close-first returns `Closed`;
- pendingNextRun ordering and events;
- reopen restores `starting` with caller prompt and starts no work.

Stop after this concern unless the user explicitly approves combining it with the real starting-phase drive slice.

## R2.5 — Minimal no-tool run parity

### Goal

Implement the first real drive owner together with all work it owns; never land an owner-only shell.

Implement direct flow:

```text
drive arbitration installs one Lane-owned promise under the lane line
→ same-id drives join; stale ids fence
→ cancellation/deadline precheck
→ before_drive prerequisite outside the line
→ starting: before_run outside the line
→ commit injected messages + starting → checkpoint
→ generation.ready commit
→ request-local context/system-prompt transform
→ before_request/input preparation
→ effect_pending intent commit
→ provider effect; synchronously enqueue each converted assistant frame without awaiting storage
→ await latest frame-write promise before after_response
→ assistant settlement commit atomically deleting the frame list
→ finish terminal commit
→ remove owner only after final publication
```

The owner is one ordinary Lane field, not a runtime/controller/context abstraction. Close/fault rejects it; effects and hooks remain outside `Lane.command()`. Reuse execution-only assistant mechanics where useful, never runtime1 orchestration. Before provider work, settle the request-reconstruction decision described above.

### Required tests

Run the complete R2 suite against runtime2, including exact writes, events, telemetry, breakpoints, close boundaries, convenience/primitive equivalence, one frame append per convertible event, no per-frame storage await, latest-promise settlement fencing, and atomic frame-list deletion.

### Size review

Target total runtime2 implementation ≤ 2,000 lines. If larger, stop before R3 and identify why rather than introducing context/framework abstractions.

## R2.6 — Generation recovery and retry parity

### Goal

Pass committed R3 behavior.

Implement:

- orphaned assistant `effect_pending` recovery when no live owner exists, reducing committed frames into the synthetic partial error before ordinary retry/failure classification;
- repeated `before_drive` prerequisites on every newly installed pass;
- synthetic cap settlement;
- retry wait/wake/deadline policy;
- deferred suspension/poll frame persistence, replacement cleanup, and snapshot foundation;
- missing-identity suspension;
- activation-only unknown-outcome policy.

Recovery reads only the already-restored in-memory state. A same-process safe yield/hosted wake must not pretend a crash occurred.

Run the complete R3 suite and scratch example against runtime2.

### Size review

Target total ≤ 2,200 lines.

## R2.7 — Tool parity

### Goal

Pass the complete target R4 contract, including `tool-durability.md`.

Implement:

- complete durable tool plans and stable invocation ID = result entry ID;
- bound typed tool-argument, invocation-memo, progress-checkpoint, and staged-result addresses;
- planned → effect_pending → outcome_ready → completed;
- invocation-scoped `getMemo`/`setMemo` and Flue-style memoization support;
- sequential and parallel execution with completion-order outcome staging;
- source-ordered result materialization;
- immediate/synthetic outcomes;
- safe replay and unsafe interruption using the latest checkpoint value;
- every selected checkpoint synchronously enqueued, latest promise retained, and latest awaited before `after_tool`;
- hooks/events/usage/telemetry/breakpoints;
- termination and cancellation handling at every tool state.

Parallel effects remain ordinary local promises. Intent, checkpoint, outcome-staging, and materialization commands queue through the lane owner. Current call state is read from memory, never via full restore. Do not reintroduce one-active/one-waiting checkpoint coalescing.

Run the complete R4 suite and scratch example against runtime2.

### Size review

Target total ≤ 3,000 lines; stretch ≤ 2,500. If runtime2 approaches runtime1 size, do not continue to parity cleanup without architectural review.

## Superseded parity/switch roadmap

The former R2.8 parity-first switch plan was superseded by the approved deletion strategy. Execute [WP00 — Runtime1 removal](work-packages/00-runtime1-removal.md), then [WP01 — Bound values and lists](work-packages/01-bound-values-lists.md). Those handoffs are the sole source for deletion lists, retained tests, validation, non-goals, and stop conditions. Do not recreate a dual-runtime parity gate or legacy smoke suite.

# Comparison discipline

The target contract and transaction tables in `harness.md`, plus the scoped redesign in this document until it is folded back, are the authority. Compare runtime2 behavior against those documents:

- transaction write arrays and durable value/entry state;
- events and ordering;
- telemetry spans/attributes;
- breakpoints/details;
- public results/errors and suspended descriptors;
- storage read counts and source line counts.

Do not require parity with runtime1 on redesigned acceptance, hooks, FSM, restore validation, bound value/list storage, assistant partial durability, or tool durability. Until deletion, compare it only for scenarios whose documented contract is explicitly unchanged. After deletion, use the harvested scenario inventory and ordinary git history for archaeology; do not recreate a dual-runtime harness.

# Coding rules

- No `any`.
- No dynamic/inline imports.
- Erasable TypeScript syntax only.
- Keep phase/ID checks beside the transition they protect.
- No generic reducer/action framework.
- No external effect inside the lane command line.
- No mutation of published memory before commit.
- No full restore in live procedures.
- Inline one-use helpers.
- Check external API types from source/node_modules.
- Do not modify runtime1 except as required by WP00 deletion; never change the target contract to preserve it.
- Do not touch unrelated coding-agent worktree files.
- Do not commit unless the user asks.

# Validation

Use the active work-package handoff; it owns the exact test list. Every code package also runs agent/root TypeScript, `git diff --check`, and `npm run check`. Never run unrestricted Vitest, `npm test`, or paid-provider tests.

# Next assignment only

Execute [WP00 — Runtime1 removal](work-packages/00-runtime1-removal.md) and stop at its boundary. Then execute [WP01 — Bound values and lists](work-packages/01-bound-values-lists.md) as a separate package. Do not resume the historical R2.4–R2.8 sequence or begin provider execution without a new concrete handoff linked from `harness.md` Part 8.

The completed Fable and DeepSeek reviews are summarized in this document; no subagent session or temporary review checkout is expected to survive compaction.
