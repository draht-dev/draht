# WP05 — Manual-first drive

## Status

Design draft. Implementation has not started. The current `harness.md` remains normative until WP05 code and focused tests are accepted. WP05 intentionally updates `harness.md` afterward, from the proven implementation rather than a speculative design.

WP02 atomic acceptance/observation and WP03 deadline removal are complete. WP04 first simplifies mutation publication and event delivery. WP05 then adds execution without reopening those packages.

## Mental model

There are two public phases:

```text
accept(request)
→ commit one durable starting state
→ return operation id

drive(operationId)
→ run the operation procedure
→ return terminal, durable wait, or current manual breakpoint
```

`accept` never starts execution. `drive` is a thin owner/wrapper around the existing breakpoint mechanism and direct async procedures. It is not a scheduler, action interpreter, plan graph, or second state machine.

Every repeat-sensitive effect uses the same sandwich:

```text
prepare intent
→ commit intent
→ effect
→ commit outcome
```

Concrete assistant example:

```text
prepare request context/options and reserve response/usage ids
→ commit assistant.effect_pending
→ invoke and await provider
→ commit response + usage + next durable state
```

Tool, hook, timer, and structural procedures follow the same rule where they need durable intent. Recovery reads the last committed state; it does not reconstruct a process-local instruction pointer.

## Manual-first execution

Procedure code has one breakpoint call before each exposed transition/effect:

```ts
await breakpoint({ kind: "assistant.intent", description: "Commit assistant intent" });
await commitIntent();

await breakpoint({ kind: "assistant.request", description: "Request assistant response" });
const response = await requestAssistant();

await breakpoint({ kind: "assistant.outcome", description: "Commit assistant outcome" });
await commitOutcome(response);
```

The same code serves both modes:

- **automatic:** `breakpoint()` returns immediately;
- **manual:** `breakpoint()` parks the current procedure and exposes `action_required`;
- `executeAction()` releases exactly the current breakpoint and observes the next breakpoint or procedure result;
- `runToCompletion()` repeatedly releases breakpoints;
- `peekAction()` observes without releasing.

`drive()` only installs/joins one lane-local procedure and observes either its completion or its parked breakpoint. A parked procedure remains the one owner. No completion receipt, activation epoch, retry-lifecycle extension, or durable manual state is needed.

The minimal process-local shape is:

```ts
interface ActiveDrive {
  operationId: string;
  completion: Promise<DriveOutcome>;
  breakpoint: Breakpoint;
  effectGate: EffectGate;
}
```

`Lane` owns at most one `activeDrive`. Expected-id claim/join runs on the lane line:

```text
wrong current id
→ OperationMismatch

matching latest terminal id
→ hydrate and return the durable result

matching activeDrive
→ join its observation

matching durable open operation with no owner
→ install ActiveDrive
→ start its procedure only after leaving the lane line
```

`drive()` observes `activeDrive.breakpoint.peek()` or races `breakpoint.waitForChange()` with `completion`. `peek()` and waiter registration are synchronous with no intervening `await`, so no revision/epoch machinery is needed. `waitForChange()` must reject current and future waiters when the breakpoint closes; the observation loop propagates that close/fault instead of repeatedly racing an already-resolved change promise. In manual mode `drive()` returns `action_required` while the same owned completion remains parked internally. In automatic mode every breakpoint resolves immediately.

`executeAction()` releases exactly `activeDrive.breakpoint`; concurrent callers cannot release the same parked breakpoint twice. `runToCompletion()` repeats observation/release until the outcome is not `action_required`.

On ordinary settlement or failure, the drive task resolves/rejects its retained completion only after a no-write lane job removes that exact `ActiveDrive` by object identity. An old cleanup cannot remove a replacement owner. After close or fault, no lane job can be admitted: cleanup instead removes that exact process-local owner synchronously before rejecting completion. This is breakpoint plumbing, not business state.

## Source shape

Keep public ownership and business procedures separate but direct:

- `runtime2/lane.ts`: public drive/action methods, expected-id claim/join, observation, and exact-owner cleanup;
- `runtime2/drive.ts`: one ordinary async procedure dispatching from current durable phase;
- existing `execution/assistant.ts`: provider request adapter;
- existing `Breakpoint` and `EffectGate`: process-local control primitives.

The procedure should remain visibly procedural:

```ts
async function runDrive(active: ActiveDrive, context: Context): Promise<DriveOutcome> {
  await runBeforeDrive(active, context);
  while (true) {
    const current = await inspectCurrentPhase(active.operationId, context);
    switch (current.phase.kind) {
      case "starting":
        await startRun(active, current, context);
        break;
      case "checkpoint":
        await continueCheckpoint(active, current, context);
        break;
      case "assistant":
        await continueAssistant(active, current, context);
        break;
      default:
        throw new SliceNotImplemented(`drive(${current.phase.kind})`);
    }
  }
}
```

The exact helper boundaries may change during implementation, but they must not become a scheduler, instruction graph, generic action interpreter, or second source of restart authority. An unsupported durable branch rejects honestly with `SliceNotImplemented`; exact-owner cleanup still runs, so the lane is not wedged and a later implementation may drive it. Convenience prompt/skill/template methods literally call `accept()` and then `drive()` with the returned operation id.

## Recovery

Recovery is the same procedure selected from durable state when no local owner exists:

```text
ordinary state
→ continue the next sandwich

intent/effect_pending with no local owner
→ run that effect type's documented unknown-outcome recovery
→ commit recovery outcome
→ continue
```

No caller supplies `recovery:true`. Event metadata is output-only and inferred from durable state plus absent local ownership.

A process may die after intent but before the effect actually starts. Recovery still treats the effect as uncertain because durable storage cannot distinguish that point from death during the effect. That conservative boundary is the cost of the sandwich.

## Initial package boundary

WP05 should implement the smallest end-to-end run path that proves the model:

1. expected-id `drive` installation/joining and latest-result lookup;
2. shared automatic/manual breakpoint behavior;
3. `before_drive` and `before_run`;
4. `starting → checkpoint`;
5. one no-tool assistant request using intent/effect/outcome;
6. frame persistence and unknown-outcome assistant recovery;
7. no-tool terminal result and cleanup;
8. prompt/skill/template convenience as acceptance followed by drive;
9. exact events, Context propagation, and focused deterministic tests.

Retry, durable abort, real tools, deferred polling, queues, compaction, and navigation stay out unless implementation proves one is strictly required for the first sandwich to be correct. Do not pull later-package state into WP05 merely to make every future branch executable now. For an unsupported durable branch, stop honestly without fabricating an outcome or effect.

Accepted pending writes and provider tool/deferred responses need an explicit package-boundary decision before implementation. Prefer a small honest stop over speculative cross-package machinery.

## Breakpoint rules

- A breakpoint performs no business work.
- The ordinary statement immediately after it performs the named transition/effect.
- Manual and automatic modes execute byte-identical business code.
- A parked procedure starts no following hook/provider/tool/timer/commit.
- Passive event delivery is never a breakpoint.
- Breakpoint details contain ids/counts only, never prompts, responses, headers, handles, credentials, or tool content.
- Tests release one breakpoint at a time and inspect durable writes/events/state.

The first catalog should stay small:

```text
hook.before_drive
hook.before_run
run.start
assistant.intent
assistant.request
assistant.outcome
run.finish
assistant.recover
```

Add another breakpoint only when a concrete transition/effect in this package needs independent inspection.

## Event publication prerequisite

WP04 owns mutation publication and event-delivery simplification. WP05 uses its `emitBatch()` boundary and does not reopen recipient binding, watcher coherence, direct-listener awaiting, lane creation, or event/hook ordering.

## Implementation and documentation order

Before any design review, source work, or test planning:

- read **all** of `packages/agent/docs/harness.md`, from start to finish; excerpts, searches, prior conversation context, and this handoff are not substitutes;
- treat the current `harness.md`, this handoff, and the current runtime2/session/execution APIs as the only architectural sources of truth;
- implement runtime2 clean-room: do **not** inspect Git history for deleted runtime implementations and do not recover, copy, adapt, or use removed runtime1 code as a reference;
- reread the relevant current source files completely before changing them.

Then, before source work:

- agree this small source shape with the user and Fable;
- prove the process-local breakpoint observer can return an action without resolving/removing the underlying procedure;
- prove same-id drives join and stale ids start nothing;
- prove manual release advances exactly one breakpoint;
- enumerate the first no-tool request's crash positions around intent/effect/outcome;
- define the honest result for tool-call and deferred responses not implemented here;
- define whether accepted pending writes force a small checkpoint drain into this package;
- define close versus a parked procedure and admitted commit without redesigning unrelated lifecycle APIs, including process-local exact-owner removal when the lane line is sealed;
- prove every observer terminates on breakpoint close/fault without a resolved-promise busy loop;
- decide Context ownership explicitly: which installing invocation supplies the retained task lineage, confirm joiners and `executeAction(context)` do not reparent that procedure, and ensure every operation-owned effect replaces invocation cancellation with `EffectGate.signal`.

Then implement the smallest source slice and its focused deterministic tests. Do **not** rewrite `harness.md` first. Iterate on code until:

- automatic and manual paths use the same direct procedure;
- `Breakpoint.waitForChange()` tests cover wake on hit, release, interrupt, and close, including rejection for current and future waiters after close;
- crash/recovery, ownership, close/fault cleanup, multiple-observer, and unsupported-state rejection tests pass;
- event listeners complete before the first subsequent procedure hook;
- the user and Fable are satisfied that the shape is small and can extend naturally to tools, retry, deferred polling, abort, structural work, and later mechanisms without replacement machinery.

Only after that acceptance, update `harness.md` to describe the proven behavior, remove or revise conflicting future R2/R3 prose, and record the package's actual invariants, races, breakpoint catalog, and test obligations. Run focused tests, `npm run check`, and `./test.sh` again after the normative rewrite, then perform the final Fable review.

## Non-goals

- wall-clock drive deadlines or yielded outcomes;
- completion interests or durable scheduler receipts;
- activation epochs/tokens unless a concrete tested race proves the minimal owner cannot be fenced by existing lane state;
- retry metadata added to tool state;
- generic shutdown coordination redesign;
- real tool execution;
- deferred polling;
- durable abort/cancellation reconciliation;
- structural operations;
- coding-agent experimental workers or remote-runtime behavior.

## Stop condition for design

The handoff is ready only when it can be explained as:

```text
accept creates durable work
→ drive owns one direct procedure
→ breakpoint optionally parks
→ prepare intent
→ commit intent
→ effect
→ commit outcome
→ repeat or return
```

If the design needs another process-local or durable state machine to explain that trace, simplify it before implementation.
