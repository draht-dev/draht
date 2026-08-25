# WP05 — Direct durable drive

**Status: M5 complete; pre-M6 runtime simplification in progress.**

WP06's Session/Branch/Lane separation is already part of the foundation. Public drive remains disabled until structural execution, cancellation reconciliation, the total drive switch, and every public execution surface are complete.

Format 4 remains work in progress. The flat operation-state replacement requires no migration or compatibility decoder.

## 0. Mandatory reading

Read completely before implementation work:

1. `packages/agent/docs/harness.md`
2. `packages/agent/docs/runtime-simplification.md`
3. `packages/agent/src/harness/session/types.ts`
4. `packages/agent/src/harness/session/values.ts`
5. `packages/agent/src/harness/runtime/lane.ts`
6. `packages/agent/src/harness/runtime/types.ts`
7. every existing `packages/agent/src/harness/runtime/drive/*.ts`
8. `packages/agent/src/harness/runtime/progress.ts`
9. `packages/agent/src/harness/execution/{effect-gate,assistant,tools}.ts`
10. relevant focused runtime tests

Do not inspect Git history or removed runtime implementations. The current source and these documents are the only implementation inputs.

## 1. Runtime model

### Lane authority

`Lane.state` is authoritative while a Harness owns its Session. It contains all orchestration state required to dispatch:

- tip;
- lane configuration;
- pending-next-run ids;
- latest terminal result;
- operation metadata;
- flat operation state, including control and run inbox ids.

Every supported mutation commits on the one Session mutation line and publishes the matching `Lane.state` before releasing the line. Drive procedures never reread `laneState`, `operationMeta`, `operationState`, `branchTip`, `laneConfig`, or `laneLastResult` from storage.

`SessionReader` is used only to dereference content named by in-memory state and to enumerate operation-owned cleanup addresses:

- tree entries and branch context;
- pending entry payloads;
- assistant frame lists;
- tool arguments, checkpoints, and memos;
- structural preparations;
- staged tool outcomes;
- cleanup-prefix scans.

### Flat state

`OperationState` has one `at` discriminator with 22 direct leaves. The canonical declarations are in `session/types.ts`. There is no nested operation-kind/phase/generation-status/deferred-status/structural-status dispatch hierarchy.

`ToolBatch` and `ToolCall` remain a nested child state machine because parallel call children genuinely update sibling statuses concurrently.

### One lane-owned Drive

One lane may install one process-local Drive pass.

- The first matching caller installs it.
- Later matching callers observe the same completion.
- No caller owns the Drive after installation; the Lane does.
- Invocation cancellation rejects only that caller's observation.
- An installed Drive is never abandoned or replaced in-process.
- `requestAbort(operationId)` is the only durable operation cancellation.
- A stale operation id returns `OperationMismatch` and affects nothing.

`Drive.context` removes the installing invocation signal. Effects receive only the operation gate's signal composed with that cancellation-free Context.

### Close

Close is not abort. It seals mutation admission, rejects local observations with `HarnessClosed`, observes detached pass failures, drains mutations admitted before the seal, and closes the Session. It writes no cancellation marker or synthetic terminal state and never replaces a Drive.

### No external finalization

There is no live-process external-finalization path, `OperationEnded`, `finalizedOutcome`, ownership-loss result, or exact-Drive ABA fence. Administrative rewriting or expiration first acquires exclusive Session ownership with no live Harness.

## 2. Procedure shape

Live procedures are ordinary straight-line async functions:

```text
prepare
→ commit intent
→ admit and await effect
→ commit settlement
```

A procedure is the sole writer that changes its top-level `at` leaf. Inbox methods change only inbox fields; `requestAbort` changes only `control`. Therefore a live continuation does not repeatedly check operation existence, operation id, kind, or `at`.

The Lane supplies two concrete operations:

- `advanceOperation(state, planner, context)` — ordinary progress; if durable cancellation already won, return to the drive loop without invoking the planner;
- `mutateOperation(state, planner, context)` — effect settlement and parallel tool-child mutations; the planner always receives current control/inbox data.

Both pair a returned next `OperationState` with its durable `operationState` write and exact process-local publication. A terminal decision additionally appends the universal suffix:

1. procedure-specific publication and cleanup writes;
2. `laneLastResult`;
3. idle `laneState` preserving `pendingNextRun`;
4. idle process-local projection;
5. terminal result and event materialization.

The state argument is a type capability established by dispatcher control flow. It is not compared with current state at runtime. A mismatch would be a programming defect, not a supported race.

## 3. Remaining concurrency checks

Keep checks only where another supported writer can change the relevant fact:

1. `requestAbort` versus effect admission and settlement;
2. inbox arrival before checkpoint routing or terminal finish;
3. parallel tool-call statuses and source-ready placement;
4. queued frame/checkpoint writes versus settlement;
5. invocation memo/checkpoint calls versus effect completion;
6. retry timers versus cancellation/close;
7. deferred permit consumption;
8. accept/claim serialization;
9. external/provider/content validation.

Do not reintroduce operation identity, expected-`at`, exact-Drive, or ownership-loss checks into ordinary transitions.

`requestAbort` keeps the two-step gate order:

```text
beginAbort before the cancellation mutation
commit cancel_requested
signalAbort after the commit
```

This prevents a new effect from entering while the durable marker is being committed.

## 4. Completed milestones

### M0 — Withdrawn execution-step controls

Complete. Breakpoints, manual drive, and drive deadlines are absent.

### M1–M2 — Foundations and terminal mechanics

Complete. Includes the split effect gate, deterministic gated storage, authoritative process-local Lane projection, commit-result usage totals, progress channels, terminal cleanup, and bounded latest-result hydration.

### M3 — Assistant generation and recovery

Complete. Includes:

- `run.starting → run.checkpoint`;
- assistant ready/intent/effect/settlement;
- frame persistence and cleanup;
- configuration failure;
- unknown-outcome assistant recovery;
- response/usage/state atomicity.

### M4 — Retry and deferred

Complete. Includes durable retry waits, local wait policy, one deferred poll permit per pass, unknown-poll replacement under fresh ids, and event-stream-preserving `Models.streamDeferred`.

### M5 — Durable tools

Complete. Includes planned/effect-pending/outcome-ready/completed calls, safe replay, unsafe interruption, invocation memos, bounded checkpoints, completion-order staging, source-order placement, sequential and parallel modes, and tool-reported usage.

### Pre-M6 simplification

Required before further graph work:

- canonical flat `at` operation types;
- shared assistant/deferred response settlement;
- Lane transition operations;
- removal of installer abandonment, `LostOwnership`, exact-object fencing, `DriveAbandoned`, `installerSignal`, and `finalizedOutcome`;
- conversion of existing M3–M5 procedures;
- update of normative documentation and focused tests;
- measured material reduction in runtime LOC.

Stop and revisit the design if this conversion does not materially reduce the existing runtime.

## 5. M6 — Structural execution and navigation

### Goal

Implement every structural leaf:

- in-run threshold/overflow compaction;
- standalone compaction;
- summarized and unsummarized navigation;
- structural decision hooks;
- generated summary attempts, retries, and recovery;
- atomic result publication and terminal completion.

Create:

- `src/harness/runtime/drive/structural.ts`
- `test/harness/runtime/drive-structural.test.ts`

Modify checkpoint handling for threshold checks and the existing compaction modules only to expose one-provider-request seams.

### Structural request seam

One structural attempt may contain one or two provider requests. Each request must have its own durable intent and usage row. Do not wrap a retrying helper in one intent.

The runtime-owned request callback performs:

```text
reserve usage id
→ commit nested request intent { index, usageId }
→ compose gate signal and invocation telemetry Context
→ gate.admit(() => models.completeSimple(...))
→ commit usage and clear/advance nested request intent
```

Attempt-level retry is represented by the flat structural ready/effect-pending/retry-wait leaves. Existing non-harness callers retain their current in-helper retry behavior through a default request adapter.

Structural streams emit no transcript assistant lifecycle and persist no assistant frames.

### Required behavior

- Preparation is written before the decision hook and reused after reopen.
- Threshold checks happen at most once per trigger boundary.
- An unknown structural attempt consumes an attempt; it does not resume request two.
- Model disappearance fails in band.
- Standalone result publication and terminal cleanup are one transaction.
- In-run success/decline restores the captured checkpoint according to reason.
- Unsummarized navigation moves tip/label and terminates in one transaction.

### Focused validation

Cover every structural `at` leaf, split-turn request accounting, crashes after each nested request, threshold deduplication, hook decline/result, model absence, retry cap, navigation validation, and publication/terminal atomicity.

Public drive remains disabled.

## 6. M7 — Cancellation reconciliation and total switch

### Goal

Make the internal graph total without public wiring.

Create:

- `src/harness/runtime/drive/reconcile.ts`
- `src/harness/runtime/drive.ts`
- focused reconciliation and switch tests

### `requestOperationAbort`

Implement the package-private expected-id primitive:

1. synchronously `beginAbort` on a matching live Drive;
2. commit or observe `cancel_requested` on the Session line;
3. drain run steer/follow-up ids into control without deleting their payloads;
4. call `signalAbort` after commit;
5. return once cancellation is durable.

With no Drive it commits the same marker and starts no pass.

### Reconciliation

Cancellation is checked before `before_drive` and ordinary dispatch. Reconciliation is a single switch over flat `state.at` and never starts new ordinary work.

It must handle:

- assistant and deferred effects with live or reconstructed results;
- planned/effect-pending/outcome-ready tool calls;
- accepted deferred writes;
- structural process-local results;
- retry waits, checkpoints, suspended deferred work, and failure drain;
- best-effort deferred-provider cancellation;
- aborted terminal cleanup.

### Total switch

`runtime/drive.ts` owns one direct `state.at` switch. It imports only complete procedure modules. It has no graph table, action interpreter, ownership-loss arm, external-finalization arm, or storage-state reload.

A `continue` result must correspond to a replaced `Lane.state` projection; unchanged continuation is an invariant defect.

Public methods remain guarded through M7.

## 7. M8 — Public surfaces

Remove execution guards only after every state and reconciliation path is total.

Order:

1. admit compaction/navigation requests;
2. implement `drive` install/join/latest-result hydration;
3. expose `requestAbort`;
4. add convenience compositions;
5. add queues/configuration/usage/idle surfaces;
6. retain `watchSession` as the sole `SliceNotImplemented` method.

### Drive observation

A caller checks its signal before installation. After installation every caller uses observation-only cancellation:

```text
awaitWithContext(drive.completion, callerContext)
```

`awaitWithContext` rejects that waiter without cancelling the underlying completion. Installer and joiner have identical lifetime semantics.

### Close/fault

Public observations race Harness close/fault so they reject promptly. Every detached pass promise has an attached rejection observer. Late effect settlement reaches the sealed mutation line and rejects without a durable write.

### Focused validation

Cover:

- one install and same-id joins;
- stale-id isolation and latest-result hydration;
- caller cancellation before and after installation;
- one caller cancelling while other observers remain;
- close/fault during cooperative and non-cooperative effects;
- accept/drive and convenience equivalence;
- full crash matrix across every flat leaf;
- no unhandled detached rejection;
- no `SliceNotImplemented` except `watchSession`.

## 8. Module boundaries

```text
session/**             durable storage; imports no runtime module
execution/**           neutral provider/tool/gate mechanics
runtime/types.ts       LaneState, Drive, command decisions
runtime/progress.ts    frame/tool progress channels
runtime/drive/*.ts     direct procedures
runtime/drive.ts       total flat switch, created only in M7
runtime/lane.ts        Lane actor and public surfaces
runtime/harness.ts     Harness lifecycle and Lane composition
```

Procedure modules import concrete `Lane<TContext>` type-only. `TContext` remains `object | undefined` invariant. No `any`, `Lane<any>`, `as unknown as`, `@ts-expect-error`, inline imports, parameter properties, enums, or other non-erasable TypeScript syntax.

## 9. Exclusions

Do not introduce:

- generic scheduler, graph, action interpreter, or effect-plan DSL;
- a second mutation line or transaction framework;
- a dependency/capability facade around Lane;
- expected-`at` runtime checks for the sole top-level writer;
- process-local Drive replacement or caller-owned lifetime;
- external finalization;
- storage rereads of authoritative control state;
- string addresses or prefix-delete writes;
- read caches, read budgets, or generic `getValues` batching;
- process-local usage accumulators;
- compatibility aliases for the pre-flat WIP durable shape.

Procedure-specific writes, effect admission, settlement classification, and event construction remain visible at their call sites. The Lane helpers centralize only the transaction mechanics common to every transition.

## 10. Validation and reviews

After every code stage:

```bash
npm run check
```

Run each modified focused test file from the package root. Do not invoke the full Vitest suite directly. Run `./test.sh` only for the final package validation or when explicitly requested.

Review checkpoints remain mandatory at M7 and final completion. Delegated reviews use provider `anthropic` and model `claude-fable-5`.

Final greps:

```bash
rg 'lost_ownership|LostOwnership|DriveAbandoned|commandDriveOwned|installerSignal|finalizedOutcome|OperationEnded' \
  packages/agent/src/harness packages/agent/test/harness
rg 'SliceNotImplemented' packages/agent/src/harness/runtime
rg ': any\\b|<any>|as unknown as|@ts-expect-error' packages/agent/src/harness/runtime
```

Final exit conditions:

- every flat operation leaf is driveable and reconcilable;
- public primitive/convenience behavior is equivalent;
- every focused test and backend conformance path passes;
- public drive exposes no partial graph;
- `watchSession` is the only deferred public method;
- independent final review reports no blocker.
