# AgentHarness v2 explicit-state redesign

> **Status:** Working handoff document. This is not yet the canonical implementation specification. `harness-v2.md` remains the complete requirements inventory until this design is validated and adopted.
>
> **Purpose:** Preserve the redesign and decisions from the current design session in a form a new session can read quickly. The design deliberately replaces implicit recovery reduction with explicit, total durable operation state.

## 1. Concise model

An `AgentHarness` owns one durable session. The session contains:

1. **Conversation tree** — append-only message, compaction, branch-summary, and custom entries.
2. **Lanes** — permanent names pointing at tree leaves. Each lane has at most one open operation.
3. **Lane configuration** — one total replacement containing model reference, thinking level, and active tool names.
4. **Operational state** — one immutable `OperationRecord` plus append-only total `OperationStateRecord`s.
5. **Usage ledger** — immutable usage records, independent of whether later orchestration succeeds.
6. **Global facts** — latest-wins name, labels, and custom facts.

Lanes run concurrently. One writer owns the session. Each lane serializes state-dependent decisions on a mutation line. Storage serializes all appends and assigns one session-wide `seq`.

### Operations

A lane accepts one of three operation kinds:

- **run** — prompt, assistant generations, tools, steering/follow-up, deferred writes, and automatic compaction;
- **compaction** — standalone manual compaction;
- **navigation** — move to another tree entry, optionally with a summary.

An accepted operation has one durable `OperationRecord` and a sequence of total state records. The latest `OperationStateRecord` directly states what the operation is doing and what may happen next.

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

### Why this is better

The old design persisted many small orchestration events and reconstructed a hidden program counter from their combinations and from entry absence. One assistant settlement could be durable as response-only, response-plus-usage, response-plus-usage-plus-tool-plan, or several other prefixes. Queue status, failure clearance, and navigation progress were likewise inferred.

The redesign persists the program counter directly as one total `OperationStateRecord` and commits output, accounting, and the next state atomically. This gives five concrete benefits:

1. **Direct recovery.** Load one immutable operation record and one latest total state record; do not fold operation history.
2. **Fewer crash states.** A repeat-sensitive effect has only intent absent, intent present with settlement absent, or settlement and next state committed.
3. **Exhaustive transitions.** A pure transition function switches on explicit state and input. Missing cases are visible in types and tables.
4. **Local terminal validity.** Only transitions from eligible states can create a finished state; finish validity is not a historical audit.
5. **Mechanical testing.** Crash before intent, after intent, and after atomic settlement. Public races have two mutation-line orders.

The trade-off is repeated state data. The first implementation accepts that cost. It must not recover space by reintroducing patches, partial child logs, or historical state collection.

## 2. Replace implicit reduction with total operation state

The current design reconstructs orchestration from combinations of records, entry presence, lane pointers, and later transitions. The redesign persists the continuation directly.

### Operation record

`OperationRecord` contains immutable acceptance data and is written once:

```ts
interface OperationRecord {
  type: "operation";
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

### Total operation state record

Every state transition appends one record containing all current mutable orchestration state for that operation:

```ts
interface OperationStateRecord {
  type: "operation_state";
  id: string;
  lane: string;
  operationId: string;
  revision: number;
  state: OperationState;
}
```

`revision` starts at 1 and increases by exactly one. State records are append-only; the latest revision is authoritative.

**Total means total.** An `OperationStateRecord` is not a patch and needs no older state record for interpretation. It contains the complete current workflow state, retry state, tool plan and per-call states, pending operation-owned queues and writes, deferred source, and cancellation control. It may reference immutable conversation entries, usage records, and its immutable `OperationRecord` by ID, but no older operational state record supplies missing state.

The first implementation accepts the storage cost of total state records. Do not introduce delta chains, child-state logs, or patch replay to optimize them. If measurement later shows a problem, optimize physical encoding or compression while preserving the logical total-state contract.

### Loading current state

The public storage concept is:

```ts
interface CurrentOperation {
  operation: OperationRecord;
  stateRecord: OperationStateRecord;
}

getCurrentOperation(lane: string): Promise<CurrentOperation | undefined>;
```

Backends answer through their latest-operation index. They read one immutable `OperationRecord` and exactly one latest total `OperationStateRecord`. They do not scan or fold operation history, inspect entry absence to infer a phase, or collect partial task state from several operational logs.

Memory keeps the latest state record in a map. JSONL updates its latest-state projection while replaying the file. SQLite keeps a current-operation projection and reads the selected operation/state records by indexed ID.

### Records retained and replaced

Retain:

- total `lane_config` replacements;
- immutable usage and adjustment records;
- immutable `OperationRecord`;
- total `OperationStateRecord`s;
- facts, lane history, and conversation entries.

The total state record replaces the recovery authority currently spread across:

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

### Lane state and inbox records

`nextRun` belongs to a lane even when no operation is open. Its current state is therefore a separate total lane record:

```ts
interface LaneStateRecord {
  type: "lane_state";
  id: string;
  lane: string;
  revision: number;
  currentOperationId: string | null;
  pendingNextRun: QueuedInput[];
}

interface QueuedInput {
  entryId: string;
  message: ProvisionedEntry<MessageEntry>;
}
```

The latest `LaneStateRecord` is total. It is not reconstructed from queue history or entry absence. `getCurrentLaneState(lane)` returns that one record. Run acceptance atomically removes captured next-run items, appends their entries, sets `currentOperationId`, writes the immutable operation record, and writes the first total operation state.

Run-owned input is contained completely in `ActiveRunState`:

```ts
interface RunInbox {
  steer: QueuedInput[];
  followUp: QueuedInput[];
  writes: PendingWrite[];
}

interface PendingWrite {
  entryId: string;
  entry: ProvisionedEntry<MessageEntry | CustomEntry>;
}
```

Queue acceptance writes a new total lane or operation state before resolving. Consumption atomically appends the entry and removes the item from total state. Deferred writes survive abort; steer and follow-up are moved into durable abort control and removed from the active inbox by the first abort transaction.

Cancellation needs history only for an exact item lookup after it leaves current state. A compact disposition record supplies that without participating in recovery:

```ts
interface QueueDispositionRecord {
  type: "queue_disposition";
  id: string;
  lane: string;
  entryId: string;
  disposition: "cancelled" | "cleared_by_abort";
}
```

`cancelQueued(entryId)` runs on the lane mutation line:

- pending in lane `nextRun` or run steer/follow-up: atomically remove it and append `cancelled`;
- target entry exists or was captured and appended by run acceptance: `already_consumed`;
- disposition exists: `already_cleared`;
- otherwise: `UnknownQueueItem`.

Capture and entry append occur in the same run-acceptance transaction, so no captured-but-unappended state exists. Queue modes affect which pending steer/follow-up items a checkpoint consumes, but every consumed set is removed and appended atomically.

| Public input | Admission | Total-state transition |
|---|---|---|
| `nextRun` | any open harness state | append to `LaneStateRecord.pendingNextRun`; never starts a run |
| `steer` | active running run | append complete item to `ActiveRunState.inbox.steer` |
| `followUp` | active running run | append complete item to `ActiveRunState.inbox.followUp` |
| lane-view tree write during run | active run, including suspension/cancellation | append complete item to `inbox.writes`; survives abort |
| lane-view tree write while idle | idle lane | append entry directly and advance leaf |
| lane-view tree write during compaction/navigation | structural operation open | wait until structural operation ends, then re-evaluate |
| `cancelQueued` | item currently pending | remove from total state and append disposition atomically |
| checkpoint consumes input | eligible pending item | append entry, remove item, and update continuation atomically |
| first abort | running run | move steer/follow-up into durable abort control; writes remain pending |
| finish | inbox empty and no required continuation | final operation state and lane current-operation clear atomically |

Acceptance, cancellation, application, abort, and finish all run on the same lane mutation line. Thus each race has only caller-A-first or caller-B-first history; no item can be both pending and applied in durable current state.

## 3. Operation state

```ts
type OperationState =
  | ActiveRunState
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
  inbox: RunInbox;
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
      overflowRecoveryUsed: boolean;
    }
  | {
      kind: "may_finish";
    };
```

`continuation` replaces inference such as `needsAssistant()`. A compaction stores the continuation it must resume. Overflow compaction resumes `need_assistant` with the same trigger and `overflowRecoveryUsed: true`; another recoverable overflow for that trigger enters failure drain. Applying a new user-context message atomically changes the continuation to `need_assistant` with that message ID and resets the flag to false.

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

### Structural decision and summary state

Manual compaction, auto-compaction, and summarized navigation first enter a decision state. The decision hook may decline, supply a complete result, or select generated work. A crash while the hook is running reruns it; hook-owned side effects follow the external-effect non-goal. Once generated work is selected, the state change is durable and the decision hook does not run again.

```ts
type StructuralDecisionState =
  | {
      status: "deciding";
    }
  | {
      status: "generating";
      generation: SummaryGenerationState;
    };

interface SummaryGenerationContext {
  taskId: string;
  resultEntryId: string;
  kind: "compaction" | "branch_summary";
  configuration: LaneConfiguration;
  retryPolicy: RetryPolicy;
  reason?: "manual" | "threshold" | "overflow";
  overflow?: {
    supersededResponseEntryId: string;
    triggerMessageId: string;
  };
}

type SummaryGenerationState =
  | {
      status: "ready";
      context: SummaryGenerationContext;
      nextAttempt: number;
    }
  | {
      status: "effect_pending";
      context: SummaryGenerationContext;
      attempt: number;
      usageRecordIds: string[];
    }
  | {
      status: "retry_wait";
      context: SummaryGenerationContext;
      nextAttempt: number;
      notBefore: number;
      errorMessage: string;
    };
```

One structural attempt may make one or two provider requests. Before its first request, total state becomes `effect_pending`. After each request, reported usage and a new total state containing its usage record ID commit atomically. Intermediate response content need not persist; a crash before the final structural transaction makes the whole attempt uncertain and starts a later numbered attempt only under the captured generation policy. Failed-attempt usage remains in the ledger.

Hook-supplied compaction and branch-summary entries set `fromHook: true`; generated entries set it false. Hook usage, when present, commits atomically with the structural result. Generated result usage is the sum of successful-attempt request usage records.

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

The total operation state record contains the complete batch and every call state. This can duplicate data across state records; correctness and direct recovery take priority. Parallel tool execution remains possible: several calls may be `effect_pending`, while result commits remain source ordered.

### Deferred state

```ts
type DeferredState =
  | {
      status: "suspended";
      stepId: string;
      sourceEntryId: string;
      poll: number;
      configuration: LaneConfiguration;
    }
  | {
      status: "effect_pending";
      stepId: string;
      sourceEntryId: string;
      poll: number;
      responseEntryId: string;
      usageRecordId: string;
      configuration: LaneConfiguration;
    };
```

The original assistant generation that returns `deferred` atomically writes its response/usage and enters `suspended`, copying that generation's total configuration once. The exact source entry supplies provider, model, and complete handle; copied active tool names govern a ready response's tool calls.

Each `resume()` performs at most one `fetchDeferred(..., { wait: 0 })`. It atomically changes `suspended` to `effect_pending` before polling. The application decides whether and when to call `resume()` again. Deferred polling has no harness retry count, retry cap, or retry sleep.

Settlement is atomic:

- another `deferred` response: append response/usage, require complete handle equality, increment `poll`, and suspend on the new response entry;
- ready response: append response/usage and move to tools or the appropriate checkpoint continuation;
- provider error or rejected fetch converted to error: append response/usage and enter failure drain;
- unmarked returned `aborted`: append response/usage and suspend on the unchanged source; the application may resume again;
- durable cancellation: best-effort cancel the newest source handle and settle any already-planned response under its ID as `aborted`.

If a process dies with a poll `effect_pending`, the remote check may have happened but no settlement is durable. A later application `resume()` provisions a fresh poll and response/usage IDs; no retry cap is applied. Provider behavior such as expiration or cancellation support is outside harness control.

### Manual compaction state

```ts
interface ManualCompactionState {
  kind: "compaction";
  control: OperationControl;
  customInstructions?: string;
  structural: StructuralDecisionState;
}
```

Admission computes preparation against the source leaf. Empty preparation returns `NothingToCompact` before acceptance. Acceptance atomically writes `OperationRecord`, `ManualCompactionState` in `deciding`, and `LaneStateRecord.currentOperationId`. In `deciding`, `before_compaction` may decline, supply a complete compaction, or select generated work. Decline or hook-supplied completion commits finished state directly. Generated work follows `SummaryGenerationState`; success atomically commits usage, the complete `CompactionEntry`, and finished state.

### Navigation state

```ts
type NavigationOperationState =
  | {
      kind: "navigation";
      control: OperationControl;
      targetId: string | null;
      label?: string;
      customInstructions?: string;
      summarize: false;
      phase: { kind: "ready_to_commit" };
    }
  | {
      kind: "navigation";
      control: OperationControl;
      targetId: string;
      label?: string;
      customInstructions?: string;
      summarize: true;
      phase: {
        kind: "summary";
        structural: StructuralDecisionState;
      };
    };
```

After target/source validation, acceptance atomically writes `OperationRecord`, the appropriate navigation state, and `LaneStateRecord.currentOperationId`. Unsummarized navigation has no decision hook. Summarized navigation runs `before_navigation`, which may decline, supply a complete summary, or select generated work. All source-tree reads and provider/hook work happen before the final structural transaction. Completion atomically moves the lane, appends the exact summary when required, writes the label when present, writes finished operation state, and clears `LaneStateRecord.currentOperationId`.

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

> Compute one next total operation state, then atomically append all conversation, usage, fact, lane, and operation-state mutations that make that state true.

A transaction either commits all logical mutations or none.

### Lane configuration

`lane_config` remains a separate total latest-value record containing model reference, thinking level, and active tool names. `AgentHarnessOptions` supplies an immutable seed used for first attachment of `main` and every later `createLane`; anchors and other lanes never supply configuration. Configured lane creation atomically creates the pointer and first total config.

`setModel`, `setThinkingLevel`, and `setActiveTools` immediately commit one total replacement on the lane mutation line, including during an operation or cancellation. Starting a generation snapshots the current configuration into operation state in the same lane ordering. Later setters affect only later generations; retries keep the generation's captured value. Tool implementations and contexts remain environmental and are resolved by captured active names immediately before a real invocation.

### Run acceptance

`skill()` / `promptFromTemplate()` resource expansion and prompt normalization happen before acceptance. `before_run` is an effect before the lane acceptance transaction; it receives only the normalized caller prompt, not pending next-run items. Its returned messages, optional system-prompt override, and resume data are held until acceptance. A concurrent winner may make the lane busy, in which case the hook output is discarded and no operation is written.

The acceptance transaction validates idle state and identities, captures all pending next-run input, and atomically writes:

```text
TX updated LaneStateRecord:
     captured nextRun removed
     currentOperationId = O
   OperationRecord O
   captured nextRun entries
   caller prompt entries
   before_run injected entries
   first OperationStateRecord:
     run checkpoint
     continuation need_assistant(newest user-context entry)
     inbox empty
```

The operation call resolves only after this transaction. There is no accepted operation with missing initial entries.

### Checkpoint and finish boundary

At a run checkpoint, transitions occur in this order:

1. atomically apply accepted deferred writes;
2. atomically consume eligible steering according to steering mode;
3. run threshold compaction when required, preserving the current continuation;
4. if continuation is `need_assistant`, start generation;
5. after assistant/tool continuation is exhausted, atomically consume eligible follow-up input;
6. when continuation is `may_finish` and inbox is empty, invoke `before_run_end`;
7. conditionally finish.

A `before_run_end` follow-up is committed only if control is still running and the operation is still at the same finish boundary. Its message entry and `need_assistant` state commit atomically. Abort or another input that wins first drops the stale hook result.

Finish is one lane mutation transaction:

```text
TX final OperationStateRecord
   LaneStateRecord.currentOperationId = null
```

It commits only when total state proves no required work remains. Steer/follow-up acceptance, deferred writes, abort, and finish are serialized, so only input-first or finish-first histories exist.

### Assistant attempt

Plan before the effect:

```text
TX operation state:
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
   operation state:
     phase tools
     complete result-ID plan
```

or:

```text
TX assistant entry R1
   usage U1
   operation state:
     phase assistant
     retry_wait for attempt 2
```

or:

```text
TX assistant entry R1
   usage U1
   operation state:
     phase compaction
     exact overflow response link
     resumeAfter need_assistant
```

There is no durable response-without-usage or accounted-response-without-classification state.

### Assistant settlement classifier

Classification is pure and runs before the atomic settlement transaction. Cancellation control takes priority. Without cancellation, evaluate in this order:

| Durable response | Next state |
|---|---|
| explicit provider context-limit error | overflow handling |
| `stop` with reported input plus cache-read greater than captured context window | overflow handling |
| Xiaomi-compatible zero-output/full-window pressure | overflow handling |
| `length` with output below captured intended output limit | overflow handling |
| `deferred` with valid handle | deferred suspended |
| unmarked `aborted`, attempts remain | generation retry wait |
| unmarked `aborted`, no attempts remain | failure drain |
| retryable `error`, attempts remain | generation retry wait |
| other `error` | failure drain |
| `toolUse` or accepted response with calls | tools with complete result plan |
| `stop` or genuine output-limit `length` | checkpoint `may_finish` |

`intendedOutputLimit` is the caller's explicit limit or model limit before context clamping. The percentage heuristic is only the existing Xiaomi-compatible signal. Overflow handling never creates a tool plan.

For overflow, `need_assistant` carries `overflowRecoveryUsed`. If false, enter compaction with the exact superseded response/trigger and resume with the flag true. If already true, enter failure drain. Consuming newer user-context input creates a new trigger and resets the flag.

A genuine output-limit `length` remains in provider context. If it contains tool calls, create the complete batch plan but execute no call; append one planned `isError: true` result per call explaining that truncation may have left arguments incomplete. Those results require another assistant generation.

### Tool call

After clearance and immediately before execution:

```text
TX operation state:
     call i = effect_pending
     effective args and replay declaration stored
```

After execution/finalization:

```text
TX tool usage, when present
   planned tool-result entry
   operation state:
     call i = completed
     next continuation recorded when batch completes
```

If a crash leaves `effect_pending`, replay only when the declaration and implementation are safe; otherwise append the planned interrupted result.

The complete batch plan exists before tool lookup, argument validation, or `before_tool`. Calls are identified privately by source index; public hooks/events/tool context use provider `toolCallId` and tool name. Tool IDs are required to be response-local unique.

| Call state/input | Atomic result and next state |
|---|---|
| planned, unknown tool or invalid arguments | planned error result; mark completed |
| planned, `before_tool` blocks or throws | planned blocked error; mark completed |
| planned, control cancelled | planned aborted error; mark completed |
| planned, clearance succeeds | total state becomes `effect_pending`; then dispatch effect |
| live effect settles | run `after_tool`; usage + finalized result + completed state |
| restored effect pending, replay safe now and when started | re-execute persisted args, finalize, usage + result + completed state |
| restored effect pending, replay unsafe | interrupted error + completed state |
| genuine `length` planned call | explanatory error + completed state; no clearance/effect |

`after_tool` may patch content, details, error status, usage, and `terminate`; the finalized decision is stored in the result entry/state. Hook output must satisfy its contract. A hook crash before the atomic result transaction may rerun after a safe replay.

Sequential mode clears, starts, executes, finalizes, and commits one call before the next. Parallel mode performs clearance and effect-intent commits in source order, dispatches effects in source order without awaiting earlier ones, allows concurrent settlement, and commits finalized results in source order. Several calls may therefore be durable `effect_pending` while results still form a source-order prefix.

### Queue or deferred-write application

Acceptance updates the total operation state with the complete provisioned payload. Application is atomic:

```text
TX message/custom entry
   operation state with item removed
   continuation updated when the entry requires an assistant
```

A crash cannot consume an item without updating operation state, or update operation state without appending the entry.

### Structural decision and generation transitions

| State/input | Atomic result and next state |
|---|---|
| deciding, hook declines | finished `declined` for standalone operation; threshold returns to prior continuation; overflow enters failure drain |
| deciding, hook supplies result | usage + exact typed entry + continuation/finished state |
| deciding, hook selects generation | total state with generated summary `ready`; hook will not rerun |
| generation ready or retry elapsed | total state `effect_pending`; then provider request(s) |
| generation retryable failure | reported usage + retry-wait state |
| generation terminal/exhausted | standalone finished failed or run failure drain |
| generated compaction succeeds | usage + compaction entry + prior continuation/finished state |
| generated branch summary succeeds | usage + move + summary + label + finished state |
| cancellation before structural commit | reported usage still commits; generated result is discarded; finish aborted |

Structural provider streams are internal and emit no public assistant-message lifecycle. Every provider request still crosses the effect boundary and writes reported usage before another request or structural completion. Hook-provided details remain opaque; generated details may use harness-owned structure.

### Automatic compaction

Threshold and overflow compaction are run phases, not nested operations. Threshold compaction preserves the continuation that caused the context check. Hook decline or empty useful preparation returns to that continuation because threshold compaction is proactive.

Overflow compaction carries the exact superseded response entry and trigger in `SummaryGenerationContext`, omits that response from preparation and `retainedTail`, and resumes `need_assistant` with `overflowRecoveryUsed: true`. Hook decline or empty preparation enters failure drain because the rejected request cannot fit without compaction.

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
   finished operation state
```

The summary entry chains from the moved target because mutations apply in order. A crash sees either an uncommitted navigation at its source or a fully completed navigation. No prepared-summary or post-move recovery state is needed.

### Manual compaction

Determine whether useful context exists before operation acceptance. If not, return `NothingToCompact` and write nothing. Successful settlement atomically appends usage, the compaction entry, and finished state.

### Transition summary

This is the normative high-level machine. Detailed transition functions must refine, not contradict, it.

| Current state | Trigger | Durable transaction | Next state |
|---|---|---|---|
| idle lane | accepted prompt | lane state + operation record + initial entries + total operation state | run checkpoint `need_assistant` |
| checkpoint `need_assistant` | drive | generation intent state | assistant effect pending |
| assistant effect pending | settled response | response + usage + classified total state | retry/tools/deferred/compaction/checkpoint/failure |
| assistant retry wait | delay elapsed | next generation intent state | assistant effect pending |
| tools planned | clearance succeeds | call effect-pending total state | tools with started call |
| tool effect pending | finalized result | usage + result + total state | tools or checkpoint |
| checkpoint | accepted steer/follow-up/write | total state containing item | same checkpoint |
| checkpoint | apply/consume item | entry + total state without item | `need_assistant` or prior continuation |
| checkpoint | context threshold | compaction decision state | compaction |
| compaction deciding | hook result | decline/result/generated-source transaction | continuation/generating/failure |
| summary effect pending | provider outcome | usage + retry or final structural transaction | retry/continuation/finished/failure |
| assistant response deferred | settlement | response + usage + copied deferred state | suspended |
| deferred suspended | one `resume()` | poll intent state | deferred effect pending |
| deferred effect pending | poll settles | response + usage + classified state | suspended/tools/checkpoint/failure |
| failure drain | new user-context item applied | entry + total state | checkpoint `need_assistant` |
| finish boundary | no hook follow-up or pending work | final state + lane state clears operation | finished |
| any active state | first abort | cancellation control + drained inbox | same workflow under cancellation |
| cancellation control | reconciliation complete | required results/writes + final state + clear lane operation | finished aborted |

### Crash table

Atomic transactions have no internal crash prefix. For each repeat-sensitive effect, only these states exist:

| Crash point | Durable state | Recovery |
|---|---|---|
| before effect-intent transaction | previous total state | plan the effect normally |
| after effect intent, before dispatch | effect pending; effect did not run or dispatch status was lost | apply the effect's uncertainty policy; cancellation prevents dispatch |
| during/after external effect, before settlement transaction | effect pending; external outcome unknown | generation retries under captured policy, tools replay only when safe, deferred waits for another application resume, cancellation settles as specified |
| after settlement transaction | output, usage, and next total state all durable | continue from next state; never repeat settlement |
| before queue/write application transaction | item remains fully pending in total state | apply later |
| after queue/write application transaction | entry exists and item is absent; continuation updated | continue; never apply twice |
| before final structural transaction | source leaf and generated/hook work remain uncommitted | retry/recompute only according to current state and external-effect policy |
| after final structural transaction | move/entry/label/usage/finished state all durable | operation is complete |
| after first abort transaction | cancellation and drained payloads durable | never start new ordinary effects; reconcile pending workflow |
| after terminal transaction | finished state and lane clear are durable | lane is idle |

The unavoidable uncertain interval is effect intent durable with settlement absent. Provider, tool, hook, and billing examples all belong to the single external-effect non-goal.

## 5. Interpreter, abort, and recovery

### Interpreter

```ts
async function drive(operation: CurrentOperation): Promise<OperationResult> {
  while (true) {
    const action = nextAction(operation.stateRecord.state);

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
current `OperationRecord` + latest total `OperationStateRecord`
current lane leaf
independent pending nextRun state
```

`getCurrentOperation()` returns one immutable `OperationRecord` and one latest total `OperationStateRecord`. No historical operation or state records are reduced. The state record directly selects the next interpreter action.

The remaining unavoidable crash state is:

```text
effect intent is durable
effect settlement is absent
```

For generation, a later attempt is allowed only under the captured generation retry policy; when no attempt remains, recovery persists a synthetic error under the already-planned response ID. If durable cancellation won, recovery instead persists synthetic `aborted`. For tools, safe replay or planned interruption applies. Hook and external-effect side effects remain subject to the external-effect non-goal.

### Missing runtime identities

Before `prompt()`, `compact()`, or `navigateTree()` accepts work, the lane verifies that its configured model/provider and every active tool name can resolve. Missing identities return `MissingIdentities` and write nothing. The lane remains idle.

For an already-open operation, `resume()` verifies the identities required by its next effect. Missing identities return `MissingIdentities`, perform no effect, and leave the operation open at the same state record.

Registering the missing tools/providers/models unblocks execution. An explicit escape hatch is also needed to replace a missing model/provider referenced by existing lane or operation state. Its exact API and whether it rewrites pending generation state remain unresolved.

### Effects boundary and manual drive

Every durable transition, provider request/fetch, individual tool invocation, hook invocation, and timer crosses one `Effects` method. Procedures receive no direct Session, Models, tool registry, or hook runner. Pure state calculation, immutable tree/context reads, and ID allocation are not gated effects; after any awaited read, the next effect/commit revalidates current total state and cancellation control.

Automatic drive executes the interpreter. Manual drive parks before each effect and exposes one JSON-safe action. `peekAction()` is stable and side-effect free; `executeAction()` releases exactly one action; `runToCompletion()` releases nested actions before awaiting parents. Lane-surface operations such as steer, cancellation, configuration setters, and writes remain ungated so tests can exercise both race orders.

Closing while an action is parked rejects it without execution. The durable state is exactly the prefix of committed total state records and effect intents.

### Close

Close is process lifecycle, not operation abort. It writes no cancellation or terminal operation state. It stops public admission, signals cooperative in-flight effects, rejects parked/local operation promises, lets already-admitted lane mutations and Session appends settle, drains storage, and releases only its writer claim. A prior effect intent may remain without settlement; reopening loads that total state and ordinary recovery applies. Durable open operations remain resumable.

### Hook replay summary

- `before_run`: before acceptance; output commits in the acceptance transaction; reruns only when no operation was accepted.
- `transform_context`, `before_request`, and `before_payload`: per provider request; ephemeral and may rerun with a repeated request.
- `after_response`: transforms the settled message before `message_end` and atomic settlement; `streamAssistant` still needs an explicit final-message callback to mount it.
- `before_tool`: runs while call is planned; effective args become durable only in effect-pending state; reruns if that state did not commit.
- `after_tool`: runs after a real effect or safe replay; output becomes durable with usage/result/completed state.
- compaction/navigation decision hooks: run in `deciding`; generated-source state prevents rerun; supplied output commits directly with the result.
- `before_run_end`: may rerun at the same finish boundary; its returned follow-up commits conditionally.

Hook-owned external side effects must be idempotent under the external-effect non-goal.

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

### Storage representation of new state

All backends expose latest total lane/operation state through indexes or replayed projections:

- Memory: latest lane state, open operation ID, immutable operation record, and latest operation state maps;
- JSONL: ordinary object for one mutation and one array line for an atomic transition; replay updates latest-state/open-operation projections; a torn final array is discarded wholly;
- SQLite: append-only operation-state rows plus a current lane/open-operation projection, all updated in the same transition transaction.

A finished transition appends final operation state and clears the lane's current-operation projection atomically. Forks copy conversation, current facts, pointers, and fresh lane configuration, but no operation or usage state. Coding-agent v3 normalization still opens one idle, initially unconfigured `main`; first harness attachment seeds its total lane configuration.

### Public surface consequences

Existing lane methods remain: `prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`, `resume`, `abort`, `steer`, `followUp`, `nextRun`, `cancelQueued`, `recordUsage`, configuration setters/getters, lane tree view, `watch`, `waitForIdle`, `runWhenIdle`, manual drive, and `close`. Harness lane management (`lane`, `createLane`, `lanes`) and `watchSession` remain. Expected caller failures use `Result`; storage faults, close, and invariant defects may reject.

`LaneSnapshot.operation` is derived directly from current total state. It reports running, suspended, or cancelling; streaming drafts and running tools remain process-local additions. `SuspendedOperation.missing` reports identities required by the next effect. Reconnect obtains a new snapshot and non-replayed event stream.

`message_end` remains stream completion before durable settlement. An atomic settlement publishes `entry_added` for its entry after commit and then usage/operation events in logical mutation order. Internal structural provider streams emit no public assistant message lifecycle. Events and hooks may contain sensitive content; telemetry may not.

## 7. Decisions from the design session

This section records decisions made while developing the redesign. A later session must not silently reopen them without a concrete contradiction or failing trace.

### 7.1 Total state records, not shallow or delta state

The latest `OperationStateRecord` is complete mutable operational state. Loading an operation reads its immutable `OperationRecord` and exactly one latest state record. Do not split active generation, tool, queue, or deferred state into separate latest-value logs that must be collected and reconciled. Do not use patches or replay delta chains.

Total state records may consume more storage. Correctness and direct recovery take priority. Measure before optimizing. Permitted future optimizations are physical compression, backend-internal structural sharing, or compact field encoding that still decodes one state record into the complete state. Tool batches are the likely worst case because every call state repeats after transitions.

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

`resume()` checks only identities required by the next effect. Missing identities return `MissingIdentities`, perform no effect, and leave the existing operation open at the same total state record.

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

`nextRun` exists independently of an operation. `LaneStateRecord` is its total latest-value durable state and also names the current operation ID. Run acceptance atomically removes captured items, appends their entries, opens the operation, and writes its first total operation state record. Neither next-run state nor operation capture is reconstructed from queue history plus entry absence.

### 7.13 Commit-event ordering

Strict global `seq` ordering for durable commit events is not yet accepted. Storage resolves append promises in commit order, so a central publication queue could order durable events with little buffering if state installation performs no `await`. However, it may introduce cross-lane head-of-line coupling or require delayed/reordered delivery. Keep process-local lifecycle events in process order. Validate the implementation consequences before strengthening durable-event ordering.

## 8. Unresolved questions and retained audit findings

This section preserves the full audit result and its current disposition so a later session can continue without rerunning the entire conversation. Findings marked **addressed by redesign** still require tests and must not be assumed correct merely because the state shape permits a solution.

### 8.1 Runtime and recovery findings

#### Inbox omitted from the first redesign draft — addressed

The first draft mentioned pending input but did not define lane-level next-run state, operation-owned inbox state, acceptance, cancellation, capture, application, abort clearing, or race behavior. Sections 2 and 4 now define total lane state, complete run inbox payloads, disposition records used only for exact historical lookup, and atomic transition rules.

#### Structural states referenced but undefined — addressed

The first draft named manual compaction, navigation, and summary-generation states without defining them. Section 3 now defines their state and section 4 defines decision, generation, completion, failure, decline, and cancellation transitions.

#### Acceptance and finish boundaries omitted — addressed

The first draft did not model initial prompt/next-run/hook entry commit or `before_run_end` and finish races. Section 4 now defines both atomic boundaries and their lane-mutation ordering.

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

#### Storage efficiency of total state records — measure

Total state records can repeat large queue payloads and tool batches. Do not weaken semantics preemptively. Add size benchmarks for long runs, large tool batches, and repeated queued writes. If needed, optimize physical backend representation while keeping `getCurrentOperation()` equivalent to one `OperationRecord` plus one total `OperationStateRecord`.

### 8.4 Public API and identity follow-ups

#### Missing model/provider replacement escape hatch — unresolved and important

Idle lane configuration can be repaired with `setModel(validModel)`. An open operation may have captured the missing reference in its total state record; changing only lane configuration must not silently alter already-started generation under the prior contract. Possible APIs include an explicit operation-state repair method or runtime model-reference override registry. The API must be explicit, durable where necessary, and limited to missing identities rather than general in-flight mutation.

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

Prototype the total-state-record model against these traces before replacing the canonical design:

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

For every external effect, test crash before intent, after intent, and after atomic settlement. For every public race, test both lane-mutation orders. Compare automatic and manual drive durable state records and outcomes.
