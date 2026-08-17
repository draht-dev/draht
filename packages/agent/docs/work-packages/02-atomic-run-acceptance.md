# WP02 — Atomic acceptance and coherent attachment

## Status

Implementation-ready; Phase A complete and awaiting user approval. `harness.md` is normative and contains the reviewed attachment, status, snapshot, context, and manual-progress contract. Runtime implementation has not started.

This handoff expects a clean implementation baseline: all discarded pre-handoff WP02 source and test changes have been explicitly removed. If a future session finds that implementation still present, stop before Phase A and restore these exact tracked paths to `HEAD`:

- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/runtime2/types.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`

Delete the untracked `packages/agent/test/harness/runtime2/accept.test.ts`. Leave `packages/agent/docs/harness.md` and this handoff in place. Use only explicit per-path operations permitted by repository git-safety rules. Do not preserve, patch forward, or mine the discarded implementation.

## Goal

Deliver one effect-free lifecycle boundary:

```text
idle lane
→ atomic prompt/skill/template acceptance
→ durable open operation
→ close or process loss
→ coherent attachment
→ immediately complete, gap-free watch snapshot
```

After `AgentHarness.create(options, context)` succeeds:

- every configured lane has one coherent process-local projection;
- every open operation is reported as `resumable`, `blocked`, or `aborting`;
- `inspectExecution(context)` and the first `watch(context)` read owned memory only;
- the first watch snapshot can render committed transcript, queues, pending writes, unfinished assistant output, running-tool checkpoints, retry/deferred state, manual action, control, leaf, and last result without replaying old lifecycle events;
- attachment starts no hook, provider, tool, timer, breakpoint, drive owner, or application callback;
- future drive passes still reread and fence durable state and never use attachment display hydration as transition authority.

WP02 also implements atomic prompt/skill/template acceptance into payload-free `starting`. It does not implement `drive()`, provider generation, hooks, tool effects, retries, deferred polling, cancellation procedures, or manual action execution.

## Decision trace

### 1. The old suspension type mixed unrelated concepts

Problem:

```ts
reason: "crash" | "deferred" | "missing_identities"
```

`crash` described how process ownership disappeared. `deferred` described durable provider state. `missing_identities` described a current process registry blocker. The `crash` branch could also contain `deferred` and `missing`, so application code could not make an exhaustive decision from `reason`.

Concrete trace:

```text
run is deferred
→ process closes
→ reopen reports reason:"crash" with optional deferred
→ application must inspect both reason and optional fields
```

Decision: delete `SuspendedOperation`. Report open operations with one process-relative status that directly controls application behavior:

- `resumable`: no process owner, and the next real drive can make durable progress;
- `blocked`: no process owner, and the immediate next durable transition requires a currently missing model/tool identity;
- `aborting`: durable `cancel_requested`; cancellation reconciliation is next;
- `running`: a process-local drive owner exists; used by live inspection, never returned by attachment.

Idle is `current: null` and is not an open-operation status.

### 2. Attachment and drive have different authority

Problem: treating attachment hydration as transition authority creates stale parallel state. Treating attachment as projection-only produces incomplete public inspection and forces an artificial classification drive.

Decision:

- attachment fully reconstructs and validates the exact state-directed data required by `open`, `inspectExecution(context)`, and an immediate `watch(context)` snapshot;
- owned memory is authoritative for process-local inspection and event publication;
- every future drive pass independently enters the lane mutation line, rereads current durable ownership/control/phase, fences the expected operation id, dereferences its own transition inputs, checks current identities, commits intent before effects, and rereads before settlement;
- attachment data is never passed into a durable transition.

### 3. The first watch must be complete before resume

Required application order:

```ts
const { harness, open } = await AgentHarness.create(options, context);
const watch = await harness.watch(context);
render(watch.snapshot);
watch.start((event, eventContext) => renderEvent(event, eventContext));
// Only now may the application call resume(context) or manual progression methods.
```

Problem: if watch lazily reads durable partials after resume starts, snapshot and events can race. If it omits pre-attachment partials, the UI cannot render interrupted provider/tool work.

Decision: `create(options, context)` performs the bounded hydration. `watch(context)` atomically captures owned memory and begins buffering before it returns. It performs no storage read. The initial snapshot contains durable partial fallback; live process partials replace it after a future drive owns work. Old message/tool lifecycle events are never replayed.

### 4. Missing identities are phase-aware and advisory

Problem: comparing every lane-configured identity against registries at attachment can label identity-free orphan recovery or cancellation as blocked.

Decision: one pure phase classifier derives the identity requirement of the immediate next durable transition. `blocked` means:

> Calling `resume(context)` now cannot commit any durable progress because that next transition requires a missing current-process identity.

Inspection computes this advisory status from owned durable phase plus current in-process registries. A future drive recomputes it at the actual transition boundary. Registry replacement can change `blocked` to `resumable` without a durable write or automatic start.

### 5. Malformed required attachment state faults attachment

Problem: returning a harness whose first watch later discovers a missing required queue/deferred/tool reference violates the coherent-memory invariant.

Decision:

- missing/mismatched required projection or public-snapshot references reject `create()` with one `HarnessFault`;
- no partially attached harness is returned;
- absence of optional assistant frame lists and optional tool checkpoints is valid and merely omits the partial field;
- drive-only references not represented in attachment inspection remain consumption-time validations.

### 6. Normal users do not manage operation ids

Low-level `drive({ operationId })` and `requestAbort(operationId)` retain expected-id fencing so a stale hosted wake for operation A cannot act on later operation B.

Normal applications use `prompt()`, `skill()`, `compact()`, `navigateTree()`, `resume()`, and `abort()` without ids and pass the trailing invocation `Context` required by the current API. After attachment, the application calls `resume(context)` on a lane reported `resumable` or `aborting`; it repairs registries before resuming a `blocked` lane.

### 7. Manual mode returns progress instead of parking public promises

Problem: a manual-mode convenience promise that remains unresolved behind a breakpoint requires polling, a waiter API, or a second controller object.

Decision: add `action_required` to the existing operation outcome families. In manual mode:

- `resume(context)` and operation convenience calls return at the first parked breakpoint;
- `executeAction(context)` releases exactly one parked action and returns the next `ResumeResult` action or non-action outcome;
- `runToCompletion(context)` repeatedly releases actions and cannot return `action_required`;
- `peekAction(context)` remains immediate nonblocking inspection;
- automatic mode never returns `action_required`.

WP02 lands these public types and stubs. The first real drive package implements their behavior.

### 8. Invocation context carries telemetry parentage and RPC request cancellation

Problem: one harness or lane can serve concurrent local callers and RPC requests. A receiver-level or ambient context would let one invocation overwrite another's telemetry parent or cancellation authority. RPC specifically needs an explicit channel for the server-side abort signal belonging to one request without adding transport fields to every business method.

Concrete telemetry trace:

```text
client invocation Context
→ rpc.client injects a trace carrier
→ rpc.server extracts a local telemetry parent
→ adapter derives a fresh server Context with withTelemetryContext(...)
→ harness call, Session commit, and emitted events preserve that lineage
```

Concrete RPC-abort trace:

```text
server allocates one request AbortController
→ adapter derives the server Context with withAbortSignal(...) before invocation
→ harness begins with that Context
→ client context.abortSignal aborts and client sends cancel(request ID)
→ server aborts the matching request AbortController
→ the invocation's existing context.abortSignal fires
```

A connection disconnect aborts every active request controller and subscription owned by that connection. A pre-aborted client request is rejected by the adapter before server work starts.

Decision:

- every current public harness/lane operation receives one explicit trailing `context: Context`;
- `context.telemetryContext` supplies the invocation parent for harness/session spans, and derived child contexts preserve parentage across concurrent asynchronous branches without ambient state;
- the current baseline has removed `AgentHarnessOptions.telemetryContext`: a receiver-level parent cannot represent concurrent callers, and runtime configuration must not grow a replacement fallback;
- `context.abortSignal` is the explicit process-local invocation-cancellation channel used by local callers and reconstructed by RPC adapters from per-request cancel/disconnect control; it never implies durable `cancel_requested` and must not call `requestAbort()` implicitly;
- each RPC request has an independent server `AbortController`; canceling one request or drive joiner must not abort unrelated callers or shared execution owned under a different policy;
- shared harness, lane, Session, and SessionTree receivers never retain a caller context;
- acceptance passes its invocation context to Session reads/mutation/commit, faults, and emitted events; buffered events retain `{ event, context }` so delayed local handlers and future RPC event frames preserve the source telemetry lineage;
- RPC adapters remove Context from serialized business arguments, carry required trace/cancellation data as control-plane metadata, and reconstruct a fresh local Context at the receiving boundary; the Context object, `AbortSignal`, and `TelemetryContext` are never serialized as business arguments or stored durably;
- whether specific adapter-managed typed values may cross as control-plane metadata remains an open RPC design decision;
- WP02 documents and preserves that boundary but does not implement generic RPC transport, carrier encoding, distributed cancellation, or new telemetry spans; required trailing Context position is already the resolved receiver contract.

### 9. Rejected alternatives

Do not implement:

- `resumeManual()` or wrong-mode throws;
- a separate execution/controller object;
- polling `peekAction()`;
- `waitForAction()` ceremony;
- `reason: "ready"`;
- redundant `status: "suspended"` inside a suspended descriptor;
- `crash` as a user-action classification;
- attach-time broad history/value scans;
- attachment data as drive transition input;
- compatibility aliases for `SuspendedOperation` or the old convenience result shapes.

## End-state public contract

Phase A must first place these normative shapes in `harness.md`. Phase B then updates source types.

### Operation status and attachment result

```ts
export type OperationStatus = "running" | "resumable" | "blocked" | "aborting";

export type OpenOperation = {
  lane: string;
  operationId: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
} & (
  | { status: "resumable" | "aborting"; missing?: never }
  | { status: "blocked"; missing: MissingIdentityInfo }
);

export type CurrentOperationInfo = {
  id: string;
  kind: "run" | "compaction" | "navigation";
  startedAt: number;
} & (
  | { status: "running" | "resumable" | "aborting"; missing?: never }
  | { status: "blocked"; missing: MissingIdentityInfo }
);

export interface LaneInfo {
  name: string;
  leafId: string | null;
  operation: CurrentOperationInfo | null;
}

export interface SessionSnapshot {
  lanes: LaneInfo[];
  faulted: boolean;
}

export interface AgentHarnessConstructor {
  create<TContext extends object | undefined = object | undefined>(
    options: AgentHarnessOptions<TContext>,
    context: Context,
  ): Promise<{ harness: AgentHarness<TContext>; open: OpenOperation[] }>;
}
```

Rules:

- `open` contains exactly one item per lane with a durable current operation;
- idle lanes are omitted;
- attachment never returns `running`;
- `missing` is present exactly when status is `blocked`;
- `open` is an observation and may become stale after return;
- `inspectExecution(context)` and snapshots derive current status again from owned state and current registries.

### Phase-aware identity requirement

Add one exhaustive classifier over `Operation` plus the current time, defined for the behavior of normal `resume()` (which always owns one deferred-poll permit):

```ts
export type IdentityRequirement =
  | { kind: "model"; provider: string; modelId: string }
  | { kind: "tools"; names: string[] }
  | null;

export function nextResumeIdentityRequirement(
  operation: Operation,
  now: number,
): IdentityRequirement;
```

The classifier is pure for fixed arguments. Low-level drive options do not alter attachment status; hosted `drive()` performs its own options-aware preflight.

Minimum classification table:

| Current durable state | Immediate requirement |
|---|---|
| `control.cancel_requested` | none; status is `aborting` |
| run `starting` | none |
| checkpoint with steer/follow-up/writes to apply | none |
| checkpoint `need_assistant` after inbox is empty | current lane model |
| checkpoint `may_finish` after inbox is empty | none |
| assistant/summary generation `ready` | captured model |
| retry wait with `notBefore > now` | none; `resume()` may own the timer and status remains `resumable` |
| retry wait with `notBefore <= now` | captured model |
| unowned assistant/summary `effect_pending` | none; unknown-effect recovery is first |
| deferred suspended or deferred `effect_pending` | captured model; `resume()` owns one poll/replacement-fetch permit |
| planned tool batch before any call starts | captured active tools |
| safe tool replay immediately requiring one tool | that captured tool |
| unsafe orphan synthesis, outcome materialization, failure drain | none |
| structural deciding and navigation ready-to-commit | none |

The implementation must exhaust every current `OperationState` variant. Do not infer requirements from the lane's full active-tool list when the next transition uses a captured batch subset or no identity.

### Manual progress outcomes

```ts
export interface ActionRequired {
  kind: "action_required";
  action: ActionInfo;
}

export type RunOutcome = ExistingRunOutcome | ActionRequired;
export type CompactionOutcome = ExistingCompactionOutcome | ActionRequired;
export type NavigationOutcome = ExistingNavigationOutcome | ActionRequired;

export type RunOperationOutcome = { operation: "run"; runId: string } & RunOutcome;
export type CompactionOperationOutcome = {
  operation: "compaction";
  runId: string;
} & CompactionOutcome;
export type NavigationOperationOutcome = {
  operation: "navigation";
  runId: string;
} & NavigationOutcome;

export type ResumeOutcome =
  | RunOperationOutcome
  | CompactionOperationOutcome
  | NavigationOperationOutcome;

export type SettledResumeOutcome = Exclude<ResumeOutcome, { kind: "action_required" }>;

export type RunResult = Result<RunOperationOutcome, ExistingRunAdmissionErrors>;
export type CompactionResult = Result<CompactionOperationOutcome, ExistingCompactionAdmissionErrors>;
export type NavigationResult = Result<NavigationOperationOutcome, ExistingNavigationAdmissionErrors>;
export type ResumeResult = Result<ResumeOutcome, NothingToResume | Closed>;

export type DriveOutcome =
  | ExistingDriveOutcome
  | { kind: "action_required"; operationId: string; action: ActionInfo };
```

Post-acceptance missing identities use the existing suspended/waiting outcome branch, not both that branch and `Err(MissingIdentities)`. `MissingIdentities` remains an acceptance error.

```ts
interface AgentLane {
  resume(context: Context): Promise<ResumeResult>;
  executeAction(context: Context): Promise<ResumeResult>;
  runToCompletion(
    context: Context,
  ): Promise<Result<SettledResumeOutcome, NothingToResume | Closed>>;
  peekAction(context: Context): Promise<ActionInfo | undefined>;
}
```

WP02 changes types and keeps these execution methods as `SliceNotImplemented`. The first drive package implements the behavior and updates convenience tests.

### Complete lane snapshot

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
    missing?: MissingIdentityInfo;
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

Snapshot rules:

- `transcript` contains committed entries only;
- `lastResult` is the latest hydrated terminal result and is never a recovery input;
- `streamingMessage` is a display projection, not a committed transcript entry;
- `runningTools[].partialResult` is a display projection from live state or durable checkpoint;
- live partials take precedence over attachment fallback;
- outcome-ready/materialized tools are not reported as running;
- `action` exists only while a live manual breakpoint is parked;
- `retry`, `deferred`, and `drained` are descriptive details, not scheduling instructions;
- attachment and watch replay no pre-attachment lifecycle events.

## End-state attachment hydration

Attachment hydrates each lane into owned immutable process-local memory under the `Context` supplied to `AgentHarness.create(options, context)`. Projection restore, public-state hydration, and any missing-main-config seed commit pass that same context to every Session operation. Reads are exact or bounded by current state. WP02 adds no attachment-specific cancellation semantics beyond the behavior already provided by Session operations receiving `context.abortSignal`; `nextResumeIdentityRequirement(operation, now)` remains context-free and pure.

### Required reads — missing/mismatched faults `create()`

| Data | Read |
|---|---|
| lane projection | `laneLeaf`, `laneConfig`, `laneState`, optional `laneLastResult` |
| open operation projection | `operationMeta`, `operationState` |
| transcript | one compaction-bounded branch scan from current leaf |
| pending queues | every `pendingEntry(id)` named by `pendingNextRun` and run inbox steer/follow-up |
| pending writes | every `pendingEntry(id)` named by run inbox writes |
| abort drain | every `pendingEntry(id)` named by drained steer/follow-up |
| deferred display | exact deferred source message carrying its handle |
| running tool display | batch assistant entry and exact persisted arguments for each `effect_pending` call represented in `runningTools`; planned calls have not started, and outcome-ready/completed calls are not running |

Required message positions must contain messages of the required role/state. Required pending values must have the expected pending kind. Duplicate/missing lineage and impossible typed relationships fault attachment.

### Optional reads — absence omits display fallback

| Data | Read |
|---|---|
| interrupted assistant partial | bounded pages from exact `pendingAssistantFrames(operationId, responseEntryId)` |
| running tool checkpoint | exact `pendingToolOutput(operationId, invocationId)` |

A storage read failure still faults. A valid empty frame list or absent checkpoint is not corruption.

### Not hydrated for public inspection

Do not read preparation values, invocation memos, staged outcomes, or other drive-only references unless a snapshot field introduced by the normative spec directly represents them. Their consuming procedure validates them during drive.

### Startup complexity

Per lane:

- fixed projection point reads;
- one compaction-bounded transcript scan;
- O(ids named by the current lane/operation) exact value/entry reads;
- bounded assistant frame pages and exact optional checkpoints;
- no history-wide value scans, usage ledger reads, provider context construction, effects, hooks, tools, timers, or callbacks.

## Phase A — Amend `harness.md` before code

This phase is mandatory and has its own review stop. Do not edit runtime source until it passes review.

### Part 0, terminology, and invocation context

- Replace `SuspendedOperation` glossary/provenance entries with `OperationStatus` and `OpenOperation`.
- Define `running`, `resumable`, `blocked`, `aborting`, and idle once.
- State that status is process-relative observation, while durable operation phase/control remains recovery truth.
- Remove language equating every unowned operation with `status: "suspended"`.
- Motivate explicit Context with the two accepted requirements: correct telemetry parentage for concurrent asynchronous work, and carriage of the invocation `AbortSignal` that an RPC adapter reconstructs from one request's cancel/disconnect control.
- Document the existing source contract: every public harness/lane operation takes a trailing `context: Context`; hooks and event listeners receive the invocation context as their final argument; Session reads/writes receive that context.
- State that shared harness/lane/Session/SessionTree receivers retain no caller context. Context is invocation-scoped authority and propagation, not durable operation data: acceptance must not persist a `Context` or add it to the write set.
- Specify the RPC boundary principle: the client maps `context.abortSignal` to `cancel(requestId)`; the server owns one `AbortController` per request, aborts it on matching cancellation or connection loss, and uses `withAbortSignal` plus extracted telemetry to construct a fresh local Context. The adapter strips/inserts Context outside serialized business arguments and never serializes the Context object, `AbortSignal`, or `TelemetryContext` as business arguments. Whether specific adapter-managed typed values cross as control-plane metadata remains open in `rpc.md`.
- Require pre-aborted RPC calls to start no server work, while leaving that rejection in the adapter rather than the core harness.
- Distinguish `context.abortSignal` from durable abort: invocation or RPC cancellation must not call `requestAbort()` or write `cancel_requested`; one canceled request/joiner must not cancel unrelated callers.
- Document that the baseline has removed `AgentHarnessOptions.telemetryContext`. The explicit invocation Context is the sole telemetry parent because a harness-level default cannot represent concurrent callers; do not add a replacement receiver-level fallback to runtime configuration.
- Align §5.2 and §5.7 tool/assistant execution signatures with the baseline's context-threaded capabilities: no standalone signal or telemetry-parent parameters where Context now carries them, and invocation callbacks receive trailing Context.
- Keep required trailing parameter position and propagation behavior aligned with current source for WP02. Generic RPC transport, optional-argument normalization, carrier encoding, and cancellation remain separate work in non-normative `rpc.md`; context position is no longer open.

### §3.3 — Restore validation

Replace the blanket "nothing else" language with two explicit attachment layers:

1. projection restore: exact lane/operation point values;
2. public-state hydration: bounded state-directed reads required for coherent `open`, inspection, and initial watch.

Amend the trusted-values doctrine explicitly: attachment does not schema-validate trusted stored objects, but it does validate existence, address/kind discriminants, and entry type/role relationships required to construct public state. Specify required-reference fault behavior and legal optional absence. Preserve consumption-time validation for drive-only references.

### §3.6 — Acceptance

Retain the atomic run acceptance algorithm and exact transaction. Replace references to caller entries with request prompt entries. State that accepted-undriven `starting` is `resumable`: its immediate `before_run` consumption and checkpoint commit are identity-free durable progress.

### §3.11 and §4.6 — Queues and abort

- Remove `SuspendedOperation.aborting`.
- Put drained payloads in `LaneSnapshot.operation.drained` and `AbortResult`.
- Require attachment hydration of every queued, pending-write, and abort-drained `pendingEntry(id)` represented by the snapshot.

### §4.1 — Ownership and manual progress

- Replace suspended-owner language with four-way `OperationStatus`.
- Add the rule that a manual breakpoint returns `action_required` instead of leaving the public drive/convenience promise unresolved.
- Same-operation callers observing a parked pass return the same current action without releasing it.
- Automatic mode crosses barriers and never returns `action_required`.

### §4.4 — Attachment and missing identities

Rewrite attachment as:

```text
inventory
→ projection restore
→ bounded public-state hydration and validation
→ phase-aware status classification
→ publish complete harness + open[]
```

Enumerate exact required and optional reads from the End-state attachment hydration section above. Fix the stale "five point lookups" count to include optional `laneLastResult` without calling it a recovery input. Remove `reason: "crash"` reconstruction.

Add the exhaustive identity requirement table and state that attachment classification is advisory while drive preflight is authoritative.

### §4.5 — Drive and recovery

- Keep expected-id fencing and durable rereads.
- State that `resume(context)` inspects and drives the current operation without exposing ids.
- Remove `MissingIdentities` from `ResumeResult` errors; use the existing suspended/waiting outcome.
- Preserve one deferred poll permit for `resume(context)`.
- Add `action_required` pass behavior, while leaving implementation to the next package.

### §5.1 — Public result surface

Apply the exact operation-outcome and action-required types above. Ensure convenience operation results are branches of `ResumeOutcome`, so manual progression moves from `prompt()`/`compact()` to `executeAction()` without conversion helpers. Add trailing `context: Context` to every normative method signature, and align the lane tree view with the current `readonly sessionTree: SessionTree` property rather than the stale `readonly session` name.

### §5.2 — Harness creation

- Specify `AgentHarness.create(options, context)` with trailing `context: Context` and require projection reads, hydration reads, and any initial configuration seed commit to receive it.
- Change `{ harness, suspended }` to `{ harness, open }`.
- Delete `SuspendedOperation`.
- Add `OpenOperation` and the status rules.
- State that `open` is an attachment observation, not a scheduler reservation.

### §5.4 — Snapshots and watches

- Apply the complete snapshot shape above.
- Require `watch(context)` to capture owned memory and start buffering atomically, with no storage read.
- Specify one lane-local observation gate ordering state publication plus synchronous event-batch enqueue against watcher registration plus synchronous memory capture. Event-bus enqueue binds each event's invocation context together with its recipient set immediately rather than consulting later listeners at delivery time. Therefore a watcher is either registered before publication and receives the `(event, context)` batch after an old snapshot, or registers after publication/enqueue and receives a new snapshot without that old batch.
- Explain why the pair is required: local event handlers derive telemetry from the emitting invocation, while an RPC subscription injects that same source lineage into each event frame and reconstructs a fresh client-side delivery context. Subscription-establishment context must not replace event-source context.
- Specify transcript, last-result, partial-message, checkpoint, queue, drained, retry, deferred, action, and live-over-durable precedence.
- Remove restored crash descriptors and lifecycle replay implications.

### Part 8 roadmap

- Mark WP02 in progress and rename its outcome to atomic acceptance plus coherent attachment/watch.
- Move real `action_required`, `executeAction`, `runToCompletion`, and convenience-drive behavior into the first no-tool drive package.
- Keep provider generation, retry ownership, deferred polling, tools, cancellation procedures, and full session watch in their owning packages.

### Part 9 invariants and races

Amend or add:

- projection restore versus public-state hydration versus drive consumption;
- successful attachment publishes no incomplete lane;
- required attachment reference corruption faults once; optional frame/checkpoint absence is valid;
- `blocked` is phase-aware and never prevents identity-free progress;
- `open`/snapshot status is advisory and drive rereads durable state;
- initial watch snapshot plus buffered events has no gap;
- no pre-attachment lifecycle replay;
- automatic mode never returns `action_required`;
- no public execution promise remains parked invisibly behind a manual barrier;
- expected-id primitive fencing remains unchanged;
- shared receivers never retain invocation Context, and concurrent calls preserve independent telemetry/cancellation lineage;
- Context and its values are neither durable data nor serialized business arguments;
- buffered events retain `{ event, context }`, not only event payloads;
- RPC cancellation/disconnect reaches the matching invocation through `context.abortSignal`, does not become durable cancellation, and does not cancel unrelated request contexts;
- attachment/resume, registration/resume, close/attach, snapshot/resume, and external-finalization races.

### Phase A review stop

After editing only `harness.md` and this handoff:

1. Run a Terra librarian contradiction audit.
2. Run a Fable work-product review.
3. Resolve every finding.
4. Re-read all changed normative sections together.
5. Do not begin Phase B until the user approves the normative diff.

## Phase B — Implementation

### Public types

Modify `packages/agent/src/harness/agent-harness.ts`:

- remove `SuspendedOperation` and exports;
- add `OperationStatus`, `OpenOperation`, `IdentityRequirement`, and `ActionRequired`;
- change `CurrentOperationInfo`, `LaneInfo`, `LaneSnapshot`, and `SessionSnapshot`;
- change `AgentHarness.create(options, context)` result to `open`;
- make convenience operation values operation-tagged branches of `ResumeOutcome`;
- remove post-acceptance `MissingIdentities` from `ResumeResult` errors;
- add `DriveOutcome.action_required`;
- change `executeAction(context)` and `runToCompletion(context)` result signatures;
- preserve every existing trailing `context: Context` parameter, including expected-id primitives, and do not persist `Context`;
- keep `AgentHarnessOptions.telemetryContext` absent and do not add a receiver-level replacement.

Update public type tests before runtime code.

### Runtime source layout

Add focused modules rather than growing `lane.ts` into a generic reducer:

- `packages/agent/src/harness/runtime2/classify.ts`
  - exhaustive `nextResumeIdentityRequirement(operation, now)`;
  - status derivation from operation, local owner presence, and current registries.
- `packages/agent/src/harness/runtime2/hydrate.ts`
  - bounded attachment reads under the `create(options, context)` context;
  - required-reference validation;
  - immutable presentation snapshot construction;
  - optional frame/checkpoint fallback.
- `packages/agent/src/harness/runtime2/accept.ts` only if extracting the run acceptance planner materially clarifies `Lane`; do not introduce a future operation context.

Modify:

- `runtime2/types.ts` to hold the complete owned hydrated lane projection without a receiver-level telemetry field;
- `runtime2/restore.ts` to keep projection restoration direct and separate from public hydration;
- `runtime2/harness.ts` to hydrate all lanes before constructing/publishing the harness and return `open` without reintroducing receiver-level telemetry;
- `runtime2/lane.ts` to implement acceptance, memory-only inspection, and memory-only `watch(context)`;
- `runtime2/index.ts` exports only as needed.

### Atomic run acceptance

Implement atomic acceptance under the approved Phase A contract.

`accept(request, context)` performs state-independent normalization of the `OperationRequest` before `Lane.command(plan, context)`:

- prompt strings/images;
- supplied message or message array;
- explicit skill formatting;
- prompt-template formatting;
- pending assistant rejection;
- unknown skill/template errors;
- supplied or minted operation id and request prompt entry ids.

Keep the public prompt overloads exactly `[text, images | undefined, context]` and `[messageOrMessages, context]`, but leave both convenience implementations as `SliceNotImplemented`; WP02 must not turn `prompt()` into acceptance-only behavior.

The accepting context is process-local call authority, not durable operation data. Pass it through `Lane.command(plan, context)`, `session.mutate(lane, callback, context)`, every Session read/commit, and fault handling as `onFault(cause, context)`. Do not add it to operation metadata or any write.

Inside that one lane command:

1. reject busy;
2. capture all current `pendingNextRun` ids;
3. phase-independent admission identity preflight against the captured config/registries;
4. read and validate captured pending messages;
5. reject zero placed messages;
6. parent captured next-run entries before request prompt entries;
7. commit exactly once;
8. publish owned hydrated state from `CommitResult`.

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

Post-commit events carry the exact accepting invocation context through `onEvent(event, context)` while the bus remains open:

```text
run_start
for each placed message:
  message_start
  message_end
  entry_added
queue_update if nextRun was captured
accept resolves
```

Acceptance updates the owned transcript, leaf, operation projection, queues, and snapshot fields in the same publication. It starts no drive or effect.

### Memory-only inspection and watch

`inspectExecution(context)` derives current status from owned operation/control, current local owner state, the pure identity classifier, and current registries. It performs no storage read.

`watch(context)` uses the Phase A observation protocol, not the current asynchronous `HarnessEventBus.watchFromSnapshot()` ordering by itself. One lane-local observation gate serializes synchronous owned-state publication plus event-batch enqueue against synchronous watcher registration plus memory capture. Event enqueue snapshots each event's invocation context together with recipients immediately; `WatchHandle.start(listener)` later delivers `(event, context)`. Event handlers still run later and outside lane/storage mutation lines. Since capture is memory-only, watch returns a coherent clone without a gap or duplicate. Event payload mutation cannot alter owned state.

The main harness inherits lane `watch(context)`. `watchSession(context)` may remain later work, but all public session-snapshot type changes land now.

### Out-of-scope execution methods

`drive`, `resume`, `prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`, abort/queues, `executeAction`, and `runToCompletion` keep throwing `SliceNotImplemented` where WP02 does not already implement their non-executing primitive. Their updated signatures compile against future behavior.

Do not add `ActiveOperation`, effect gates, breakpoint execution, hooks, providers, tools, retry timers, deferred polls, terminal settlement, or usage.

## Required tests

All runtime2 tests use `BACKGROUND_CONTEXT` by default and pass it explicitly to public harness/lane and Session calls. Public type tests cover hook/listener context signatures. Runtime context-propagation cases use a distinct derived `Context` and assert object-identical delivery to acceptance event and fault boundaries without durable serialization.

### Public type contract

- `SuspendedOperation` is absent.
- `OpenOperation` and status unions narrow exhaustively.
- convenience operation values are assignable to `ResumeOutcome`.
- `action_required` narrows across run/compaction/navigation and drive outcomes.
- `executeAction(context)`/`runToCompletion(context)` signatures match the normative contract.
- prompt overloads have the exact trailing-Context tuple shapes; `Context` is not assignable to the images or message positions.
- `AgentHarnessOptions` has no `telemetryContext` key.

### Atomic acceptance

Implement coverage for:

- text-only, images-only, text-plus-images, supplied message arrays;
- pending assistant rejection;
- skill with/without instructions and prompt-template arguments;
- unknown resources and empty input write nothing;
- supplied/minted operation ids;
- exact transaction, parent chain, metadata, payload-free `starting`, settings snapshot, `CommitResult` materialization;
- pending-next-run capture and deletion;
- missing model/tools, busy structural/run operations;
- one concurrent accept winner;
- commit publication/failure and close races;
- exact post-commit events carrying the accepting `Context`;
- no callback/effect invocation.

### Attachment statuses

Construct every durable phase directly and assert:

- idle omitted from `open`;
- starting and identity-free phases are resumable;
- model boundary with missing model is blocked;
- planned captured tool boundary with missing tool is blocked in captured order;
- unowned effect-pending recovery is resumable despite missing identities;
- safe replay requiring a missing tool is blocked;
- unsafe recovery/outcome materialization is resumable;
- deferred poll boundary is blocked only when its required model is missing;
- cancel requested is aborting and never blocked;
- replacing registries changes later inspection blocked/resumable without a durable write;
- attachment never reports running.

### Required hydration and corruption

For each required reference category:

- valid data appears in owned memory and first snapshot;
- missing value, wrong pending kind, wrong entry type/role, or impossible relationship rejects create with one `HarnessFault`;
- no partial harness is returned;
- attachment commits nothing for an already configured session;
- no hook/provider/tool/timer/application callback runs.

### Optional partial recovery

- empty/missing assistant frame list omits streaming fallback;
- one and many frame pages reduce in sequence order;
- frame read failure faults attachment;
- absent tool checkpoint omits partial result;
- present checkpoint populates the represented running tool;
- live partial later overrides durable fallback without changing transcript.

### Watch snapshots and races

- first snapshot includes complete transcript, queues, pending writes, drained payloads, retry/deferred details, streaming message, running tools, leaf/result/control/status;
- unfinished assistant/tool partials are not committed transcript entries;
- pre-attachment message/tool lifecycle events are not replayed;
- watcher registered before concurrent acceptance publication receives either snapshot-before-plus-events or snapshot-after without a gap/duplicate;
- a watcher started after emission receives each buffered event with the object-identical emitting Context, never the watch/start invocation context;
- caller mutation of snapshot/event payloads does not mutate owned memory;
- watch performs no storage read;
- close/fault behavior matches event-bus lifecycle.

### Drive authority boundary

Without implementing drive, add direct classifier/hydration tests proving:

- attachment status is advisory;
- later durable ownership changes make stale `open` harmless;
- no hydrated display object is stored in a durable operation value;
- expected-id primitive types remain mandatory.

## Files

### Add

- `packages/agent/src/harness/runtime2/classify.ts`
- `packages/agent/src/harness/runtime2/hydrate.ts`
- `packages/agent/test/harness/runtime2/accept.test.ts`
- focused hydration/watch tests if `harness.test.ts` would become oversized.

### Modify

- `packages/agent/docs/harness.md` — Phase A first
- `packages/agent/docs/work-packages/02-atomic-run-acceptance.md`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/runtime2/types.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- `packages/agent/test/harness/types.test.ts`
- test utilities only where controlled/instrumented reads require them.

No backend, storage schema, telemetry schema, coding-agent, or changelog change is expected. Stop for boundary review if one becomes necessary. On `dev`, defer the changelog entry.

## Validation

After Phase A docs:

```bash
git diff --check
```

After Phase B code:

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

If subprocess tests fail only because ignored workspace `dist` artifacts are stale, obtain explicit user authorization before `npm run build`, then rerun `./test.sh`.

Report runtime2 source line counts. The synchronized clean pre-WP02 baseline is 967 lines; treat growth above 1,900 runtime2 source lines as a design review trigger, not a compression target.

## Review checkpoints

1. **Phase A:** Terra contradiction audit, then Fable normative/handoff review. Resolve all findings and obtain user approval.
2. **Phase B midpoint:** review public types, classifier table, and hydration matrix before acceptance/watch implementation.
3. **Final:** Fable implementation review after focused tests and `npm run check`; resolve findings before full validation.

Keep the same Fable subagent alive through the Phase A discussion so it retains the decision context.

## Stop condition

Stop when:

- `harness.md` contains the approved status, attachment, watch, and manual-progress contract;
- prompt/skill/template acceptance commits exactly once into payload-free `starting`;
- successful create publishes only fully hydrated coherent lane memory and accurate `open[]` statuses;
- required attachment corruption faults and optional partial absence remains legal;
- immediate watch is read-free, gap-free, and UI-complete;
- no execution effect or owner is introduced;
- focused tests, `npm run check`, and full tests pass;
- runtime2 line count and deferred changelog are reported.

Do not begin the first real drive package. `drive`, convenience execution, action progression, hooks, providers, tools, retries, deferred polling, cancellation procedures, and terminal settlement remain the next reviewed package.
