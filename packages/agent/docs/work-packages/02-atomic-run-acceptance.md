# WP02 — Atomic acceptance and coherent lane observation

## Status

Phase A redesign in progress. Implementation planning showed that eager attachment hydration and predictive missing-identity status duplicated future drive logic and created unnecessary shadow state. `harness.md` is normative. Runtime implementation has not started.

The implementation baseline is the current `origin/dev` runtime2. Preserve unrelated work, especially concurrent `packages/agent/docs/plugins.md` changes and experimental directories.

## Goal

Deliver two effect-free boundaries:

```text
idle lane
→ atomic prompt/skill/template acceptance
→ durable open operation in payload-free starting

open or running lane
→ lane-line watch capture
→ complete snapshot plus gap-free subsequent events
```

After `AgentHarness.create(options, context)` succeeds:

- every configured lane has a complete small process-local projection;
- `open` inventories every durable current operation without predicting model/tool availability;
- attachment starts no hook, provider, tool, timer, breakpoint, drive owner, or application callback;
- `inspectExecution(context)` observes the small projection and local owner on the lane line;
- `watch(context)` registers buffering, clones live presentation, and performs bounded snapshot reads in one no-write lane job;
- every committing lane job publishes memory and synchronously enqueues its event batch before releasing the line;
- listener delivery remains asynchronous and outside the lane line.

WP02 does not implement drive, provider generation, hooks, tools, retries, deferred polling, cancellation procedures, manual action execution, or terminal settlement.

## Decisions

### 1. Attachment restores projection, not presentation

Passing the open Session to `AgentHarness.create()` transfers orchestration ownership until create rejects or the harness closes. Direct `Session.mutate`, `Session.createLane`, reserved-address writes, and second-harness construction are prohibited during that interval, so lane inventory cannot race an out-of-band lane creation.

Attachment reads only:

- `laneLeaf`, `laneConfig`, `laneState`, optional `laneLastResult`;
- `operationMeta` and `operationState` for a current operation.

It validates required existence, operation id/lane ownership, and intent/state kind compatibility. Projection corruption faults `create()`.

Attachment does not read transcript, queues, pending writes, drained payloads, deferred sources, frames, tool calls, arguments, checkpoints, preparations, memos, or staged outcomes. Those references are checked by `watch()` or drive when consumed. Missing or contradictory required payload data is terminal storage corruption and faults that consumer. Optional frame/checkpoint absence is legal.

### 2. Watch owns detailed snapshot reads

One no-write lane mutation job defines the watch boundary:

```text
enter after all earlier lane jobs
→ synchronously register buffering watcher
→ synchronously clone live presentation state
→ perform bounded durable reads while later lane jobs are excluded
→ assemble snapshot
→ release lane line
→ return handle
```

There is no special first-watch cache. The same path handles immediate post-attachment watch, reconnect, and watch during live execution.

The bounded read set is:

- one compaction-bounded branch scan from the current leaf;
- exact `pendingEntry(id)` reads for next-run, steer, follow-up, writes, and abort drains;
- exact deferred source entry when represented;
- tools-phase assistant entry and exact args for represented `effect_pending` calls, using `batch.turnId` as the args step id;
- bounded exact assistant-frame pages and exact optional tool checkpoints.

`ToolCall.sourceIndex` is the index in the assistant message's full content array, not a filtered tool-call ordinal. A represented call must index a tool-call block.

### 3. Event enqueue, not delivery, belongs on the lane line

A successful committing lane job performs:

```text
commit
→ publish small owned projection
→ synchronously bind recipients and enqueue complete `{ event, context }` batch
→ release lane line
→ deliver listeners later outside the line
```

Listeners must never execute on the lane line.

Recipient binding happens at enqueue. A listener or watcher registered after enqueue cannot receive that historical event even if delivery has not started.

The only watcher/publication orders are:

```text
watcher first
→ snapshot-before + complete buffered event batch

publication/enqueue first
→ snapshot-after + no old event
```

A live provider/tool presentation update follows the same synchronous publish-plus-enqueue discipline. Frame/checkpoint commits are lane jobs and queue behind watch capture.

### 4. Inspection is a no-write lane-line observation

`inspectExecution(context)` observes:

- lane and leaf;
- configured model identity as unresolved `{ provider, modelId }` strings;
- current operation id/kind/start time;
- process status `running`, `open`, or durable `aborting`;
- captured model identity when the current durable phase contains one;
- optional latest result.

It does not resolve model/tool registries and does not read transcript or presentation payloads.

### 5. Missing implementations are in-band outcomes

There is no `blocked`, missing-identity suspension, predictive classifier, or acceptance registry preflight.

At the actual execution boundary:

- unavailable captured model or configured active-tool definition before provider intent becomes a non-retryable configuration failure;
- pre-intent configuration failure reserves no response/usage ids and fabricates no assistant response or usage row;
- restored `effect_pending` settles uncertainty under its existing reserved ids before any later configuration failure;
- unavailable deferred model durably abandons redemption through configuration failure; R7 implements and tests restored `effect_pending` abandonment, including deletion of its exact old assistant-frame list while dropping the reserved response/usage strings without fabricating settlement;
- missing requested tool stages a direct `isError` `ToolResultMessage` and continues;
- missing/no-longer-safe replay implementation synthesizes interruption instead of waiting.

Synthetic harness tool results omit `details`. A tool owns the type of its details contract; the harness must not invent `{}` or a diagnostic object. `isError` and human-readable content carry the tool-level diagnosis. Run-level configuration failure remains machine-readable through `OperationError` and `laneLastResult`.

Stable configuration error codes:

- `model_unavailable`, details `{ provider, modelId }`;
- `configured_tools_unavailable`, details `{ tools: string[] }`.

`failure_drain` gains `{ kind: "configuration" }` provenance. Actual transitions land with their owning execution packages; WP02 lands the normative/source vocabulary only.

### 6. Acceptance is independent of process registries

Acceptance validates durable caller input and lane state, not current model/tool registrations. This avoids a time-of-check/time-of-use check and permits acceptance in one process followed by execution in another.

A misconfigured convenience prompt eventually returns a durable failed run from drive. Explicit hosted acceptance remains durable even before an execution worker loads implementations.

### 7. Invocation Context remains explicit

Every current public harness/lane operation receives trailing `context: Context`. Acceptance, attachment, watch capture, Session reads/commit, faults, and event enqueue preserve it. Shared harness/lane/Session receivers retain no caller Context. Context and its signal/telemetry values are never durable business data.

Buffered events retain the exact emitting Context. Invocation cancellation remains distinct from durable `requestAbort()`.

## End-state public contract

```ts
export interface ModelIdentity {
  provider: string;
  modelId: string;
}

export type OperationStatus = "running" | "open" | "aborting";

export interface OpenOperation {
  lane: string;
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
  aborting?: true;
}

export interface CurrentOperationInfo {
  id: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
  status: OperationStatus;
  capturedModel?: ModelIdentity;
}

export interface LaneExecutionInfo {
  lane: string;
  leafId: string | null;
  configuredModel: ModelIdentity;
  current: CurrentOperationInfo | null;
  lastResult?: LaneLastResult;
}

export interface LaneInfo {
  name: string;
  leafId: string | null;
  operation: CurrentOperationInfo | null;
}

export interface AgentHarnessConstructor {
  create<TContext extends object | undefined = object | undefined>(
    options: AgentHarnessOptions<TContext>,
    context: Context,
  ): Promise<{ harness: AgentHarness<TContext>; open: OpenOperation[] }>;
}
```

Rules:

- `open` has exactly one item per durable current operation and omits idle lanes;
- `aborting:true` comes only from durable `cancel_requested`;
- `open` is inventory, not scheduling or identity advice;
- normal applications establish watch and call `resume(context)`;
- hosted schedulers retain expected-id `drive` fencing;
- configured/captured identity fields are durable strings and may not resolve.

### Outcomes

Delete `MissingIdentitySuspension`, `MissingIdentities`, missing-identity drive waiting, and missing-identity suspension events.

Keep deferred suspension as provider semantics:

```ts
{ kind: "suspended"; reason: "deferred"; ... }
```

Keep `action_required` as the successful manual-progress outcome. WP02 changes its types and leaves behavior to R2.

Convenience operation outcomes remain operation-tagged branches of `ResumeOutcome`. `executeAction(context)` returns `ResumeResult`; `runToCompletion(context)` excludes `action_required`.

### Snapshot

```ts
export interface LaneSnapshot {
  lane: string;
  transcript: Entry[];
  leafId: string | null;
  lastResult?: LaneLastResult;
  operation: null | {
    id: string;
    kind: "run" | "compaction" | "navigation";
    startedAt: number;
    status: OperationStatus;
    action?: ActionInfo;
    retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
    deferred?: { handle: DeferredHandle; poll: number };
    drained?: { steer: QueuedItem[]; followUp: QueuedItem[] };
    streamingMessage?: AssistantMessage;
    runningTools: {
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult?: AgentToolResult<unknown>;
    }[];
  };
  queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
  pendingWrites: {
    entryId: string;
    type: EntryType;
    customType?: string;
    message?: AgentMessage;
    data?: JsonValue;
  }[];
  faulted: boolean;
}
```

Configuration is not duplicated in snapshots. `inspectExecution()` exposes configured/captured model identities; getters expose current configuration.

## Atomic run acceptance

WP02 implements `accept()` for prompt, skill, and prompt-template requests. Compaction/navigation acceptance remains with their execution packages.

State-independent normalization occurs before `Lane.command(plan, context)`:

- prompt strings/images;
- supplied message or message array;
- explicit skill formatting;
- prompt-template formatting;
- pending assistant rejection;
- unknown skill/template errors;
- supplied or minted operation and prompt-entry ids.

Public prompt convenience overloads remain exactly `[text, images | undefined, context]` and `[messageOrMessages, context]`, but convenience implementations remain `SliceNotImplemented` until R2.

Inside one lane command:

1. reject busy;
2. capture current `pendingNextRun` ids;
3. read and validate captured pending messages;
4. reject zero placed messages;
5. parent captured next-run entries before request prompt entries;
6. commit exactly once;
7. publish the small owned projection;
8. synchronously enqueue the acceptance event batch with the accepting Context;
9. release the lane line;
10. await event delivery before `accept` resolves.

Exact writes:

```text
insert captured nextRun message entries
insert request prompt entries
delete captured pendingEntry values
set laneLeaf
set operationMeta
set operationState(run starting)
set laneState(current operation, pendingNextRun=[])
```

Exact event order:

```text
run_start
for each placed message:
  message_start
  message_end
  entry_added
queue_update if nextRun was captured
```

Acceptance starts no drive or effect and writes no Context.

## Phase A — normative rewrite

Update `harness.md` before runtime source:

- replace eager attachment hydration with minimal projection restore;
- replace predictive status/classifier with open inventory;
- specify configured/captured identity inspection without resolution;
- move detailed reads to ad-hoc lane-line watch capture;
- require recipient binding and event-batch enqueue before line release;
- remove identity preflight/suspension/error/event types;
- specify in-band model/tool unavailability and configuration provenance;
- require direct detail-free synthetic tool-result messages;
- update invariants, races, roadmap, glossary, and Appendix C.

Review stop:

1. `git diff --check`;
2. fresh Terra contradiction/source-feasibility audit;
3. full-context Fable review against complete docs and source;
4. resolve all findings and repeat until no findings;
5. obtain user approval before runtime source.

## Phase B — implementation

### Public and durable types

Modify `agent-harness.ts`:

- remove `SuspendedOperation`, `MissingIdentityInfo`, `MissingIdentities`, and missing-identity outcome/event branches;
- add `ModelIdentity`, `OperationStatus`, `OpenOperation`, and corrected inspection/snapshot types;
- change create result from `suspended` to `open`;
- land operation-tagged action-required outcome families;
- correct `executeAction`/`runToCompletion` signatures;
- retain trailing Context everywhere.

Modify session types:

- add `failure_drain` configuration provenance;
- add the already-normative `ToolCall.outcome_ready` vocabulary without producers;
- document `sourceIndex` as full assistant-content index;
- add callback-scoped `scanBranch` to `SessionReader`; inheritance by `SessionMutator` and `Session` is intentional;
- implement it in `StorageBackedSession` and its mutator, `MemorySessionFacade`, `RemoteSession`, and `RemoteSessionMutator`, including the remote mutation RPC dispatcher.

### Event publication

Modify `HarnessEventBus`:

- snapshot ordinary and watcher recipients synchronously in `emit()`;
- deliver only to that bound list;
- retain `{ event, context }` in watcher buffers;
- a watcher registered after enqueue receives nothing from that event.

Extend `LaneCommand` commit decisions with a synchronous post-commit event batch. After commit succeeds, `Lane.command` publishes `next`, enqueues the complete batch, and only then releases the mutation callback. It awaits delivery outside `Session.mutate` before resolving the command. Route every existing event-producing commit through this path, including direct idle/pending appends, lane configuration setters, and session-name/entry-label setters.

For harness `createLane`, factor the existing Session lane-validation/write logic into one package-internal mutator procedure shared with event-free `Session.createLane`. The harness variant enters the new lane's mutation itself, commits through that procedure, publishes `lanesByName`, and enqueues `lane_created` before returning from the mutation callback; it awaits delivery outside the line.

Do not execute listeners on the line.

### Attachment

Keep `restore.ts` projection-only. Validate lane/operation ownership and kind compatibility. Remove `describeSuspension` and all payload hydration from `createAgentHarness`. Construct lanes and return `open` inventory without resolving registries.

### Inspection

Implement `inspectExecution(context)` as a no-write `Lane.command` observation. Derive captured model identity from the current durable phase. Read no storage payloads and resolve no registry identities.

### Watch

Implement `watch(context)` as one no-write lane job:

- register watcher and clone live presentation synchronously;
- perform the bounded read matrix above through callback-scoped readers;
- assemble isolated snapshot payloads;
- fault and unsubscribe on required corruption;
- retain legal optional absence;
- release the line before returning.

A focused internal snapshot helper is allowed. Do not create a persistent hydrated presentation cache or generic reducer.

### Out of scope

`drive`, `resume`, prompt convenience, compaction/navigation acceptance, abort/queues, `executeAction`, and `runToCompletion` remain `SliceNotImplemented` where not already implemented.

Provider/tool/configuration-failure transitions are specified now but implemented by R2/R3/R4/R7/R8. WP02 adds no effect, active operation, timer, hook, provider request, tool execution, retry, deferred fetch, cancellation reconciliation, or terminal transaction.

## Required tests

### Public types

- `SuspendedOperation`, `MissingIdentities`, and missing-identity status/outcomes/events are absent;
- open/current/status unions narrow exhaustively;
- configured and captured model identities are unresolved strings;
- action-required outcome families and method signatures match;
- prompt overload tuples remain exact;
- `AgentHarnessOptions` has no receiver telemetry default.

### Acceptance

- text-only, images-only, text-plus-images, supplied arrays;
- pending assistant rejection;
- skills/templates and unknown resources;
- empty input writes nothing unless captured nextRun supplies input;
- no identity registry preflight;
- supplied/minted operation ids;
- exact writes, parent chain, metadata, starting state, settings, commit materialization;
- pending-next-run capture/deletion;
- busy run/structural operation;
- one concurrent accept winner;
- commit failure and close races;
- exact event order and object-identical accepting Context;
- no hook, provider, tool, timer, drive-owner, or option callback invocation; passive event-listener delivery remains required.

### Attachment and inspection

- idle omitted and every open operation inventoried;
- durable cancellation sets only `aborting:true`;
- no transcript/pending/frame/tool reads at create;
- configured and captured model identities may differ and remain visible when unresolved;
- inspection runs on lane line and performs no payload reads;
- projection corruption faults create;
- no option callback/effect starts.

### Event publication and watch

- recipient set binds at enqueue: watcher registered after emit but before delivery receives nothing;
- state/event batch publication happens before lane-line release;
- direct append, lane configuration, session-name/entry-label, acceptance, and lane-creation commits all use that publication path;
- `value_update` and `lane_created` bind recipients on the committing line, so listeners registered after enqueue receive neither historical event;
- watcher-first gives snapshot-before plus complete events;
- publication-first gives snapshot-after without old events;
- live update during awaited capture appears only as a buffered event after the cloned live snapshot;
- frame/checkpoint mutations queue behind capture;
- first watch and reconnect use the same path;
- exact transcript, queues, writes, drain, deferred, frame, tool args/checkpoint fields;
- required payload corruption faults watch and removes watcher;
- absent frames/checkpoints omit optional partials;
- pre-registration lifecycle is not replayed;
- buffered events retain object-identical emitting Context;
- payload mutation cannot affect later state/listeners;
- close/fault lifecycle matches the event bus.

### In-band identity vocabulary

Type/direct-state tests prove:

- acceptance has no `MissingIdentities` path;
- configuration failure provenance and stable error codes are representable;
- deferred configuration abandonment remains assigned to R7 rather than adding an execution transition here;
- missing-tool synthetic `ToolResultMessage` may omit `details`;
- sourceIndex uses full assistant-content indexing;
- outcome-ready calls are not rendered as running.

No execution transition is added in WP02.

## Files

### Add

- `packages/agent/test/harness/runtime2/accept.test.ts`
- focused watch tests if existing files become oversized.

### Modify

- `packages/agent/docs/harness.md`
- `packages/agent/docs/work-packages/02-atomic-run-acceptance.md`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/events.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/remote.ts`
- `packages/server/src/remote-session-manager.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/runtime2/types.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/storage-backed-session.test.ts`
- `packages/agent/test/harness/memory-session-repo.test.ts`
- `packages/server/test/conformance.test.ts`
- event/session test files required by recipient binding and callback-scoped branch reads.

No backend schema, telemetry schema, coding-agent, or changelog change is expected. Stop for boundary review if one becomes necessary. On `dev`, defer changelog entries.

## Validation

After Phase A:

```bash
git diff --check -- \
  packages/agent/docs/harness.md \
  packages/agent/docs/work-packages/02-atomic-run-acceptance.md
```

After Phase B:

```bash
cd packages/agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  test/harness/runtime2/accept.test.ts \
  test/harness/runtime2/harness.test.ts \
  test/harness/runtime2/lane.test.ts \
  test/harness/runtime2/restore.test.ts \
  test/harness/types.test.ts

cd "$(git rev-parse --show-toplevel)"
git diff --check
npm run check
./test.sh
```

Report runtime2 source line counts. The synchronized pre-WP02 runtime2 baseline is 967 lines; treat growth above 1,900 source lines as a design review trigger, not a target.

## Stop condition

Stop when:

- acceptance commits exactly once into payload-free `starting` without registry preflight;
- attachment returns minimal complete projections and open inventory;
- inspection is a coherent lane-line no-write observation;
- watch captures detailed state ad hoc on the lane line;
- state publication and event enqueue occur before line release while delivery remains outside;
- snapshots and buffered events have no gap or duplicate;
- required payload corruption faults its consumer;
- no execution effect or owner is introduced;
- focused tests, `npm run check`, and full tests pass;
- final Fable review has no findings.

Do not begin the first real drive package.
