# Existing AgentHarness runtime simplification

## Scope

Rework the real implementation under `packages/agent/src/harness/runtime/` and the canonical durable types in `packages/agent/src/harness/session/types.ts`. This is not the isolated scratch spike.

Public drive remains disabled until the execution graph is total. Format 4 is still work in progress, so the durable type replacement requires no migration or compatibility representation.

## Core model

A Lane is one process-local actor over one durable lane projection.

- `Lane.state` is authoritative for tip, configuration, current operation, control, inbox IDs, and latest result.
- Every supported mutation commits through the Session mutation line and publishes the matching `Lane.state` before releasing it.
- One lane-owned Drive is the sole writer that advances an operation state.
- Same-operation callers observe the same Drive. No caller owns it.
- Invocation cancellation stops only that caller's observation after Drive installation.
- `requestAbort` is the only durable operation cancellation.
- Close seals mutation admission. It neither mutates operation state nor replaces a Drive.
- Process loss destroys all live continuations; recovery starts from the durable state after attachment.
- Session reads during execution dereference content named by `Lane.state`; they never rediscover control state.

## Durable state

`OperationState` has one discriminator, `at`, with 22 direct leaves:

- `run.starting`
- `run.checkpoint`
- `run.assistant.ready`
- `run.assistant.effect_pending`
- `run.assistant.retry_wait`
- `run.tools`
- `run.deferred.suspended`
- `run.deferred.effect_pending`
- `run.compaction.deciding`
- `run.compaction.ready`
- `run.compaction.effect_pending`
- `run.compaction.retry_wait`
- `run.failure_drain`
- `compaction.deciding`
- `compaction.ready`
- `compaction.effect_pending`
- `compaction.retry_wait`
- `navigation.ready_to_commit`
- `navigation.summary.deciding`
- `navigation.summary.ready`
- `navigation.summary.effect_pending`
- `navigation.summary.retry_wait`

Shared run, structural, and navigation data is factored with intersections. `Control` remains orthogonal. `ToolBatch` remains a child state machine because parallel tool children genuinely mutate sibling call statuses concurrently.

## State and content boundary

Procedures never read these addresses to decide execution:

- `laneState`
- `operationMeta`
- `operationState`
- `branchTip`
- `laneConfig`
- `laneLastResult`

They use the current `Lane.state` supplied by the mutation line.

Storage reads remain only for content and cleanup:

- prompt, assistant, deferred-source, final-assistant, and completed-tool entries;
- compaction-bounded branch context;
- `pendingEntry` payloads;
- assistant-frame lists;
- tool arguments, memos, and checkpoints;
- structural preparations;
- staged tool outcomes;
- operation-owned prefix scans required for terminal cleanup.

## Concurrency model

### Operation advancement

While a Drive procedure is alive, no supported concurrent actor can change or remove its operation state:

- inbox methods change only inbox fields;
- `requestAbort` changes only `control`;
- close prevents later mutation admission;
- another same-operation caller joins the existing Drive;
- another operation cannot be accepted while the lane is busy;
- process crash removes the continuation itself.

Consequently, ordinary procedure transitions do not recheck operation existence, operation ID, operation kind, `at`, attempt identity, or nested status. Those are procedure preconditions established by dispatch, not supported races.

The remaining real races are:

1. cancellation arriving before effect admission or before settlement;
2. inbox arrival before checkpoint routing or terminal finish;
3. parallel tool children staging and materializing sibling outcomes;
4. queued frame/checkpoint/memo writes racing effect settlement;
5. retry timers racing cancellation or close;
6. deferred permit consumption;
7. accept/claim serialization on the Session line.

### Cancellation boundaries

Cancellation is checked in three places only:

1. the drive loop before ordinary dispatch;
2. the gate immediately before an external effect starts;
3. effect settlement, which sees current `control` and commits the appropriate cancelled result.

An ordinary transition helper may centrally decline progress when current control is `cancel_requested`. Procedures do not repeat that branch manually.

### Close

Closing the harness:

1. marks harness/lane admission closed;
2. seals and drains the Session mutation line;
3. rejects client observations through a harness-close observation promise;
4. keeps every detached pass promise observed so a later rejection is never unhandled;
5. closes the Session after admitted mutations drain.

Close performs no durable write, installs no replacement Drive, and creates no ownership-loss state. A late effect may return, but its mutation is rejected with `HarnessClosed`.

Whether close also signals process-local provider/tool work is a resource-cleanup policy, not durable state-machine behavior. Do not couple it to Drive replacement or recovery.

## Small concrete mutation API

Replace repeated `LaneCommand` ceremony in procedures with two concrete Lane operations. They are not a scheduler, graph, or action interpreter.

### `continueOperation`

Used for ordinary non-terminal progress.

- Enters the Session mutation line.
- Receives the current authoritative Lane projection and operation state.
- If control is cancelled, returns to the drive loop without invoking the semantic planner.
- The planner supplies procedure-specific writes, the next complete `OperationState`, materialization, and events.
- The helper appends the `operationState` write and publishes the matching process-local operation projection.
- It does not verify an expected state or `at` value.

### `settleOperation`

Used after an admitted provider/tool/structural effect and for genuine parallel child transitions.

- Enters the Session mutation line even when control is cancelled.
- Supplies current control/inbox fields and the process-local effect result to the semantic settlement planner.
- Atomically commits payload, usage, tip movement, cleanup, and the classified next state.
- Appends the canonical operation-state write and publishes the matching projection.
- When the planner returns a terminal decision, appends `laneLastResult`, idle `laneState`, and the idle process-local projection.

The caller supplies the typed outcome, cleanup/publication writes, last result, and event. Terminal business decisions remain visible in the owning procedure.

## Drive lifecycle

Delete the installer-owned model.

- Remove `installerSignal`.
- Remove `DriveAbandoned`.
- Remove `LostOwnership` and `lost_ownership` from procedure results.
- Remove exact-object ABA fencing and `commandDriveOwned`.
- Remove `finalizedOutcome` and planned external-finalization owner retention unless the Flue investigation establishes a concrete requirement.
- Keep `activeDrive` only as the lane's install/join slot.
- Installation transfers work to the lane. Every caller, including the installer, observes completion with its own invocation Context.
- A caller signal abort before installation installs nothing. After installation it only rejects that caller's observation.
- The Drive is removed after its pass settles or reaches a durable wait. No live pass is replaced in-process.

`requestAbort` retains the two-part gate ordering:

```text
beginAbort before cancellation mutation
commit cancel_requested
signalAbort after commit
```

This prevents a new effect from entering while the durable marker is being committed.

## Checks that remain

Do not remove validation of external or referenced content:

- required entry existence and role;
- pending payload kind;
- deferred handle identity;
- provider stream protocol ordering;
- response stop-reason invariants;
- UUIDv7 follower timestamp parsing;
- configured model/tool availability;
- tool-call source index and staged result identity;
- parallel tool call status and ready-prefix placement;
- progress/memo invocation identity;
- retry timestamp and deferred permit arithmetic.

These validate data or genuine child concurrency. They are not defensive revalidation of the operation state machine.

## Staged implementation plan

### Stage 1 — Canonical flat durable types

Files:

- `src/harness/session/types.ts`
- compile-only consumers in `src/harness/runtime/`, restore, conformance helpers, and focused tests
- `docs/harness.md`
- `docs/work-packages/05-direct-durable-drive.md`

Actions:

- Replace nested operation state declarations with the flat `at` union.
- Preserve every durable datum without compatibility aliases.
- Update pattern matching mechanically without changing behavior.
- Keep ToolBatch/ToolCall nested.
- Update normative documentation in the same change.

Exit: `npm run check`; existing focused runtime tests pass; no `phase.kind`, generation `status`, deferred `status`, or structural decision `status` remains in canonical operation state.

### Stage 2 — Add canonical transition operations

Files:

- `src/harness/runtime/lane.ts`
- `src/harness/runtime/types.ts`
- focused Lane tests

Actions:

- Add `continueOperation` and `settleOperation`, including the terminal-decision suffix.
- Pair every durable operation-state write with process-local projection publication in one implementation.
- Centralize ordinary cancellation diversion.
- Trust the dispatcher-established current leaf; perform no expected-state check.
- Keep procedure-specific writes and event builders visible at call sites.

Exit: focused tests prove durable state and `Lane.state` remain identical after every helper commit.

### Stage 3 — Convert starting, checkpoint, and assistant

Files:

- `runtime/drive/checkpoint.ts`
- `runtime/drive/generation.ts`
- `runtime/drive/recovery.ts`
- `runtime/progress.ts`

Actions:

- Remove repeated operation/null/kind/state checks and `same*` predicates.
- Convert ordinary progress to `continueOperation`.
- Convert assistant settlement to `settleOperation`.
- Keep only checkpoint inbox/finish races and progress-channel ownership checks.
- Fold assistant recovery into the effect-pending handler if that is smaller.

Exit: no control-state storage reads; no repeated assistant state verification; focused generation tests pass.

### Stage 4 — Convert deferred and tools

Files:

- `runtime/drive/deferred.ts`
- `runtime/drive/tools.ts`
- `runtime/progress.ts`

Actions:

- Share assistant/deferred response-entry, usage, and tool-plan construction where their semantics match.
- Preserve deferred permit and handle checks.
- Remove top-level operation-state revalidation.
- Preserve per-call tool status merging, completion-order staging, source-order placement, memo fencing, and progress fencing.
- Use one tool-batch procedure for live, recovery, and cancellation modes instead of separate ownership-result paths.

Exit: tool status checks exist only for genuine sibling concurrency; focused deferred/tool/progress tests pass.

### Stage 5 — Remove ownership-loss machinery

Files:

- `runtime/types.ts`
- `runtime/lane.ts`
- `execution/effect-gate.ts`
- all existing `runtime/drive/*.ts`
- associated focused tests

Actions:

- Remove `LostOwnership`, `commandDriveOwned`, exact Drive checks, `installerSignal`, `DriveAbandoned`, and `finalizedOutcome`.
- Make all drive callers observation peers.
- Add observation-only Context cancellation to Drive completion waiting.
- Keep `activeDrive` only for install/join arbitration.
- Remove ABA/replacement tests and replace them with install/join/observation-cancellation tests.

Exit: grep finds no ownership-loss or installer-abandonment vocabulary in production runtime.

### Stage 6 — Close and fault

Files:

- `runtime/harness.ts`
- `runtime/lane.ts`
- Drive observation helper
- lifecycle tests

Actions:

- Seal mutation admission and drain admitted mutations.
- Reject client observations on close/fault without replacing a Drive or changing durable operation state.
- Observe detached pass failures.
- Verify a late effect cannot commit after close.
- Decide separately whether to signal local effects for resource cleanup.

Exit: close and process loss leave the same durable restart point; no close path writes cancellation or synthetic settlement.

### Stage 7 — Finish WP05 on the simpler substrate

Files:

- `runtime/drive/structural.ts`
- `runtime/drive/reconcile.ts`
- `runtime/drive.ts`
- `runtime/lane.ts` public surfaces

Actions:

- Implement structural generation directly over flat leaves and the transition operations.
- Implement cancellation reconciliation as one flat-state switch.
- Implement the total drive switch as one `state.at` switch.
- Wire public claim/join/observation and convenience methods only after every leaf is total.

External finalization is excluded unless the Flue investigation identifies a concrete, current caller that cannot be expressed through close, explicit abort, recovery, or offline administration.

## Validation

After every code stage:

```bash
npm run check
```

Run each modified focused test file from the package root. Do not run the full Vitest suite directly. Public drive remains disabled until the final stage.

Final audit:

```bash
rg 'lost_ownership|LostOwnership|DriveAbandoned|commandDriveOwned|installerSignal|finalizedOutcome' packages/agent/src/harness
rg 'operationState\(|laneState\(|branchTip\(|laneConfig\(' packages/agent/src/harness/runtime/drive
```

The second audit may match write constructors, but no reader call may use those control addresses.
