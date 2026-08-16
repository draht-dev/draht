# Tool durability — implementation handoff

This document specifies the durable tool-call lifecycle and the minimal harness-specific progress-checkpoint extension to the current tool API. It does not otherwise finalize the harness-native public tool interface; that interface must provide the capabilities required here without exposing raw session storage.

The design has two independent additions:

1. a durable `outcome_ready` state between external-effect settlement and source-ordered conversation placement;
2. opt-in durable replacement checkpoints for complete bounded `onUpdate` snapshots.

## Problem

Parallel tool effects finish in completion order, while tool-result entries must enter the conversation in assistant source order.

Without an intermediate durable state:

```text
calls: A, B, C
B finishes
C finishes
A is still running
process crashes
```

B and C exist only in process memory because A prevented source-ordered placement. Recovery treats them as unresolved and may replay or interrupt effects that already completed.

The solution separates two orders:

1. **outcome durability:** actual completion order;
2. **entry materialization:** assistant source order.

A complete finalized result becomes durable immediately in `pending.entry`; the call becomes `outcome_ready`; placement happens later when every earlier source position is complete or ready.

## Goals

1. Never rerun a tool after its complete finalized outcome is durable.
2. Durably retain out-of-order parallel outcomes without violating transcript order.
3. Preserve the existing whole-tool `replay: "safe" | "never"` contract.
4. Support invocation-scoped durable memoization for Flue-style `step.do`.
5. Preserve tool-selected bounded progress checkpoints for reconnect and unsafe interruption recovery.
6. Fence late tool writes after outcome settlement, cancellation, or external finalization.
7. Keep final tree entries canonical, complete, bounded independently of progress snapshots, and immutable.

## Non-goals

- Exactly-once arbitrary external effects.
- A nested durable state machine for each `step.do` call.
- Inferring tool completion from progress output.
- Treating partial output as the canonical final result.
- Giving tools raw `Session`, `SessionMutator`, scalar-register, or list-register access.
- Finalizing the public harness-native tool type in this document.

## Durable identities

Each call already reserves its result entry ID before execution. Use that as the stable public invocation identity:

```text
invocationId = resultEntryId
```

It is session-unique, survives safe replay, and is distinct from the provider's `toolCallId`.

The surrounding operation state continues to provide:

- `operationId`;
- `turnId`/generation step ID;
- `sourceIndex`;
- assistant entry ID;
- captured configuration and execution mode.

## Storage

### Existing scalar namespaces

```text
op.tool_args/{operationId}:{turnId}:{sourceIndex}
    Effective validated arguments, persisted before effect admission.

pending.entry/{resultEntryId}
    Complete finalized ToolResultMessage while outcome_ready awaits placement.
```

### Invocation facts

Add an operation-owned scalar namespace:

```ts
interface RegisterValues {
  "op.tool_fact": JsonValue;
}
```

Physical key:

```text
{operationId}:{invocationId}:{factName}
```

`factName` must be non-empty and contain no `:`. Names may use dots or slashes for application-local grouping. `setFact(name, undefined)` deletes the physical register.

The operation prefix permits defensive terminal cleanup. The invocation prefix permits atomic cleanup when one outcome becomes ready.

### Partial tool output

The durable recovery value is the latest complete bounded progress snapshot selected by the tool. That is total current state, so use a scalar namespace:

```ts
interface RegisterValues {
  "pending.tool_output": AgentToolResult<unknown>;
}
```

Physical key:

```text
{operationId}:{invocationId}
```

This is auxiliary observation data. It never proves the effect succeeded or completed. The stored value has exactly the same content/details/usage shape as the live `partialResult`; recovery does not need a tool-specific progress codec.

The tool owns snapshot bounding, cadence, and duplicate suppression. The harness owns persistence, drop-coalescing, invocation fencing, and cleanup. The first API has no generic byte cap and does not truncate or reinterpret typed tool data; in-process tools are trusted to honor the bounded-snapshot contract. There is no tool-visible `flush()` method and no durable list of progress updates.

A crash may lose live updates newer than the latest committed checkpoint. JSONL physical growth is proportional to the size and frequency of distinct requested checkpoints until compaction; Memory and SQLite retain one current value. At 50 KiB every two seconds, JSONL's uncompacted worst case is approximately 15 MiB per ten minutes of continuously changing output.

## Tool update API

Keep the existing full-snapshot update callback and add harness-specific options:

```ts
export interface AgentHarnessToolUpdateOptions {
  /** Request replacement of this invocation's durable recovery checkpoint. */
  checkpoint?: true;
}

export type AgentHarnessToolUpdateCallback<TDetails> = (
  partialResult: AgentToolResult<TDetails>,
  options?: AgentHarnessToolUpdateOptions,
) => void;
```

`AgentHarnessTool` uses this callback instead of the legacy `AgentToolUpdateCallback`. The harness always supplies it, even without a live listener, because a tool may request persistence through it. The legacy `AgentTool` and old agent loop remain unchanged because they cannot honor durable checkpoints.

Every callback invocation remains an immediate live update. The callback is synchronous and returns `void`; `checkpoint: true` additionally requests persistence of that complete snapshot. It is not a durability acknowledgement. Internally, the harness retains the latest `events.emit(tool_update)` promise so existing listener delivery completes before `after_tool`; tools do not await or receive that promise.

Checkpoint requests are drop-coalesced. The synchronous request path either immediately enqueues the active lane-line mutation or replaces the in-memory waiting value:

- at most one checkpoint commit is active per invocation;
- at most one newer requested snapshot waits;
- a newer requested snapshot replaces the waiting one;
- an admitted commit verifies the same call remains `effect_pending`;
- tool-promise settlement closes checkpoint admission and drops the waiting, not-yet-enqueued snapshot; an active checkpoint is already ordered on the lane mutation line before outcome staging;
- a failed admitted commit faults the harness under the ordinary storage-fault rule.

Tools should compare against their last requested checkpoint when duplicate suppression matters. Storage does not read and deep-compare the current scalar as part of every checkpoint.

### Bash policy

The built-in bash tool keeps its current 100 ms live update cadence. It requests a checkpoint at most once every two seconds and only when the complete bounded snapshot differs from its last requested checkpoint:

```ts
const BASH_UPDATE_THROTTLE_MS = 100;
const BASH_CHECKPOINT_INTERVAL_MS = 2_000;
```

The current `ShellCaptureProgress` already supplies a bounded snapshot: the last 2,000 lines or 50 KiB, plus truncation metadata and the overflow-file path. The initial empty update is live-only. Output volume never accelerates checkpoint frequency. A short tool may settle without writing any checkpoint because its complete final result commits instead.

## Tool-call state

Extend the call union with `outcome_ready`:

```ts
type ToolCall =
  | {
      status: "planned";
      sourceIndex: number;
      resultEntryId: string;
    }
  | {
      status: "effect_pending";
      sourceIndex: number;
      resultEntryId: string;
      replay: "never" | "safe";
    }
  | {
      status: "outcome_ready";
      sourceIndex: number;
      resultEntryId: string;
      terminate: boolean;
    }
  | {
      status: "completed";
      sourceIndex: number;
      resultEntryId: string;
      terminate: boolean;
    };
```

`outcome_ready` means:

- execution, error normalization, and `after_tool` have finished, or the harness has constructed a final synthetic result;
- the complete final `ToolResultMessage` exists in `pending.entry/{resultEntryId}`;
- invocation facts and partial-output storage are gone;
- the tool must never execute again;
- the immutable result entry may not exist yet because an earlier call has not materialized.

The exact union may later carry small settlement metadata, but it must not duplicate the finalized result payload.

## State transitions

```text
planned
  ├─ real effect cleared       → effect_pending
  └─ immediate/synthetic       → outcome_ready

effect_pending
  ├─ live effect settles       → outcome_ready
  ├─ safe orphan replay settles→ outcome_ready
  └─ unsafe orphan synthesis   → outcome_ready

outcome_ready
  └─ source position eligible  → completed
```

An implementation may fuse `outcome_ready → completed` into the same transaction that finalizes an immediately placeable head call, but the semantic checks and tests must still cover durable `outcome_ready` for out-of-order calls. Prefer implementing the explicit two-transaction form first.

## Fresh execution

### Clearance and intent

Unchanged effect sandwich:

```text
planned
→ prepare arguments, run before_tool, validate replacements
→ TX[
     set op.tool_args,
     set call = effect_pending(replay)
   ]
→ admit tool execution
```

The invocation-scoped capability becomes active only for this durable `effect_pending` call.

### Partial output

Every `onUpdate(partialResult, options)` publishes the live update through the existing event/snapshot path. When `options.checkpoint === true`, the harness additionally requests a scalar replacement:

```text
TX[
  set pending.tool_output/{operationId}:{invocationId} = partialResult
]
```

The mutation verifies the same operation, turn, source position, and invocation remain `effect_pending`. It does not rewrite `op.state`. A late checkpoint after settlement returns without committing.

The tool must checkpoint bounded complete snapshots, not growing unbounded values. Bash uses the same bounded `ShellCaptureProgress` snapshot it already sends live. Clients may render and locally retain live updates newer than the durable checkpoint, but those updates are explicitly process-local.

### Finalization to `outcome_ready`

When the tool promise settles:

1. synchronously stop accepting updates, expire the invocation capability, and close checkpoint admission;
2. drop the waiting checkpoint; any active checkpoint or pre-return fact mutation is already ahead of staging on the lane mutation line;
3. await the latest tracked `tool_update` delivery, which implies delivery of every earlier update;
4. run `after_tool` when this is a real fresh or safely replayed result and cancellation did not prevent the hook;
5. construct the complete final `ToolResultMessage`;
6. emit and await `tool_end` for a real execution;
7. commit the result as `outcome_ready`.

`setFact()` returns a promise and tools must await it; `step.do` always does. An unawaited pre-return mutation is still enqueued before staging and is deleted by staging. Calls begun after capability expiry reject. No separate invocation-write drain exists.

Transaction:

```text
TX[
  set pending.entry/{resultEntryId}
      = { type: "message", payload: finalizedToolResultMessage },
  delete pending.tool_output/{operationId}:{invocationId},
  delete op.tool_fact/{operationId}:{invocationId}:*,
  set op.state call = outcome_ready(terminate)
]
```

The transaction is the linearization point after which the invocation can never replay.

The staged message contains the final:

- text/image content;
- provider tool-call ID and tool name;
- details;
- `isError`;
- usage snapshot, when reported;
- added tool names;
- timestamp.

`terminate` remains orchestration state because it controls the batch continuation and is copied to the immutable entry's `terminate` field at placement. Staged `addedToolNames` do not affect the active tool set until that result materializes in the transcript.

## Source-ordered materialization

After any call becomes `outcome_ready`, find the contiguous ready prefix beginning at the first non-completed source position.

Example:

```text
[completed, outcome_ready, outcome_ready, effect_pending]
             └──────── ready prefix ────────┘
```

Before the placement transaction, emit and await each finalized result's `message_start` and `message_end` in source order. Materialize the prefix in one transaction when practical, then emit `entry_added` and reported usage events in the same source order:

```text
TX[
  insert result entry i from pending.entry/i,
  delete pending.entry/i,
  insert tool usage row i if reported,

  insert result entry i+1 with parent = result i,
  delete pending.entry/i+1,
  insert tool usage row i+1 if reported,

  set lane.leaf = newest result,
  set calls i..i+1 = completed,
  set next checkpoint in the same state write when the whole batch completed
]
```

Each inserted entry uses its already-reserved `resultEntryId`. Writes construct the parent chain in source order inside the transaction.

Tool-reported usage remains durable in the staged message until placement. The initial implementation writes its ledger row atomically with entry materialization, matching the current entry/usage ordering and avoiding a ledger row that references an entry not yet present. No usage ID reservation is needed because a failed placement transaction writes neither row nor completed state.

When the final call materializes, the same transaction deletes the batch's `op.tool_args` keys and transitions to the correct checkpoint:

- every result terminates → `may_finish`, no final assistant required;
- otherwise → `need_assistant(false)`.

## Parallel execution

Outcome staging follows actual completion order. Entry materialization follows source order.

```text
A, B, C start
B finishes → B outcome_ready
C finishes → C outcome_ready
A finishes → A outcome_ready
             materialize A, B, C
```

Crash after B and C stage:

```text
A effect_pending
B outcome_ready
C outcome_ready
```

Recovery applies unknown-outcome policy only to A. B and C require no tool registration or hook execution to become entries.

The durable invariant changes from “completed calls form a source-ordered prefix” to:

- completed calls form a source-ordered prefix;
- after that prefix, parallel calls may be `planned`, `effect_pending`, or `outcome_ready` in any mixture;
- only source-ordered materialization extends the completed prefix.

Sequential execution normally has at most one non-planned call after the completed prefix, but restore should validate this from the captured execution mode as it does today.

## Unsafe recovery with partial output

For orphaned `effect_pending` with `replay: "never"`:

1. read `pending.tool_output/{operationId}:{invocationId}` when present;
2. preserve its bounded content and serializable details;
3. append a mandatory human-readable interruption marker;
4. construct a harness-owned `ToolResultMessage` with `isError: true`;
5. commit it as `outcome_ready` and clean invocation state.

The marker must state that output is partial and the external outcome is unknown. `isError: true` describes the result delivered to the model; it does not assert that the external effect failed.

Example final text suffix:

```text
[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]
```

Rules:

- do not run `after_tool` for this synthetic result;
- preserve checkpoint `usage` when present, but ignore checkpoint `addedToolNames` and `terminate` because progress never has final-result authority;
- set `terminate: false` and add no tools;
- no partial register is also valid and yields only the interruption result;
- never infer completion from an apparent success line in partial output;
- cleanup of partial output and invocation facts is atomic with staging the synthetic result.

## Safe recovery

For orphaned `effect_pending` where both the stored and current declarations are `replay: "safe"`:

1. retain invocation facts;
2. atomically delete the previous `pending.tool_output` key;
3. emit/reset process-local progress observation as needed;
4. rerun the tool with persisted arguments and the same `invocationId`;
5. completed `step.do` calls return their memoized values;
6. new partial output reconstructs a clean progress stream;
7. finalization follows the ordinary `outcome_ready` path.

Deleting old progress prevents duplicate chunks when replayed code emits progress again. A crash after the delete but before replay admission remains `effect_pending`; the next recovery repeats the same safe procedure.

If the current tool declaration is missing, suspend before replay. If it is present but no longer safe, use unsafe interruption recovery.

## Invocation facts

The harness-native tool call receives a purpose-built invocation capability conceptually equivalent to:

```ts
interface AgentHarnessToolInvocation {
  readonly invocationId: string;
  readonly operationId: string;
  readonly turnId: string;

  getFact(key: string): Promise<JsonValue | undefined>;
  setFact(key: string, value: JsonValue | undefined): Promise<void>;
}
```

Each operation:

1. validates the fact name and checks process-local capability expiry;
2. synchronously enqueues work on the lane mutation line before returning its promise;
3. verifies the operation, turn, source position, and invocation are still the same `effect_pending` call when that job executes;
4. reads or writes only the invocation's physical prefix;
5. rejects after capability expiry or durable ownership loss.

The durable check matters for authorized external finalization. In ordinary execution, a fact mutation initiated before the tool returns is FIFO-ordered before outcome staging; one initiated afterward fails the expired-capability check.

A late zombie callback can neither recreate facts after `outcome_ready` nor write into a later operation.

Facts are immediate durable memo state, not application-visible settlement state. They survive close/crash while the call remains `effect_pending` and are deleted when any real or synthetic outcome becomes ready.

Terminal cleanup defensively deletes:

```text
op.tool_fact/{operationId}:*
pending.tool_output/{operationId}:*
```

in addition to existing operation-owned registers.

## Flue-style `step.do`

Build `step.do` over invocation facts; it does not need its own harness state union:

```ts
interface ToolSteps {
  do<T extends JsonValue>(
    name: string,
    effect: () => T | Promise<T>,
  ): Promise<T>;
}
```

Algorithm:

```text
validate deterministic unique name
→ getFact("step/" + name)
→ present: return stored value
→ absent: run effect
→ setFact("step/" + name, value)
→ await durability
→ return value
```

Crash behavior:

```text
before/during effect                    → effect may run on replay
effect returned, memo not committed     → effect may run on replay
memo committed                          → replay returns memo
step A memoized, step B interrupted      → rerun tool; A skips, B runs
```

This is exactly-once recorded and at-least-once executed. It does not make arbitrary external effects exactly once. An application may derive a stable external idempotency key from `(invocationId, stepName)` when the external API supports one.

Errors are not memoized. A thrown effect either contributes to the current tool result or runs again after safe whole-tool recovery.

Do not add per-step `replay: "never"` in this slice. Supporting it correctly requires a nested `planned → effect_pending → completed` state and an explicit unknown-outcome policy. Whole-tool replay policy is sufficient for the Flue use case already discussed.

Within one live execution, calling the same step name twice is an invariant error. Names must be deterministic across safe replay.

## Application persistent state

Flue-style application state is distinct from invocation facts.

Invocation fact:

```text
step completed → memo becomes visible immediately
```

Application state:

```text
tool stages state change
→ crash before outcome_ready: state must not appear committed
→ outcome_ready: state and finalized result become visible together
```

Do not implement application state by calling public `setCustomFact()` directly during execution.

Two valid implementation stages:

1. Flue keeps its state externally and atomically stores application state plus a full result memo keyed by `invocationId`.
2. A later harness API accepts staged application fact writes and promotes them in the `outcome_ready` transaction.

The second option is required only if Flue's `usePersistentState` moves into harness-owned session facts. Its public typing and conflict semantics remain an open design item for the harness-native tool discussion.

## Cancellation

Cancellation reconciliation never replays a restored tool.

- `planned` calls receive a synthetic aborted result and become `outcome_ready`;
- a live started call may finalize its real local result under cancelled control, then become `outcome_ready` with `terminate: false`;
- restored `effect_pending` calls use an interrupted synthetic result, optionally including partial output, regardless of safe replay declaration;
- existing `outcome_ready` calls are preserved and materialized in source order;
- invocation facts and partial output are deleted with each staged cancellation outcome;
- no `before_tool` or `after_tool` starts during restored synthetic reconciliation.

The aborted terminal transaction runs only after every call outcome has materialized and accepted deferred writes have drained under the existing cancellation rules.

## Close and external finalization

Close is still a controlled crash:

- fact/checkpoint mutations already enqueued under the admission barrier may finish;
- live output newer than the latest committed tool-requested checkpoint may be lost;
- no synthetic outcome or cancellation marker is written;
- durable state remains at `effect_pending` or `outcome_ready`.

External finalization deletes operation-owned arguments, invocation facts, partial output, staged pending outcomes, and other pending entries in its terminal transaction. A live task that later tries to stage an outcome fails the ownership fence and stops through `OperationEnded`.

## Restore and validation

Scalar restore remains authoritative. Extend direct hydration and semantic checks:

### `planned`

- result ID is reserved but has no entry or `pending.entry`;
- no `op.tool_args` is required;
- no partial output or invocation facts are required.

### `effect_pending`

- matching `op.tool_args` exists;
- result entry and `pending.entry/{resultEntryId}` do not exist;
- invocation facts may exist but are not required for base validation;
- a partial-output scalar may exist but is auxiliary and must satisfy the trusted tool's bounded-snapshot contract.

### `outcome_ready`

- `pending.entry/{resultEntryId}` exists;
- it contains a `ToolResultMessage` matching the source call's provider call ID and tool name;
- immutable result entry does not yet exist;
- invocation facts and partial output should be absent after the atomic staging transaction;
- no tool identity is needed to materialize it.

### `completed`

- immutable result entry exists and matches the source call;
- no staged pending entry exists;
- no invocation facts or partial output exist.

Restore validates the completed-prefix and execution-mode shape described above. Partial output does not participate in semantic validation. Activation or snapshot hydration may read the exact scalar afterward.

## Snapshots and reconnect

A reconnecting client may see:

- live process-local progress newer than the latest durable checkpoint before disconnect;
- after process replacement, only the latest committed bounded checkpoint;
- `outcome_ready` calls as no longer running but not yet visible in the transcript until source-ordered materialization;
- completed calls in the transcript.

In `LaneSnapshot`, an effect-pending tool's `partialResult` prefers its latest process-local update and falls back to the durable checkpoint after reopen. An `outcome_ready` call is settled and does not appear in `runningTools`.

## Events and hooks

- `tool_start` remains a live effect event.
- live progress events and durable progress checkpoints do not prove completion.
- The harness awaits the latest `tool_update` delivery before `after_tool`, preserving the existing listener ordering without making `onUpdate` async.
- `tool_end` reports a finalized real result before its `outcome_ready` staging commit, in completion order. It is observation, not proof of durability.
- synthetic blocked and unsafe-recovery outcomes emit no tool-effect lifecycle and run no post-effect tool hook.
- message lifecycle and `entry_added` occur when the staged result materializes, not when it first becomes `outcome_ready`.
- passive listeners cannot mutate invocation state reentrantly.

Instrumented-storage tests assert this ordering. A crash after `tool_end` but before outcome staging may recover or safely replay the still-uncertain call; only staging prevents replay. Historical events are not replayed, though a safely replayed execution emits its own recovery-tagged lifecycle.

## Races

| Race | Required result |
|---|---|
| checkpoint vs tool settlement | an active checkpoint was enqueued first and staging later deletes it; the waiting checkpoint is dropped when the tool promise settles; a late update is ignored |
| fact write vs `outcome_ready` | an awaited or pre-return-enqueued write precedes staging and is then deleted; a post-return call rejects; external finalization first causes the durable ownership check to reject |
| B outcome vs earlier A settlement | B stages independently; placement waits for A |
| crash after outcome staging | tool never replays; pending result later materializes |
| crash during source-prefix placement | transaction exposes either none or all of that placement prefix |
| safe replay vs old partial output | old key is deleted before replay emits new progress |
| cancellation vs real settlement | lane-line order chooses real cancelled-control result or synthetic reconciliation; at most one outcome stages |
| terminal finalization vs late result | terminal ownership wins or outcome stages first; late task never recreates operation data |
| external finalization vs fact/checkpoint mutation | mutation first is removed by terminal cleanup; finalization first makes the mutation's durable ownership check reject |

## Invariants

1. `invocationId` equals the reserved result entry ID and is stable across safe replay.
2. A call in `outcome_ready` or `completed` never executes again.
3. Every `outcome_ready` call has exactly one complete matching `pending.entry` value.
4. Completed calls form a source-ordered prefix.
5. Only source-ordered materialization extends that prefix.
6. Parallel calls after the completed prefix may mix planned, effect-pending, and outcome-ready states.
7. Invocation facts exist only while their call is `effect_pending`.
8. Partial output is auxiliary and never establishes effect completion.
9. Unsafe synthetic results explicitly state that captured output is incomplete and the external outcome is unknown.
10. Staging an outcome atomically deletes its invocation facts and partial output.
11. Materialization atomically inserts the immutable entry and deletes its staged pending value.
12. A late invocation capability cannot write after outcome settlement or operation loss.
13. `step.do` values are memoized only after their fact write commits; effects remain at-least-once.
14. Operation terminal cleanup leaves no tool args, invocation facts, partial output, or staged outcomes.

## Required tests

### State and restore

- every planned/effect-pending/outcome-ready/completed state;
- missing or mismatched pending result for `outcome_ready`;
- pending result incorrectly coexisting with completed entry;
- invocation facts and partial output absent after staging;
- restore validates without reading partial output;
- activation then hydrates the exact bounded scalar when needed.

### Parallel ordering

- B and C stage while A remains pending;
- crash/reopen proves B and C never replay;
- A recovery followed by one source-ordered A/B/C placement transaction;
- mixed `[completed, outcome_ready, planned, effect_pending, outcome_ready]` state;
- immediate synthetic outcomes stage out of order;
- all-terminating batch transitions correctly after ordered placement.

### Replay and interruption

- safe replay uses persisted arguments and the same invocation ID;
- safe replay preserves step facts but clears old partial output;
- current declaration downgrade from safe to never interrupts;
- unsafe recovery with no checkpoint and with a complete bounded checkpoint;
- synthetic result is error/incomplete/unknown and never runs `after_tool`;
- cancellation never safely replays a restored call.

### Invocation facts and `step.do`

- set/get/delete fact with physical invocation scoping;
- completed step skips effect after reopen;
- crash before memo commit reruns effect;
- crash after memo commit returns memo;
- several completed steps followed by one interrupted step;
- duplicate live step names reject;
- fact write racing outcome staging;
- capability write after expiry, cancellation outcome staging, and external finalization rejects;
- terminal cleanup removes crash-leaked facts.

### Partial output

- ordinary updates stay live-only;
- `checkpoint: true` writes the complete bounded snapshot;
- tool-selected checkpoint cadence and duplicate suppression;
- bash emits live snapshots at 100 ms and requests distinct checkpoints at most every two seconds;
- drop-coalescing permits at most one active and one waiting checkpoint, and tool-promise settlement drops the waiting value;
- a checkpoint after outcome staging cannot recreate the key;
- Memory, JSONL, and SQLite restore the same checkpoint value;
- JSONL growth follows checkpoint cadence rather than raw bash output volume;
- terminal compaction reclaims superseded/deleted checkpoint snapshots according to the existing dead-byte policy.

### Atomicity and instrumentation

- exact intent, synchronous update acceptance, asynchronous update-delivery, `after_tool`, `tool_end`, outcome-ready, source-ordered message lifecycle, and materialization order;
- outcome staging is atomic with fact/output cleanup;
- materialization is atomic with pending deletion, usage, leaf, and state;
- crash at every boundary;
- no effect starts before intent;
- no effect or hook starts from `outcome_ready`;
- terminal transaction removes every operation-owned tool value.

## Implementation map

Expected runtime areas:

- operation-state types in `packages/agent/src/harness/session/types.ts`;
- restore key collection and semantic validation;
- tool-batch procedure and source-ordered materialization;
- terminal cleanup and cancellation reconciliation;
- harness-specific update options, snapshots, and events;
- invocation-scoped capability implementation on the lane mutation line;
- backend conformance through the already-implemented scalar/list register APIs;
- instrumented-storage transaction assertions.

Concrete namespace additions:

```text
scalar: op.tool_fact
scalar: pending.tool_output
existing scalar staging: pending.entry
```

Implement `outcome_ready` and invocation facts before progress checkpoints. The state solves incorrect parallel replay by itself; checkpoints improve reconnect observation and unsafe interruption diagnostics without becoming completion authority.
