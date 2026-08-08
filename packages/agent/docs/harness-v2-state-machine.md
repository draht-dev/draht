# AgentHarness v2 explicit-state redesign

> **Status:** Working handoff document. This is not yet the canonical implementation specification. `harness-v2.md` remains the complete requirements inventory until this design is validated and adopted.
>
> **Purpose:** Preserve the redesign and decisions from the current design session in a form a new session can read quickly. The design deliberately replaces implicit recovery reduction with explicit, total durable operation state.

## 1. Concise model

An `AgentHarness` owns one durable session. The session contains:

1. **Conversation tree** — append-only message, compaction, branch-summary, and custom entries.
2. **Lanes** — permanent names pointing at tree leaves. Each lane has at most one open operation.
3. **Lane configuration** — one total replacement containing model reference, thinking level, and active tool names.
4. **Operational state** — an immutable operation header plus append-only total snapshots of the current operation.
5. **Usage ledger** — immutable usage records, independent of whether later orchestration succeeds.
6. **Global facts** — latest-wins name, labels, and custom facts.

Lanes run concurrently. One writer owns the session. Each lane serializes state-dependent decisions on a mutation line. Storage serializes all appends and assigns one session-wide `seq`.

### Operations

A lane accepts one of three operation kinds:

- **run** — prompt, assistant generations, tools, steering/follow-up, deferred writes, and automatic compaction;
- **compaction** — standalone manual compaction;
- **navigation** — move to another tree entry, optionally with a summary.

An accepted operation has one durable header and a sequence of total state snapshots. The latest snapshot directly states what the operation is doing and what may happen next.

### Effects

An effect is work outside pure state calculation:

- durable storage mutation;
- provider generation or deferred fetch;
- tool invocation;
- hook invocation;
- timer or retry sleep.

Before a repeat-sensitive external effect starts, durable state records that it is pending and provisions every settlement ID. After it settles, one atomic transaction writes its durable output, usage, and next total operation state.

### External-effect non-goal

External effects cannot generally be both durable and exactly once across process failure. Provider requests, tools, hooks, and provider billing can happen without their settlement becoming durable. Implementations must use idempotency, declared safe replay, reconciliation, or accept uncertainty. The harness makes this uncertainty explicit but cannot eliminate it.

### Context projection

Conversation persistence and provider context remain separate. Durable `error`, `aborted`, and `deferred` assistant responses do not project. Genuine output-limit `length` projects. Overflow compaction omits its exact superseded response from summary input and retained tail. Compaction entries remain self-contained context boundaries.

## 2. Replace implicit reduction with total operation snapshots

The current design reconstructs orchestration from combinations of records, entry presence, lane pointers, and later transitions. The redesign persists the continuation directly.

### Operation header

The header contains immutable acceptance data and is written once:

```ts
interface OperationHeader {
  operationId: string;
  lane: string;
  sourceLeafId: string | null;
  startedAt: number;
  intent:
    | {
        kind: "run";
        originalPrompt: AgentMessage[];
        systemPromptOverride?: string;
        resumeData?: Record<string, JsonValue>;
      }
    | {
        kind: "compaction";
        customInstructions?: string;
      }
    | {
        kind: "navigation";
        targetId: string | null;
        summarize: boolean;
        label?: string;
        customInstructions?: string;
      };
}
```

### Total operation snapshot

Every state transition appends a complete snapshot of all current mutable orchestration state for that operation:

```ts
interface OperationSnapshotRecord {
  type: "operation_snapshot";
  id: string;
  lane: string;
  operationId: string;
  revision: number;
  state: OperationState;
}
```

`revision` starts at 1 and increases by exactly one. Snapshots are append-only; the latest revision is authoritative.

**Total means total.** A snapshot does not contain a patch and does not require older snapshots to interpret it. It contains the complete current workflow state, retry state, tool plan and per-call states, pending operation-owned queues and writes, deferred source, and cancellation control. It may reference immutable conversation entries, usage records, and the immutable operation header by ID, but no older operational snapshot supplies missing state.

The first implementation accepts the storage cost of total snapshots. Do not introduce delta chains, child-state logs, or patch replay to optimize them. If measurement later shows a problem, optimize physical encoding or compression while preserving the logical total-snapshot contract.

### Loading current state

The public storage concept is:

```ts
interface CurrentOperation {
  header: OperationHeader;
  snapshot: OperationSnapshotRecord;
}

getCurrentOperation(lane: string): Promise<CurrentOperation | undefined>;
```

Backends answer through their latest-operation index. They read the immutable header and exactly one latest total snapshot. They do not scan or fold operation history, inspect entry absence to infer a phase, or collect partial task state from several operational logs.

Memory keeps the latest snapshot in a map. JSONL updates its latest-snapshot projection while replaying the file. SQLite keeps a current-operation projection and reads the selected snapshot/header by indexed ID.

### Records retained and replaced

Retain:

- total `lane_config` replacements;
- immutable usage and adjustment records;
- operation header;
- total operation snapshots;
- facts, lane history, and conversation entries.

The total snapshot replaces the recovery authority currently spread across:

```text
abort_requested
step_started
step_attempt
step_failed
branch_summary_prepared
tool_batch_started
tool_started
queue_enqueued
queue_cancelled
write_deferred
operation_finished
```

Some implementation may retain compact audit records, but recovery and transition validity must never depend on them.

## 3. Operation state

```ts
type OperationState =
  | RunOperationState
  | ManualCompactionState
  | NavigationOperationState
  | FinishedOperationState;
```

### Orthogonal cancellation control

Abort is not a workflow phase. It is control over the current workflow:

```ts
type OperationControl =
  | { status: "running" }
  | {
      status: "cancel_requested";
      requestedAt: number;
      drainedSteer: ProvisionedEntry<MessageEntry>[];
      drainedFollowUp: ProvisionedEntry<MessageEntry>[];
    };
```

Every active operation state contains `control`. Normal transition planning checks it. If cancellation won first, no new provider, tool, hook decision, or retry effect starts. Effect settlement, usage, accepted deferred writes, configuration changes, and cancellation completion remain allowed.

### Run state

```ts
interface ActiveRunState {
  kind: "run";
  control: OperationControl;
  phase: RunPhase;
  pendingSteer: ProvisionedEntry<MessageEntry>[];
  pendingFollowUp: ProvisionedEntry<MessageEntry>[];
  pendingWrites: ProvisionedEntry<MessageEntry | CustomEntry>[];
}

type RunPhase =
  | {
      kind: "checkpoint";
      continuation: CheckpointContinuation;
    }
  | {
      kind: "assistant";
      generation: GenerationState;
    }
  | {
      kind: "tools";
      batch: ToolBatchState;
    }
  | {
      kind: "compaction";
      compaction: SummaryGenerationState;
      resumeAfter: CheckpointContinuation;
    }
  | {
      kind: "deferred";
      deferred: DeferredState;
    }
  | {
      kind: "failure_drain";
      error: OperationError;
      terminalResponseEntryId: string;
    };

type CheckpointContinuation =
  | {
      kind: "need_assistant";
      triggerMessageId: string;
    }
  | {
      kind: "may_finish";
    };
```

`continuation` replaces inference such as `needsAssistant()`. A compaction stores the continuation it must resume. Overflow compaction resumes `need_assistant` with the same trigger. Applying a new user-context message changes the continuation to `need_assistant` with that message ID in the same atomic transaction.

### Generation state

```ts
interface GenerationContext {
  stepId: string;
  triggerMessageId: string;
  configuration: LaneConfiguration;
  retryPolicy: RetryPolicy;
}

type GenerationState =
  | {
      status: "ready";
      context: GenerationContext;
      nextAttempt: number;
    }
  | {
      status: "effect_pending";
      context: GenerationContext;
      attempt: number;
      responseEntryId: string;
      usageRecordId: string;
      intendedOutputLimit: number;
      contextWindow: number;
    }
  | {
      status: "retry_wait";
      context: GenerationContext;
      nextAttempt: number;
      notBefore: number;
      errorMessage: string;
    };
```

`RetryPolicy` applies to generation requests, including generated summaries. It does not impose a retry or polling cap on deferred fetch.

### Tool batch state

```ts
interface ToolBatchState {
  assistantEntryId: string;
  triggerMessageId: string;
  genuineLength: boolean;
  calls: ToolCallState[];
  nextToFinalize: number;
}

type ToolCallState =
  | {
      status: "planned";
      sourceIndex: number;
      toolCall: AgentToolCall;
      resultEntryId: string;
    }
  | {
      status: "effect_pending";
      sourceIndex: number;
      toolCall: AgentToolCall;
      resultEntryId: string;
      effectiveArgs: JsonValue;
      replay: "never" | "safe";
    }
  | {
      status: "completed";
      sourceIndex: number;
      toolCall: AgentToolCall;
      resultEntryId: string;
      terminate: boolean;
    };
```

The total operation snapshot contains the complete batch and every call state. This can duplicate data across snapshots; correctness and direct recovery take priority. Parallel tool execution remains possible: several calls may be `effect_pending`, while result commits remain source ordered.

### Deferred state

```ts
type DeferredState =
  | {
      status: "suspended";
      stepId: string;
      sourceEntryId: string;
      configuration: LaneConfiguration;
    }
  | {
      status: "effect_pending";
      stepId: string;
      sourceEntryId: string;
      responseEntryId: string;
      usageRecordId: string;
      configuration: LaneConfiguration;
    };
```

Each `resume()` performs at most one `fetchDeferred(..., { wait: 0 })`. The application decides whether and when to call `resume()` again. Deferred polling has no harness retry count, retry cap, or retry sleep. A pending response becomes the next source. Provider terminal errors fail the run. Provider behavior such as expiration or cancellation support is outside harness control.

### Terminal state

```ts
interface FinishedOperationState {
  kind: "finished";
  control: OperationControl;
  outcome: "completed" | "declined" | "failed" | "aborted";
  leafId: string | null;
  error?: OperationError;
  finalAssistantEntryId?: string;
}
```

Only transition functions may construct terminal state. This makes terminal validity local and exhaustive instead of a separate historical-log audit.

## 4. Atomic transition rule

Every durable boundary follows one rule:

> Compute one next total operation state, then atomically append all conversation, usage, fact, lane, and snapshot mutations that make that state true.

A transaction either commits all logical mutations or none.

### Assistant attempt

Plan before the effect:

```text
TX operation snapshot:
     phase assistant
     generation effect_pending
     attempt 1
     response R1
     usage U1
```

After the provider settles, classify in memory and commit settlement plus meaning:

```text
TX assistant entry R1
   usage U1
   operation snapshot:
     phase tools
     complete result-ID plan
```

or:

```text
TX assistant entry R1
   usage U1
   operation snapshot:
     phase assistant
     retry_wait for attempt 2
```

or:

```text
TX assistant entry R1
   usage U1
   operation snapshot:
     phase compaction
     exact overflow response link
     resumeAfter need_assistant
```

There is no durable response-without-usage or accounted-response-without-classification state.

### Tool call

After clearance and immediately before execution:

```text
TX operation snapshot:
     call i = effect_pending
     effective args and replay declaration stored
```

After execution/finalization:

```text
TX tool usage, when present
   planned tool-result entry
   operation snapshot:
     call i = completed
     next continuation recorded when batch completes
```

If a crash leaves `effect_pending`, replay only when the declaration and implementation are safe; otherwise append the planned interrupted result.

### Queue or deferred-write application

Acceptance updates the total snapshot with the complete provisioned payload. Application is atomic:

```text
TX message/custom entry
   operation snapshot with item removed
   continuation updated when the entry requires an assistant
```

A crash cannot consume an item without updating operation state, or update operation state without appending the entry.

### Navigation

Reject before acceptance when:

- target equals current leaf;
- target is root and a label was requested;
- summary was requested while the source leaf is root;
- non-null target does not exist.

For summarized navigation, all provider/hook work happens before the structural transaction. Successful completion is one atomic append:

```text
TX generated usage, when present
   lane move to target
   exact branch-summary entry
   label fact, when present
   finished operation snapshot
```

The summary entry chains from the moved target because mutations apply in order. A crash sees either an uncommitted navigation at its source or a fully completed navigation. No prepared-summary or post-move recovery state is needed.

### Manual compaction

Determine whether useful context exists before operation acceptance. If not, return `NothingToCompact` and write nothing. Successful settlement atomically appends usage, the compaction entry, and finished state.

## 5. Interpreter, abort, and recovery

### Interpreter

```ts
async function drive(operation: CurrentOperation): Promise<OperationResult> {
  while (true) {
    const action = nextAction(operation.snapshot.state);

    switch (action.kind) {
      case "transition":
        operation = await commitTransition(operation, action);
        break;

      case "effect":
        operation = await commitEffectIntent(operation, action);
        const result = await runEffect(action.effect);
        operation = await commitEffectSettlement(operation, result);
        break;

      case "wait":
        return action.result;

      case "done":
        return action.result;
    }
  }
}
```

The exact implementation may avoid an explicit loop, but every path uses the same `nextAction`, intent, and settlement transitions. Manual drive gates these actions. Recovery loads current state and calls the same interpreter.

### Abort

Pure synchronous code cannot be interrupted. Abort and normal commits race only on the lane mutation line. The first abort transaction changes `control` to `cancel_requested`, stores the exact drained steer/follow-up payloads, and leaves the workflow state intact. After commit it signals a live cooperative effect and cancels unreleased gated effects.

Normal work-creating transitions recheck control and write nothing when cancellation already won. Settlement and accounting for already-intended effects remain allowed. Planned tools become aborted; restored started tools become interrupted; live started tools preserve their finalized result. Assistant/fetch settlement after cancellation is stored under its planned response ID with stop reason `aborted`.

Repeated `abort()` while the operation remains open appends nothing, signals nothing, and returns the same durable drained payloads. Abort after terminal state returns `NoActiveOperation`.

Effects are required to cooperate with `AbortSignal`. Provider and tool adapters must settle after cancellation rather than run indefinitely.

### Recovery

Restore performs indexed reads only:

```text
latest lane configuration
current operation header + latest total snapshot
current lane leaf
independent pending nextRun state
```

`getCurrentOperation()` returns the materialized header and one latest total snapshot. No historical operation records or older snapshots are reduced. The snapshot directly selects the next interpreter action.

The remaining unavoidable crash state is:

```text
effect intent is durable
effect settlement is absent
```

For generation, a later attempt is allowed only under the captured generation retry policy; when no attempt remains, recovery persists a synthetic error under the already-planned response ID. If durable cancellation won, recovery instead persists synthetic `aborted`. For tools, safe replay or planned interruption applies. Hook and external-effect side effects remain subject to the external-effect non-goal.

### Missing runtime identities

Before `prompt()`, `compact()`, or `navigateTree()` accepts work, the lane verifies that its configured model/provider and every active tool name can resolve. Missing identities return `MissingIdentities` and write nothing. The lane remains idle.

For an already-open operation, `resume()` verifies the identities required by its next effect. Missing identities return `MissingIdentities`, perform no effect, and leave the operation open at the same snapshot.

Registering the missing tools/providers/models unblocks execution. An explicit escape hatch is also needed to replace a missing model/provider referenced by existing lane or operation state. Its exact API and whether it rewrites a pending generation snapshot remain unresolved.

## 6. Storage and event boundaries

The redesign assumes the existing storage contract:

- one writer per session;
- per-lane mutation serialization;
- one session-wide monotonic `seq`;
- atomic non-empty mutation arrays;
- Memory one queue job, JSONL one physical object/array line, SQLite one transaction;
- all-or-none replay and publication;
- fenced SQLite writer ownership.

The state-machine design does not replace or weaken these requirements.

Lifecycle events such as streaming updates remain process ordered. Events that claim a durable commit fire only after the atomic transaction commits. `message_end` still means streaming ended; `entry_added` still means the entry committed.

Whether durable commit events, especially usage totals, must be published in strict global `seq` order remains unresolved. Strict ordering is more faithful to durable state but may briefly buffer a later lane's commit event until an earlier lane has installed and queued its event. Storage already resolves append promises in commit order, and state installation must contain no `await`, so expected buffering is small; this needs implementation-level validation before becoming a requirement.

## 7. Decisions from the design session

This section records decisions made while developing the redesign. A later session must not silently reopen them without a concrete contradiction or failing trace.

### 7.1 Total snapshots, not shallow or delta state

The latest operation snapshot is complete mutable operational state. Loading an operation reads its immutable header and exactly one latest snapshot. Do not split active generation, tool, queue, or deferred state into separate latest-value logs that must be collected and reconciled. Do not use patches or replay delta chains.

Total snapshots may consume more storage. Correctness and direct recovery take priority. Measure before optimizing. Permitted future optimizations are physical compression, backend-internal structural sharing, or compact field encoding that still decodes one snapshot into the complete state. Tool batches are the likely worst case because every call state repeats after transitions.

### 7.2 One external-effect non-goal

Provider calls, tool effects, hook-owned side effects, and provider billing are examples of one problem: an external effect may occur before its settlement becomes durable. Exactly-once execution cannot be guaranteed without cooperation from the external system. Enumerate these examples once and require idempotency, safe replay, reconciliation, or accepted uncertainty. Do not create separate orchestration theories for each example.

### 7.3 Abort

Abort is orthogonal operation control, not a workflow phase. Pure synchronous code cannot be interrupted. Abort and normal state changes race only at mutation/effect boundaries. The first durable cancellation request wins; later requests return the same drained steer/follow-up payloads without another write, signal, or event.

Effects must cooperate with `AbortSignal` and settle promptly. New ordinary effects do not start after cancellation. Settlement/accounting for an already-intended effect and accepted writes that survive abort remain allowed.

### 7.4 Deferred polling

Deferred polling is application-controlled. Each `resume()` performs at most one `fetchDeferred(..., { wait: 0 })`. The harness persists the response and either continues or remains suspended. The application uses `pollAfterMs` or its own schedule to decide whether to call `resume()` again.

`RetryPolicy` applies to generation, including generated summaries. It does not impose a deferred-fetch retry count, cap, backoff, or automatic polling loop. Provider expiration, terminal errors, and cancellation support are provider behavior the harness must report but cannot repair.

### 7.5 Context projection

Existing projection rules remain. This redesign changes orchestration state, not conversation projection. Durable error, aborted, and deferred assistant responses remain omitted; genuine output-limit `length` remains; exact overflow omission remains linked to compaction; compaction tails remain self-contained.

### 7.6 Missing runtime identities

`prompt()`, `compact()`, and `navigateTree()` check the lane's configured model/provider and active tool names before acceptance. If any are missing, return `MissingIdentities`, perform no effect, and write no operation. The lane remains idle until the application registers the missing identities or changes configuration.

`resume()` checks only identities required by the next effect. Missing identities return `MissingIdentities`, perform no effect, and leave the existing operation open at the same total snapshot.

Tools are restored by registering every active tool name mentioned by the relevant configuration. An idle lane can replace a missing model with `setModel(validModel)`. An open operation may contain a captured missing model reference, so an explicit model/provider replacement escape hatch is needed; its API and durable semantics are unresolved.

### 7.7 Navigation from root

Reject summarized navigation when `sourceLeafId === null`. There is no source branch to summarize and `BranchSummaryEntry.fromId` is non-null. Reject before hook invocation or durable acceptance.

### 7.8 Empty manual compaction

Manual compaction with no useful preparation returns `NothingToCompact` before durable operation acceptance. It does not invoke the decision hook or provider and writes no operation state.

### 7.9 Navigation decision hook

The current intended decision is that `before_navigation` applies only to summarized navigation. Unsummarized navigation validates and moves without that decision hook and cannot finish `declined`. Before making this normative, compare against current coding-agent behavior; do not perform that investigation as part of this handoff edit.

### 7.10 Sensitive events versus telemetry

Events and hooks may contain prompts, model output, tool arguments/results, deferred handles, and other sensitive application content. The previous goal that events are secret-free is rejected. Serving layers own authorization and optional redaction. Handler errors still need a JSON-safe normalized shape.

Telemetry remains content- and secret-free by default. It may contain declared identifiers, names, counts, durations, statuses, and usage, but not prompts, completions, tool data, provider payloads, headers, or credentials.

### 7.11 Storage assumptions

Single writer, lane mutation serialization, atomic non-empty append arrays, monotonic `seq`, all-or-none replay, and fenced SQLite ownership are existing storage contracts. They are assumed, already enforced, and not problems for the new state model to solve.

### 7.12 Lane-level next-run state

`nextRun` exists independently of an operation. It therefore needs one total latest-value lane runtime record or equivalent current-state projection containing the complete pending next-run items. Run acceptance atomically removes the captured items from that total lane state, appends their entries, opens the operation, and writes its first total snapshot. It must not be reconstructed from queue history plus entry absence.

The exact type and whether this lane runtime record also points at the current operation remain to be specified. Its semantic requirement is total latest-value state, not a patch/event stream.

### 7.13 Commit-event ordering

Strict global `seq` ordering for durable commit events is not yet accepted. Storage resolves append promises in commit order, so a central publication queue could order durable events with little buffering if state installation performs no `await`. However, it may introduce cross-lane head-of-line coupling or require delayed/reordered delivery. Keep process-local lifecycle events in process order. Validate the implementation consequences before strengthening durable-event ordering.

## 8. Unresolved questions and retained audit findings

This section preserves the full audit result and its current disposition so a later session can continue without rerunning the entire conversation. Findings marked **addressed by redesign** still require tests and must not be assumed correct merely because the state shape permits a solution.

### 8.1 Runtime and recovery findings

#### Tool outcome racing abort — addressed by redesign

Old failure: `before_tool` produced a blocked result, abort committed before the result append, and normal execution and abort reconciliation could append different content under one planned result ID.

Required transition rule: settlement enters the lane mutation line and reads current cancellation control. A planned/unstarted call becomes aborted when cancellation won. A live started effect may preserve its finalized result. A restored started effect becomes interrupted. Add an explicit regression for both commit orders.

#### Terminal state not tied to operation state — addressed by redesign

Old invalid examples included completed runs with pending steer, completed compaction after structural failure, and declined runs. Only exhaustive transition functions may create `FinishedOperationState`. They must reject terminal state while required work, unresolved effects, operation-owned queues/writes, or incompatible failure provenance remains.

#### Failure drain plus deferred user write — addressed by redesign

Old failure: failure drain applied a deferred user message but used only a process-local consumed-queue count to decide whether to restart generation. The atomic write-application transition must remove the write, append its entry, and set `checkpoint.need_assistant` in one transaction.

#### Crash after failure-drain queue consumption — addressed by redesign

Old failure: a steer entry committed, the process crashed before a new step started, and recovery no longer knew that terminal failure had been cleared. Queue application now atomically appends the entry and writes `checkpoint.need_assistant`, preserving the restart.

#### Assistant need lost after compaction — addressed by redesign

Old failure: the newest own entry became a `CompactionEntry`, so `needsAssistant()` could return false even though overflow or a tool-result tail required another assistant. `resumeAfter: CheckpointContinuation` explicitly preserves `need_assistant`; no tree-entry-role inference determines continuation.

#### Missing identities — policy partly decided

Pre-acceptance operation calls return `MissingIdentities` without writing. Resume leaves an existing operation open. The unresolved part is replacing a missing model/provider captured inside an open operation. See section 8.4.

#### Final-response hook cannot be mounted — unresolved implementation contract

`StreamAssistantConfig` currently lacks a callback that receives and may replace the settled assistant message before `message_end`. Transport `onResponse` sees HTTP metadata, not the final message. Add an explicit final-response callback and define metadata when transport failure is converted to an in-band error. This remains required regardless of state persistence.

#### Hook-produced assistant validity — accepted contract risk

A hook can return duplicate tool IDs, invalid deferred-handle combinations, pending stop reason, or non-JSON values. The decision is not to attempt exhaustive semantic validation. Hooks must obey their typed/runtime contract. Minimal boundary checks needed to prevent storage corruption or impossible core types may still be required; distinguish those from trying to validate model semantics.

#### Summarized navigation from root — decided

Reject before acceptance. See section 7.7.

#### Empty manual compaction — decided

Return `NothingToCompact` before acceptance. See section 7.8. The race between the pre-acceptance preparation read and another idle-lane mutation still needs a concrete admission algorithm; acceptance must revalidate the source leaf or reserve the lane while preparation is checked.

#### Unsummarized navigation decline — provisional decision

Treat `before_navigation` as summary-only and disallow decline for unsummarized navigation, subject to comparison with coding-agent.

#### Missing generation settlement after crash

Plain-language definition: generation intent is durable, the provider may have run, but no response transaction exists. Below the captured generation attempt limit, start a new numbered attempt. When no generation attempt remains, persist a synthetic assistant error under the already-planned response ID. If durable abort control won first, persist synthetic `aborted` instead. Avoid unexplained terms such as “unknown effect at cap” and “marker-backed cancellation” in the final specification.

#### Captured next-run cancellation — addressed by total state

Old ambiguity: a next-run item was captured by accepted run state but its entry was not yet appended, so cancellation could not distinguish pending from consumed. Acceptance must atomically remove the item from total lane next-run state and append it with the operation. After acceptance, cancellation reports `already_consumed`; there is no intermediate captured-without-entry state.

### 8.2 Event, hook, and telemetry findings

#### Usage totals can regress under out-of-order delivery — unresolved

Example: usage commit seq 11 with totals 20 is delivered before seq 10 with totals 10; a stateless consumer ends at 10. Options are strict session-sequenced durable event publication or requiring consumers to track maximum record `seq`. Strict ordering may buffer or couple lanes; investigate before deciding. See section 7.13.

#### Secret-free event claim — decided

Reject the claim for events/hooks; retain it for telemetry only. See section 7.10.

#### Safe tool replay event lifecycle — unresolved

A safely replayed tool needs a defined `turnId` and tool event lifecycle. One candidate is deriving `turnId` from the durable assistant generation `stepId` and emitting recovery turn/tool brackets. Another is making recovery tool event fields differ. Decide when the event model is implemented; do not let telemetry invent a separate answer.

#### Telemetry sleep parents — fix required

Retry sleeps can occur under turn or checkpoint scopes, while the current schema permits only operation parents. Either add turn/checkpoint as allowed parents or explicitly pass operation-level context to sleeps. Prefer schema parents matching actual call structure.

#### `compaction_end.fromHook` without a result — fix required

Declined, pre-source aborted, and early failed compactions have no result provenance. Make structural end events discriminated: completed carries `entry` and `fromHook`; declined/aborted omit both; failed carries error and omits result provenance.

#### Async callbacks outside Effects — unresolved contract detail

`systemPrompt`, `toProviderMessages`, and entry projectors may be async and can perform external I/O outside the complete effect boundary. Prefer a contract that these callbacks are deterministic/idempotent computation with no externally visible side effects and may repeat. Effectful interception should use hooks. Also define the system-prompt preview supplied to `before_run` versus per-request evaluation.

#### “Operations never throw” wording — fix required

Expected caller errors resolve through `Result`; storage faults, close, and invariant defects may reject. Correct the public API comment accordingly.

#### Session-ordered durable events — unresolved

See usage ordering above and section 7.13. Non-durable stream/tool lifecycle must not be reordered merely to match storage `seq`.

### 8.3 Storage and fork findings

#### Read-only normalized-v3 fork has no configuration — unresolved

A normalized-v3 `main` is unconfigured until harness attachment, while current fork rules require copying current configuration. Options: permit an unconfigured destination `main`, require a seed in fork options, or require harness attachment before fork. The earlier recommendation was to allow an unconfigured destination and seed it on first attachment, but this is not yet accepted.

#### JSONL fork versus active source queue — unresolved

A coherent fork must order its snapshot with concurrent source appends. The repository currently claims not to retain open storage instances. Possible resolution: accept the open `Session` as fork source and enqueue a private snapshot operation on its mutation queue. Validate against existing repository API before deciding.

#### JSONL conversion wording — documentation fix

Clarify that conversion writes a temporary file and atomically renames it over the original path; the final directory and filename do not change.

#### SQLite lane-move action — schema fix

The proposed/current `LogItem` distinguishes lane `create` and `move`, but the shown `lane_moves` table lacks an action column. Add it or define an unambiguous derivation. Explicit column is simpler.

#### Storage efficiency of total snapshots — measure

Total snapshots can repeat large queue payloads and tool batches. Do not weaken semantics preemptively. Add size benchmarks for long runs, large tool batches, and repeated queued writes. If needed, optimize physical backend representation while keeping `getCurrentOperation()` equivalent to header plus one total snapshot.

### 8.4 Public API and identity follow-ups

#### Missing model/provider replacement escape hatch — unresolved and important

Idle lane configuration can be repaired with `setModel(validModel)`. An open operation may have captured the missing reference in its total snapshot; changing only lane configuration must not silently alter already-started generation under the prior contract. Possible APIs include an explicit operation-state repair method or runtime model-reference override registry. The API must be explicit, durable where necessary, and limited to missing identities rather than general in-flight mutation.

#### Undeclared tool context generic — note for implementation

`AgentHarnessOptions.toolContext` uses `TContext` while the shown interface is not generic. Make the options/harness/tool types consistently generic or use `unknown`. Do not block state-machine design on this.

#### Per-entry effective usage query — note

The design defines ledger-adjusted effective entry cost but exposes only immutable entry snapshots and session totals. Add a query such as `getEntryUsage(entryId)` if consumers need it. Defer until ledger API implementation.

#### Adjustment `runId` — note

Public `recordUsage()` cannot supply `runId` although adjustment records permit one. Prefer deriving the current operation ID on the lane mutation line when present rather than allowing arbitrary caller-provided operation IDs.

#### Wide deferred-fetch return type — note

The landed `Models.fetchDeferred()` type may return wide `AssistantMessage`. The harness adapter must reject/narrow a final `pending` value before hooks, events, persistence, or state settlement. Do not assign unrelated pi-ai work without checking the landed API.

#### Temporary `HarnessNotImplemented` — note

Define it as a scaffold-only promise rejection outside final public `Result` unions. Remove it operation by operation as owning packages land.

#### Application message schema registry — note

J6 requires runtime schemas for application-defined `AgentMessage` variants but no registration API is specified. A likely surface is immutable Session/repository open options keyed by the custom discriminator. Resolve with storage schema work.

### 8.5 Work-package and document follow-ups

#### R3 versus H0 main initialization — fix plan

R3 owns restore but final reduction requires an initialized total lane configuration; H0 currently owns fresh/v3 main initialization later. Move one-time main seed initialization into R3 or restructure dependencies so restore never receives an unconfigured lane. “Restore writes nothing” should mean after optional first attachment initialization.

#### D0 reservation marker — note

The track prose reserves D0 indirectly but the package lacks the standard immediate reservation marker. Add the marker or document a track-level reservation exception.

#### SQLite search follow-ups — assign owner

Search completion, cursor/limit support, and indexed `findEntries` work need an explicit unchecked package owner, likely O4, or must be marked non-normative.

#### Required reading — add reducer/current-state implementation

The old required-reading list omits the reducer despite several packages depending on it. If the redesign lands, replace that reading with the new operation-state transition module and keep the old reducer only as pre-convergence history.

#### Preserve implementation boundaries

Telemetry fixes, public type cleanup, fork behavior, and work-package ownership are not reasons to reintroduce implicit operation reduction. Track them separately from the state-machine core.

### 8.6 Validation required before adoption

Prototype the total-snapshot model against these traces before replacing the canonical design:

1. successful assistant generation;
2. retryable generation and crash with missing settlement;
3. overflow compaction requiring another assistant;
4. blocked tool versus abort in both commit orders;
5. started safe/unsafe tool crash and recovery;
6. terminal failure plus deferred user write;
7. terminal failure plus consumed steer followed by crash;
8. repeated application-driven deferred resumes with pending/ready/error results;
9. manual compaction empty/prepared/generated/hook paths;
10. summarized navigation, abort before final transaction, and atomic completion;
11. repeated abort before effect, during effect, and after finish;
12. missing identities for idle operation calls and resume.

For every external effect, test crash before intent, after intent, and after atomic settlement. For every public race, test both lane-mutation orders. Compare automatic and manual drive durable snapshots and outcomes.
