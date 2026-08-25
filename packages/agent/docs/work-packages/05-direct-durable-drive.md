# WP05 — Direct durable drive

**Status: M3 complete; WP06 foundation landed before M4.** Independent Opus, GPT-5.6-Sol, and Fable reviews approved the authoritative-`Lane.state` design and M3 generation implementation with no blockers.

WP06 separates Session/Branch/AgentLane/AgentHarness, replaces keyed lane lines with one keyless Session mutation line, removes implicit main, and renames durable/public leaf fields to tip. Every M4–M8 instruction below is interpreted on that foundation; no compatibility aliases or Harness-as-main assumptions remain.

Removes breakpoints/manual drive, then implements the complete durable execution graph. Public drive stays disabled until every reachable phase and reconciliation path exists.

The review checkpoints at M1, M3, M5, M7 and the final review are mandatory process obligations independent of that status.

---

## 0. Mandatory reading order

Read completely, in this order, before editing anything.

- Read **all** of `harness.md`, start to finish. Excerpts, searches, prior conversation, and this handoff are not substitutes.
- Treat the current `harness.md`, this handoff, and the current runtime/session/execution APIs as the only architectural sources of truth. Do not rely on any external prototype, archive, or prior conversation.
- Implement runtime **clean-room**: do not inspect Git history for deleted runtime implementations, and do not recover, copy, adapt, or consult removed runtime1 code as a reference.
- Reread each relevant current source file completely before changing it.

1. `packages/agent/docs/harness.md` — all parts, normative.
2. `packages/agent/src/harness/agent-harness.ts` — public types and interfaces.
3. `packages/agent/src/harness/session/types.ts` — durable types (`OperationState`, `RunState`, `RunPhase`, `Generation`, `Deferred`, `ToolBatch`, `ToolCall`, `StructuralDecision`, `NavigationState`, `LaneLastResult`, `SessionReader`, `Write`, `CommitResult`).
4. `packages/agent/src/harness/session/values.ts` — every typed address and write helper.
5. `packages/agent/src/harness/runtime/lane.ts` — `Lane`, `Lane.command`, `LaneCommand`, `accept`.
6. `packages/agent/src/harness/runtime/types.ts` — `Config`, `LaneState`, `LaneCommand`, `Drive`, `ProcedureResult`, and `SliceNotImplemented`.
7. `packages/agent/src/harness/runtime/harness.ts` — `Harness`, config store, `fault`, `close`.
8. `packages/agent/src/harness/runtime/restore.ts` — projection restore.
9. `packages/agent/src/harness/execution/effect-gate.ts`, `execution/assistant.ts`, `execution/tools.ts`.
10. `packages/agent/src/harness/hooks.ts`, `events.ts`, `context.ts`, `result.ts`, `telemetry.ts`.
11. `packages/agent/src/harness/types.ts` — `AgentHarnessTool`, `AgentHarnessToolInvocation`.
12. `packages/agent/src/harness/session/testing/storage-decorator.ts`, `instrumented-storage.ts`, `testing/index.ts`.
13. Tests: `test/harness/runtime/{accept,harness,lane,restore,watch}.test.ts`, `test/harness/runtime/test-utils.ts`, `test/harness/execution-primitives.test.ts`, `test/harness/types.test.ts`.

---

## 1. Module ownership and import direction

```
agent-harness.ts        public types + constructor         -> runtime/harness.ts
session/**              durable storage + session         imports no harness runtime module
execution/effect-gate   Gate / GateControl / AbortRequested
execution/assistant     provider streaming
execution/tools         tool phase helpers
runtime/types.ts       Config / LaneState / LaneCommand / Drive / ProcedureResult
runtime/progress.ts    progress channels                 -> runtime/types, type-only runtime/lane
runtime/drive/*.ts     procedures                        -> runtime/types, progress, type-only runtime/lane
runtime/drive.ts       the switch                        -> runtime/drive/*, type-only runtime/lane   (M7 only)
runtime/lane.ts        Lane owner + public surfaces      -> runtime/drive.ts (value import, M8)
runtime/harness.ts     Harness                           -> runtime/lane.ts
```

Rules:
- `drive.ts` and `drive/**` import the concrete `Lane<TContext>` with `import type`; the edge erases, so `lane.ts` can value-import `drive.ts` without a runtime cycle.
- No `Deps`, scope, handle, supervisor, or capability interface. Procedures receive the concrete lane and one `Drive`; `drive.gate` is the sole admission path.
- Admission is always spelled `drive.gate.admit(…)`. There is no second alias for the gate.
- A module may only import modules that already exist at its own milestone. `drive.ts` therefore cannot be written before M7.
- No generic scheduler, effect combinator, action interpreter, or callback that hides a commit.
- Addresses are typed constructors from `session/values.ts`. Never string addresses. Never a `delete_prefix` write op — it does not exist in `Write`.

---

## 2. Approved source shape

**Approved** = the target structure; deviation needs a stated reason.
**Illustrative** = names/fields inside a body that may change while the structure holds.

### 2.1 Drive ownership, completion, and exact-object cleanup — approved

One installed process-local pass is one `Drive`. `Lane.activeDrive` is the ownership slot. The same object carries the shared completion, effect gate, invocation context, and pass-local wait policy; there is no handle, supervisor, scope, or separate capability object.

```ts
// packages/agent/src/harness/runtime/types.ts
export class Drive {
	readonly operationId: string;
	readonly completion: Promise<DriveOutcome>;
	readonly gate: Gate;
	readonly context: Context;               // installer context with cancellation removed
	readonly installerSignal: AbortSignal | undefined; // used only to abandon this installed pass
	readonly waitForRetry: boolean;
	deferredPermits: number;
	finalizedOutcome?: DriveOutcome;
	passEnded = false;

	private readonly control: GateControl;
	private settled = false;
	// private resolve/reject closures omitted

	constructor(options: DriveOptions, context: Context) {
		this.operationId = options.operationId;
		this.installerSignal = context.abortSignal;
		this.context = withoutAbortSignal(context);
		this.waitForRetry = options.waitForRetry ?? false;
		this.deferredPermits = options.pollDeferred === true ? 1 : 0;
		// create observed completion and Gate/GateControl
	}

	settle(outcome: DriveOutcome): void { /* first call wins */ }
	fail(error: unknown): void { /* first call wins */ }
	hasSettled(): boolean { return this.settled; }
	beginAbort(cancellation: Promise<void>): void { this.control.beginAbort(cancellation); }
	signalAbort(): void { this.control.signalAbort(); }
	closeGate(error: Error): void { this.control.close(error); }
}
```

Procedures receive the concrete lane and drive:

```ts
async function runGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive, generation: Generation,
): Promise<ProcedureResult> { /* straight-line procedure */ }
```

`drive/**` imports `Lane` with `import type`, so no runtime cycle exists. `Lane` is package-internal and is not exported from the package root.

Exact ownership and cleanup stay on `Lane`:

```ts
// packages/agent/src/harness/runtime/lane.ts
/** Package-internal so deterministic tests can install and replace exact owners. */
activeDrive: Drive | undefined;

isDriveActive(drive: Drive): boolean {
	return this.activeDrive === drive;
}

private removeDrive(drive: Drive): void {
	if (this.activeDrive === drive) this.activeDrive = undefined;
}
```

Every late transition and progress write checks the current operation in the authoritative `Lane.state` supplied by the Session mutation line and exact process identity. Exact identity is checked again synchronously at commit admission, immediately before `mutator.commit()`, with no `await` between the check and invocation. A planner-side check alone is insufficient because abandonment may replace the owner after an asynchronous planner returns.

This prevents ABA writes: after invocation abandonment, a replacement `Drive` may own the same durable operation id; the old object still fails exact identity and cannot write or remove the replacement. The small package-internal `Lane.commandDriveOwned(drive, plan, context)` variant performs only this admission check; it otherwise has the same visible `LaneCommand` decision as `command` and introduces no planner or transition framework.

`startDrive` is ordinary Lane code:

```ts
/** Package-internal M7 lifecycle seam; not part of AgentLane. */
startDrive(drive: Drive): void {
	const abandon = () => this.abandonDrive(drive, new DriveAbandoned());
	drive.installerSignal?.addEventListener("abort", abandon, { once: true });
	if (drive.installerSignal?.aborted) abandon();
	if (!this.isDriveActive(drive)) {
		drive.installerSignal?.removeEventListener("abort", abandon);
		return; // pre-aborted installer starts no pass work
	}

	const pass = (async () => {
		try {
			return await runDrive(this, drive);
		} finally {
			drive.installerSignal?.removeEventListener("abort", abandon);
			drive.passEnded = true;
			// Normal passes remove before settlement. A finalized pass remains joinable until
			// both its terminal event was delivered/settled and detached work ended.
			if (drive.finalizedOutcome === undefined || drive.hasSettled()) this.removeDrive(drive);
		}
	})();
	pass.then(
		(outcome) => {
			// Once finalization records its outcome, the finalizer owns completion ordering:
			// terminal event delivery first, then settle. The detached pass must not win.
			if (drive.finalizedOutcome === undefined) drive.settle(outcome);
		},
		(error) => {
			if (drive.finalizedOutcome === undefined) drive.fail(error);
		},
	);
	void pass.catch(() => {});
}
```

Completion and owner removal are independent actions, but they need no supervisor object:

| Path | Completion | Owner |
|---|---|---|
| normal return/rejection | pass calls `drive.settle` / `drive.fail` | pass `finally` removes exact drive first |
| external finalization | committed materialization records `finalizedOutcome` and closes the gate; after terminal event delivery, the finalizer settles without waiting for detached work | exact owner remains installed until **both** event-delivered settlement and pass ending have occurred; whichever happens second removes it |
| installer abandonment | close gate and call `drive.fail(new DriveAbandoned())` immediately | remove exact drive immediately so a replacement pass can recover `effect_pending` |
| close/fault | close gate and fail completion immediately | remove exact drive; admission is already sealed |

Omitting removal is the retention operation; there is no no-op `retainOwner()` method.

Install and join share `drive.completion`. Therefore installer abandonment abandons that shared pass and every current joiner receives `DriveAbandoned`; durable state remains at its last commit and any caller may drive it again. A joiner's own invocation cancellation ends only that joiner's observation and does not abandon the installed pass. The retained pass context is cancellation-free; `installerSignal` is observed separately for installer abandonment.

An in-process finalizer records `drive.finalizedOutcome` before closing the gate in committed materialization, delivers its terminal event, then settles the Drive without waiting for detached work. `runDrive` catches `OperationEnded` and returns that outcome without entering another lane job or publishing another end event. A replacement-process finalizer has no local drive and hydration uses `laneLastResult`.

### 2.2 Gate / GateControl — approved

```ts
// packages/agent/src/harness/execution/effect-gate.ts
export class AbortRequested extends Error { /* unchanged: carries `cancellation` */ }

/** Invocation cancellation or owner abandonment. Never durable cancellation. */
export class DriveAbandoned extends Error {
	constructor() {
		super("Drive pass was abandoned by its installing invocation");
		this.name = "DriveAbandoned";
	}
}

export interface Gate {
	/** check(); return invoke(); — no await may appear between them. */
	admit<T>(invoke: () => T): T;
	readonly signal: AbortSignal;
}

export interface GateControl {
	beginAbort(cancellation: Promise<void>): void;
	signalAbort(): void;
	close(error: Error): void;
}

type GateState =
	| { status: "open" }
	| { status: "aborting"; cancellation: Promise<void> }
	| { status: "closed"; error: Error };

export function createGate(): { gate: Gate; control: GateControl } {
	let state: GateState = { status: "open" };
	const controller = new AbortController();

	// The only check. A closure, not a method: there is no assertOpen() to call
	// at the wrong distance from its call.
	const check = (): void => {
		if (state.status === "aborting") throw new AbortRequested(state.cancellation);
		if (state.status === "closed") throw state.error;
	};

	return {
		gate: {
			admit<T>(invoke: () => T): T {
				check();
				return invoke();
			},
			signal: controller.signal,
		},
		control: {
			beginAbort(cancellation) {
				if (state.status !== "open") return;
				state = { status: "aborting", cancellation };
			},
			signalAbort() {
				if (state.status !== "aborting" || controller.signal.aborted) return;
				controller.abort(new AbortRequested(state.cancellation));
			},
			close(error) {
				state = { status: "closed", error };
				if (!controller.signal.aborted) controller.abort(error);
			},
		},
	};
}
```

Invocation-cancellation policy (approved):

| Event | Action |
|---|---|
| installing invocation aborted **before** any admit | nothing starts; no durable write; pass abandoned |
| installing invocation aborted **after** intent/admission | `abandonDrive(drive, new DriveAbandoned())` (M7): closes the gate, fails the shared pass completion for installer and current joiners, and removes the owner immediately — independent of the pass, so the next drive can claim the lane even if the old effect never returns. Durable state stays at its last commit (`effect_pending`) and that next drive recovers it as an orphan |
| joiner invocation aborted | only that joiner's observation ends |
| `requestAbort` | `beginAbort` → interrupt → commit `cancel_requested` → **then** `signalAbort()` |

`DriveAbandoned` never writes `cancel_requested`, never commits an aborted settlement, never calls `requestAbort`.
The retained pass context is `withoutAbortSignal(installerContext)`; admitted effects compose `withAbortSignal(gate.signal, …)`.

### 2.3 Lane.drive claim / join / hydration — approved

```ts
// packages/agent/src/harness/runtime/lane.ts
type DriveClaim =
	| { kind: "join"; drive: Drive }
	| { kind: "install"; drive: Drive }
	| { kind: "settled"; outcome: DriveOutcome }
	| { kind: "mismatch"; error: OperationMismatch };

async drive(options: DriveOptions, context: Context): Promise<DriveResult> {
	context.abortSignal?.throwIfAborted(); // a pre-aborted invocation installs and starts nothing
	if (this.closedError instanceof HarnessClosed) {
		return Result.err(new Closed({ message: this.closedError.message }));
	}
	this.assertOpen();

	const claim = await this.command<DriveClaim>(async (state, reader) => {
		// 1. A matching local owner wins over owned-projection idle: after the terminal
		//    commit the lane is idle while the old owner is still delivering final events
		//    and removing itself.
		const owner = this.activeDrive;
		if (owner !== undefined && owner.operationId === options.operationId) {
			return { kind: "return", result: { kind: "join", drive: owner } };
		}

		const currentId = state.operation?.meta.operationId ?? null;
		const last = state.lastResult;

		// 2. Another operation is still owned locally.
		if (owner !== undefined) {
			return { kind: "return", result: { kind: "mismatch", error: this.mismatch(options.operationId, currentId, last) } };
		}

		// 3. Current operation matches and has no owner: install.
		if (currentId === options.operationId) {
			const drive = new Drive(options, context);
			this.activeDrive = drive;
			return { kind: "return", result: { kind: "install", drive } };
		}

		// 4. Idle and the latest result is ours: dereference only entries named by it.
		if (currentId === null && last?.operationId === options.operationId) {
			const outcome = await hydrateTerminalOutcome(reader, last, context);
			return { kind: "return", result: { kind: "settled", outcome: { kind: "settled", operationId: options.operationId, outcome } } };
		}
		return { kind: "return", result: { kind: "mismatch", error: this.mismatch(options.operationId, currentId, last) } };
	}, context);

	switch (claim.kind) {
		case "mismatch":
			return Result.err(claim.error);
		case "settled":
			return Result.ok(claim.outcome);
		case "join":
			// A joiner's invocation signal ends only its observation.
			return awaitCompletion(observeCompletion(claim.drive.completion, context));
		case "install":
			this.startDrive(claim.drive); // AFTER the line released
			// Installer cancellation is translated by startDrive into shared DriveAbandoned.
			return awaitCompletion(claim.drive.completion);
	}
}

function observeCompletion(completion: Promise<DriveOutcome>, context: Context): Promise<DriveOutcome> {
	const signal = context.abortSignal;
	if (signal === undefined) return completion;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<DriveOutcome>((resolve, reject) => {
		const aborted = () => {
			signal.removeEventListener("abort", aborted);
			reject(signal.reason); // this joiner's observation only
		};
		signal.addEventListener("abort", aborted, { once: true });
		completion.then(
			(outcome) => { signal.removeEventListener("abort", aborted); resolve(outcome); },
			(error) => { signal.removeEventListener("abort", aborted); reject(error); },
		);
	});
}

/** Shared adapter from an observed completion to DriveResult. */
async function awaitCompletion(completion: Promise<DriveOutcome>): Promise<DriveResult> {
	try {
		return Result.ok(await completion);
	} catch (error) {
		// Expected, and declared in DriveResult's error union.
		if (error instanceof OperationMismatch) return Result.err(error);
		if (error instanceof Closed) return Result.err(error);
		// Not expected errors and not members of the union: HarnessClosed, HarnessFault, and
		// DriveAbandoned reject the caller's promise unchanged.
		throw error;
	}
}

private mismatch(expected: string, currentOperationId: string | null, last: LaneLastResult | undefined): OperationMismatch {
	return new OperationMismatch({
		lane: this.name,
		expectedOperationId: expected,
		...(currentOperationId === null ? {} : { currentOperationId }),
		...(last === undefined ? {} : { lastOperationId: last.operationId }),
		message: `Operation ${expected} does not own lane ${JSON.stringify(this.name)}`,
	});
}
```

`accept` gains one guard (approved): while `this.activeDrive !== undefined`, return `LaneBusy` even when durable state is idle. Installer cancellation abandons the shared pass; joiner cancellation only ends that joiner's `awaitCompletion` observation.

### 2.4 Drive switch contract — approved

**Compile ordering.** `Drive` lives in `runtime/types.ts` from M1; M2 replaced the initial `StepResult` with `ProcedureResult`. `runtime/drive.ts` is created in M7, once every procedure module it imports exists. M2–M6 call procedures directly from tests with a concrete `Lane` and `Drive`; public drive stays guarded until M8.

```ts
// packages/agent/src/harness/runtime/types.ts
export type LostOwnership = { kind: "lost_ownership" };

export type ProcedureResult =
	| { kind: "continue" }
	| { kind: "waiting"; outcome: DriveOutcome }
	| { kind: "settled"; outcome: TerminalOperationOutcome }
	| LostOwnership;
```

| Result | Obligation |
|---|---|
| `continue` | inspect the current `Lane.state` and continue the ordinary drive loop; this procedure either committed or observed a supported concurrent change since its pre-work snapshot |
| `waiting` | the operation is durably parked in retry or deferred wait |
| `settled` | this procedure's terminal transaction committed |
| `lost_ownership` | commit nothing; this task terminates and never writes again |

There is no global `advance`/`reload` distinction. A procedure must not return `continue` from an unchanged state it does not understand; that is an invariant defect, not a spin-and-hope path. Whether a particular intent commit landed matters only to the straight-line procedure that is about to start its effect. Such a helper returns a small local result such as `"committed" | "state_changed" | LostOwnership`; it does not become drive-loop vocabulary. Tool children likewise use a tool-local result when the batch must know whether a child staged or materialized anything.

```ts
// packages/agent/src/harness/runtime/drive.ts — M7
export async function runDrive<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive,
): Promise<DriveOutcome> {
	try {
		await runBeforeDriveUnlessCancelled(lane, drive);
		for (;;) {
			if (lane.closedError !== undefined) throw lane.closedError;
			if (!lane.isDriveActive(drive)) throw new DriveAbandoned();
			const before = lane.state;
			const operation = before.operation;
			if (operation === null || operation.meta.operationId !== drive.operationId) {
				return hydrateSettled(lane, drive);
			}
			if (operation.state.control.status === "cancel_requested") {
				return { kind: "settled", operationId: drive.operationId,
					outcome: await reconcile(lane, drive, operation) };
			}
			const result = await dispatch(lane, drive, operation);
			if (result.kind === "continue") {
				if (lane.state === before) {
					throw new SessionInvariantError("drive procedure returned continue without progress");
				}
				continue;
			}
			if (result.kind === "lost_ownership") {
				if (drive.finalizedOutcome !== undefined) return drive.finalizedOutcome;
				if (lane.closedError !== undefined) throw lane.closedError;
				throw new DriveAbandoned();
			}
			if (result.kind === "settled") {
				return { kind: "settled", operationId: drive.operationId, outcome: result.outcome };
			}
			return result.outcome;
		}
	} catch (error) {
		if (error instanceof OperationEnded) return hydrateSettled(lane, drive);
		if (error instanceof AbortRequested) {
			await error.cancellation;
			const operation = lane.state.operation;
			if (operation === null || operation.meta.operationId !== drive.operationId) {
				return hydrateSettled(lane, drive);
			}
			return { kind: "settled", operationId: drive.operationId,
				outcome: await reconcile(lane, drive, operation) };
		}
		throw error;
	}
}
```

The body is illustrative, not a required helper inventory. The unchanged-`continue` guard rejects the pass with `SessionInvariantError`; it is a liveness assertion outside `Lane.command`, not another transition or a storage reread. `drivePass`/`dispatch` inspect the authoritative `Lane.state`; they do not load lane or operation control values from storage. `hydrateSettled` first returns `drive.finalizedOutcome` when present; otherwise it uses matching `lane.state.lastResult` and dereferences only entries named by that result. A foreign current/latest operation produces `OperationMismatch` and no write.

### 2.5 Authoritative lane state and owned commands — approved

`Lane.command` passes the authoritative current lane/operation projection. Every supported control-state mutation commits through that `Lane`, and a successful commit publishes `decision.next` before releasing the mutation line. A failed commit publishes nothing and faults the harness. A process crash destroys the projection; attachment restores and validates it from durable control values.

Procedures therefore do **not** reread `laneState`, `operationMeta`, `operationState`, `branchTip`, or `laneConfig` on each transition. They use the callback reader only to dereference content named by the projection: pending entries, assistant frames, tool arguments/checkpoints, preparations, memos, staged outcomes, tree entries, and cleanup-prefix scans.

Drive-owned commands use one small `Lane` variant so exact-object ownership is checked at commit admission rather than only in an asynchronous planner:

```ts
// packages/agent/src/harness/runtime/lane.ts
async commandDriveOwned<TResult>(
	drive: Drive,
	plan: (state: LaneState, reader: SessionReader) =>
		LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
	context: Context,
): Promise<TResult | LostOwnership> {
	// Same implementation and visible LaneCommand decision as command(), with two additions:
	// 1. before planning, state.operation must name drive.operationId and activeDrive must be drive;
	// 2. for a commit decision, assertOpen() and activeDrive === drive are checked immediately
	//    before mutator.commit(), with no await between the checks and invocation.
}
```

`commandDriveOwned` is not a scheduler, planner, transaction wrapper, or capability facade. It is `Lane.command` plus the exact-Drive admission fence. If its initial operation/id check or final exact-object check fails, it returns `lost_ownership` and commits nothing. Close/fault is checked first at final admission and propagates its lifecycle error rather than being mislabeled as ownership loss. This extra final open check is drive-specific: exact owner abandonment may occur outside the Session line while an asynchronous planner runs. An ordinary `command` is admitted when its mutation callback starts and may finish that active commit after close begins. Ordinary public lane commands continue to use `command`.

A representative transition stays direct:

```ts
const intent = await lane.commandDriveOwned(drive, (state) => {
	const operation = state.operation;
	if (operation === null || operation.state.kind !== "run") {
		throw new SessionInvariantError("generation intent reached a non-run operation");
	}
	const run = operation.state;
	if (run.control.status === "cancel_requested") {
		return { kind: "return", result: { kind: "state_changed" } as const };
	}
	if (run.phase.kind !== "assistant" ||
		run.phase.generation.status !== "ready" ||
		run.phase.generation.context.stepId !== expectedStepId) {
		throw new SessionInvariantError("generation intent lost its ready boundary");
	}
	const nextState: RunState = { ...run, phase: { kind: "assistant", generation } };
	return {
		kind: "commit",
		writes: [setValue(operationStateValue(drive.operationId), nextState)],
		next: { ...state, operation: { meta: operation.meta, state: nextState } },
		materialize: () => ({ kind: "committed" } as const),
		events: () => [{ type: "turn_start", runId: drive.operationId,
			turnId: expectedStepId, lane: lane.name }],
	};
}, drive.context);
if (intent.kind !== "committed") return intent.kind === "lost_ownership"
	? intent
	: { kind: "continue" };
// The effect may start only on this branch.
```

The transition derives `next` from the state supplied to that planner, never from a snapshot captured before the lane job. Inbox and other concurrent fields that do not invalidate this transition are preserved in the committed next state. Cancellation returns to reconciliation without committing; a newly non-empty inbox invalidates only a terminal-finish boundary; relevant tool-sibling movement uses the tool-local `state_changed` result. Ownership loss is handled in band. A matching operation with any other impossible kind/phase relationship is a `SessionInvariantError`.

The single-owner contract is explicit: while a Harness owns a `Session`, raw Branch mutation for a configured AgentLane and reserved control-address writes are forbidden. In-process administrative finalization also commits through the owning `Lane`. External storage mutation is not a supported second authority, and the runtime does not silently heal it. Conformance tests compare each committed projection with a fresh restore at controlled boundaries.

### 2.6 Generation procedure — approved shape, illustrative bodies

```ts
// packages/agent/src/harness/runtime/drive/generation.ts
async function runReadyGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive, run: RunState,
	gen: Extract<Generation, { status: "ready" }>,
): Promise<ProcedureResult> {
	const config = lane.readConfig();
	const identity = gen.context.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) return enterConfigurationFailure(lane, drive, "model_unavailable", identity);

	// ---- prepare: pure/local, nothing reserved yet ----
	const messages = await buildRequestMessages(lane, drive, gen.context, run);
	const systemPrompt = await resolveSystemPrompt(config, drive.context);
	const patch = await lane.hooks.runWithGate(
		"before_request",
		{ lane: lane.name, runId: drive.operationId, model, step: "assistant",
			attempt: gen.nextAttempt, streamOptions: gen.context.streamOptions },
		drive.gate, drive.context,
	);
	const streamOptions = applyStreamOptionsPatch(gen.context.streamOptions, patch?.streamOptions);
	const at = Date.now();
	const responseEntryId = lane.session.idGenerator.next(at);
	const usageId = lane.session.idGenerator.next(at);

	// ---- intent: one visible commit ----
	const generation: Generation = {
		status: "effect_pending", context: gen.context, attempt: gen.nextAttempt,
		responseEntryId, usageId,
		intendedOutputLimit: model.maxTokens, contextWindow: model.contextWindow,
	};
	const intent = await commitGenerationIntent(lane, drive, gen.context.stepId, generation);
	if (intent.kind === "lost_ownership") return intent;
	if (intent.kind === "state_changed") return { kind: "continue" };

	// ---- effect: admitted, off the Session line ----
	const progress = openFrameProgress(lane, drive, responseEntryId);
	let response: SettledAssistantMessage;
	try {
		response = await streamHarnessAssistant(messages, {
			model, systemPrompt, thinkingLevel: gen.context.configuration.thinkingLevel, streamOptions,
			toProviderMessages: config.toProviderMessages,
			request: (aiContext, options) =>
				drive.gate.admit(() => lane.models.streamSimple(model, aiContext, options)),
			observer: frameObserver(lane, drive, progress, responseEntryId),
		}, withAbortSignal(drive.gate.signal, drive.context));
	} finally {
		progress.seal();
	}
	await progress.drain();

	// ---- outcome: one visible commit ----
	return settleAssistant(lane, drive,
		{ responseEntryId, usageId, stepId: gen.context.stepId }, response);
}
```

Preparation precedes the intent commit; settlement writes under the reserved ids; the frame observer enqueues synchronously and never awaits storage; `progress.drain()` precedes settlement. `commitGenerationIntent` has a small local result because this procedure must know whether it may start the effect. Successful settlement returns `continue`, `waiting`, `settled`, or `lost_ownership` according to the state it committed; there is no global commit-count result.

### 2.7 Progress helper — approved

```ts
// packages/agent/src/harness/runtime/progress.ts
export interface ProgressChannel<T> {
	write(item: T): void;
	seal(): void;
	drain(): Promise<void>;
	clearWrite(): Write;
}

function openProgress<TContext extends object | undefined, T>(
	lane: Lane<TContext>, drive: Drive,
	commitWrite: (item: T) => Write,
	clear: () => Write,
	stillOwns: (state: LaneState) => boolean,
): ProgressChannel<T> {
	let sealed = false;
	let latest: Promise<void> = Promise.resolve();
	return {
		write(item) {
			if (sealed) return;
			const write = lane.commandDriveOwned(drive, (state) => {
				if (!stillOwns(state)) return { kind: "return", result: undefined };
				return { kind: "commit", writes: [commitWrite(item)], next: state,
					materialize: () => undefined };
			}, drive.context).then(() => undefined);
			latest = write;
			void write.catch(() => {});
		},
		seal() { sealed = true; },
		async drain() { await latest; },
		clearWrite: clear,
	};
}
```

`openFrameProgress(lane, drive, responseEntryId)` and `openToolProgress(lane, drive, invocationId)` inspect the current projection's phase/id and use `commandDriveOwned` for the final exact-Drive admission fence. They perform no durable control reads. The provider/tool callback enqueues synchronously, settlement seals then drains, and the settling transaction includes `clearWrite()`.

### 2.8 Tool batch — approved shape, illustrative bodies

The tool procedure is one ordinary async routine. It keeps its process-local started-promise map, but every status patch is computed from the current `Lane.state` supplied to that specific `commandDriveOwned` job. It never patches a batch snapshot captured before the job.

Each child uses module-local results only:

```ts
type ToolChildResult =
	| { kind: "committed" }
	| { kind: "state_changed" }
	| LostOwnership;

type ToolTransitionResult = ToolChildResult | { kind: "unchanged" };

type ToolStartResult =
	| { kind: "started"; work: Promise<ToolChildResult> }
	| { kind: "finished"; result: ToolChildResult };
```

These are local facts needed by this procedure; none becomes drive-loop vocabulary. `startCall` and `recoverCall` perform one call's source-ordered clearance through intent/admission. A real effect is already admitted before they return `{ kind: "started" }`; `work` owns only effect settlement and outcome staging. An immediate blocked, missing, invalid, or unsafe-recovery outcome is staged before `{ kind: "finished" }` returns. This keeps clearance/intent source-ordered while parallel effects settle independently.

```ts
async function runToolBatch<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive, run: RunState, batch: ToolBatch,
): Promise<ProcedureResult> {
	// A crash can leave source-ready outcome_ready calls with no live task. Place them
	// before resolving tools or starting effects. If this changes state, redispatch
	// instead of continuing with the captured batch.
	const prefix: ToolTransitionResult = await materializeReadyPrefix(lane, drive, batch.turnId);
	if (prefix.kind === "lost_ownership") return prefix;
	if (prefix.kind === "committed" || prefix.kind === "state_changed") {
		return { kind: "continue" };
	}

	const sequential = run.settings.toolExecution === "sequential";
	const toolContext = await resolveToolContext(lane, drive); // exactly once for this batch pass
	const started = new Map<number, Promise<ToolChildResult>>();
	let cancellation: Promise<void> | undefined;

	try {
		for (const call of batch.calls) {
			if (call.status === "completed" || call.status === "outcome_ready") continue;

			// Await only through clearance, intent commit, and synchronous effect admission.
			// The loop therefore admits calls in source order. In parallel mode an admitted
			// earlier effect may run while the next call is being cleared.
			const launch: ToolStartResult = call.status === "effect_pending"
				? await recoverCall(lane, drive, batch, call, toolContext) // orphan by construction
				: await startCall(lane, drive, batch, call, toolContext);

			let result: ToolChildResult | undefined;
			if (launch.kind === "started") {
				// Attach the fault observer immediately. The original promise remains in the
				// map for ordinary result handling and cancellation reconciliation.
				void launch.work.catch(() => {});
				started.set(call.sourceIndex, launch.work);
				if (sequential) result = await launch.work;
			} else {
				result = launch.result;
			}

			if (result?.kind === "lost_ownership") return result;
			if (result?.kind === "state_changed") {
				cancellation = Promise.resolve(); // the current projection already carries it
				break;
			}

			if (sequential) {
				// Sequential means stage and place this call before clearing the next one.
				const placed: ToolTransitionResult = await materializeReadyPrefix(
					lane, drive, batch.turnId,
				);
				if (placed.kind === "lost_ownership") return placed;
				if (placed.kind === "state_changed") {
					cancellation = Promise.resolve();
					break;
				}

				const current = lane.state.operation;
				if (current === null || current.meta.operationId !== drive.operationId ||
					current.state.kind !== "run" || current.state.control.status === "cancel_requested" ||
					current.state.phase.kind !== "tools" ||
					current.state.phase.batch.turnId !== batch.turnId) {
					return { kind: "continue" };
				}
			}
		}

		if (!sequential && cancellation === undefined) {
			// Every eligible call has now passed source-ordered clearance/intent admission.
			// Settlement and outcome staging complete independently in completion order.
			const results = await Promise.all(started.values());
			if (results.some((result) => result.kind === "lost_ownership")) {
				return { kind: "lost_ownership" };
			}
			if (results.some((result) => result.kind === "state_changed")) {
				cancellation = Promise.resolve();
			}
		}
	} catch (error) {
		if (!(error instanceof AbortRequested)) {
			// Every started promise already has an observer; rethrow without detaching
			// unobserved sibling rejections under close, fault, or finalization.
			throw error;
		}
		cancellation = error.cancellation;
	}

	if (cancellation !== undefined) {
		await cancellation;

		// Some parallel children may already be running or staged. Observe every result
		// before handling calls that never passed admission.
		const results = await Promise.allSettled(started.values());
		let unexpected: { error: unknown } | undefined;
		for (const result of results) {
			if (result.status === "fulfilled") {
				if (result.value.kind === "lost_ownership") return result.value;
				continue;
			}
			if (!(result.reason instanceof AbortRequested) && unexpected === undefined) {
				unexpected = { error: result.reason };
			}
		}
		if (unexpected !== undefined) throw unexpected.error;

		// Derive this patch from the current batch. It stages only calls that never
		// started and leaves real finalized outcomes intact.
		const staged: ToolTransitionResult = await stageUnstartedCalls(
			lane, drive, batch.turnId, new Set(started.keys()),
		);
		if (staged.kind === "lost_ownership") return staged;
		if (staged.kind === "state_changed") return { kind: "continue" };
	}

	// Placement is separate from completion-order staging. It inserts only the current
	// contiguous ready prefix, in source order, and may finish the batch checkpoint.
	const placed: ToolTransitionResult = await materializeReadyPrefix(lane, drive, batch.turnId);
	if (placed.kind === "lost_ownership") return placed;
	return { kind: "continue" };
}
```

Every child command rereads no control values from storage; it patches the authoritative state supplied to that lane job:

```ts
function patchCall(state: RunState, sourceIndex: number, next: ToolCall): RunState {
	if (state.phase.kind !== "tools") throw new SessionInvariantError("not a tools phase");
	return {
		...state,
		phase: { kind: "tools", batch: {
			...state.phase.batch,
			calls: state.phase.batch.calls.map((call) =>
				call.sourceIndex === sourceIndex ? next : call),
		} },
	};
}
```

Staging is completion-ordered (`outcome_ready`); `materializeReadyPrefix` places the contiguous ready prefix in source order in one commit, and `addedToolNames` takes effect only at placement. Under cancellation, no later call starts, every started promise is observed, unstarted calls receive their specified synthetic outcomes, and source-order materialization finishes before reconciliation continues.

### 2.9 Terminal transactions stay in their procedures — approved

The procedure that owns a terminal boundary also owns its terminal `Lane.commandDriveOwned`. An authorized in-process external finalizer is the one exception: it owns an ordinary `Lane.command` because it may finalize an unowned operation. Its `materialize` continuation records `finalizedOutcome` and closes any matching live Drive gate synchronously after projection publication. The finalizer settles that Drive only after `Lane.command` returns, so terminal event delivery still precedes public completion. The finalizer must still verify that the current projection names the exact operation it intends to end; a terminal winner observed first commits nothing. Each procedure already knows its exact semantic state, local result, publication writes, public outcome, and terminal event. There is no generic `commitTerminal`, `TerminalRequest`, terminal validator callback, or terminal planner.

Inside that one command, the procedure:

1. verifies its exact terminal boundary against the current authoritative projection;
2. computes its bounded `LaneLastResult` directly from known state and reserved ids;
3. prepends any procedure-specific publication writes (summary entry, navigation tip/label movement, usage);
4. appends the shared mechanical operation-cleanup writes;
5. writes `laneLastResult` and idle `laneState`;
6. publishes the exact idle process-local projection, including any tip movement in its publication writes;
7. constructs the complete `{ kind: "settled", outcome }` and its one terminal event from `CommitResult`, which supplies storage-assigned entry sequence and timestamp when needed.

A normal completed-run finish is representative. Its terminal check is visibly part of the checkpoint procedure:

```ts
return lane.commandDriveOwned(drive, async (state, reader) => {
	const operation = state.operation;
	if (operation === null || operation.state.kind !== "run") {
		throw new SessionInvariantError("run finish reached a non-run operation");
	}
	const run = operation.state;
	if (run.control.status === "cancel_requested") {
		return { kind: "return", result: { kind: "continue" } as const };
	}
	if (run.phase.kind !== "checkpoint" || run.phase.continuation.kind !== "may_finish") {
		throw new SessionInvariantError("run finish lost its checkpoint boundary");
	}
	if (run.inbox.steer.length !== 0 || run.inbox.followUp.length !== 0 || run.inbox.writes.length !== 0) {
		return { kind: "return", result: { kind: "continue" } as const };
	}
	if (state.tipId === null) throw new SessionInvariantError("completed run has no tip");

	const finalId = run.phase.continuation.includeFinalAssistant
		? run.latestAssistantEntryId
		: null;
	const finalEntry = finalId === null
		? undefined
		: (await reader.getEntries([finalId], drive.context)).get(finalId);
	if (finalId !== null &&
		(finalEntry?.type !== "message" || finalEntry.message.role !== "assistant" ||
			finalEntry.message.stopReason === "pending")) {
		throw new SessionInvariantError(`Run finish references invalid assistant ${finalId}`);
	}
	const final = finalEntry?.type === "message" && finalEntry.message.role === "assistant"
		? { finalEntryId: finalEntry.id, finalMessage: finalEntry.message }
		: {};
	const outcome: TerminalOperationOutcome = {
		operation: "run", runId: drive.operationId, kind: "completed",
		tipId: state.tipId, ...final,
	};
	const lastResult: LaneLastResult = {
		operationId: drive.operationId,
		kind: "run",
		outcome: "completed",
		tipId: state.tipId,
		runCompletion: finalId === null ? "terminated_tools" : "assistant",
		...(finalId === null ? {} : { finalAssistantEntryId: finalId }),
	};
	const cleanup = await operationCleanupWrites(
		reader, drive.operationId, run, drive.context,
	);
	return {
		kind: "commit",
		writes: [
			...cleanup,
			setValue(laneLastResult(lane.name), lastResult),
			setValue(laneStateValue(lane.name), {
				currentOperationId: null,
				pendingNextRun: state.pendingNextRun,
			}),
		],
		next: { ...state, lastResult, operation: null },
		materialize: () => ({ kind: "settled", outcome } as const),
		events: () => [{
			type: "run_end", lane: lane.name, runId: drive.operationId,
			tipId: state.tipId, outcome: "completed", ...final,
		}],
	};
}, drive.context);
```

Standalone structural and navigation procedures use the same visible suffix after their own result-publication writes. They do not call a generic terminal procedure.

`runtime/drive/terminal.ts` contains only mechanical helpers:

- `operationCleanupWrites(reader, operationId, operationState, context)` scans typed operation prefixes and returns concrete deletes for meta/state, tool arguments, memos, preparations, tool-output checkpoints, the exact live assistant-frame list, and operation-owned pending entries;
- `hydrateTerminalOutcome(reader, lastResult, context)` dereferences only entries directly named by the bounded value.

Each procedure constructs its own `LaneLastResult` visibly. Entry-producing terminal procedures construct public entries and events in `materialize(commit)` / `events(commit)`, after storage assigned sequence and timestamp. Operation-id matching remains visible at the drive claim/hydration call site rather than hiding in another helper.

`pendingNextRun` is lane-owned and survives. Defensive deletes of already-removed addresses are no-ops. **Never** add `delete_prefix`. The outer drive loop performs process-local completion once after receiving `settled`; it does not construct or commit the terminal transaction.

### 2.10 GatingStorage + representative test — approved

Three properties make this a crash simulator rather than a delay: `discard()` is **permanent and total** (a commit arriving afterwards is rejected, never forwarded), `next()` **waits** for a commit to be parked instead of racing it, and `next()` resolves only once the released commit has actually **landed** in the backend. The old `setTimeout(0)` version failed all three: a late-settling effect could commit after the simulated crash because `discarded` fell through to `super.commit`, and a test could call `next()` before the drive had parked anything.

```ts
// packages/agent/src/harness/session/testing/gating-storage.ts

/** Thrown for any commit attempted after discard(). Never reaches the backend. */
export class CommitDiscarded extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommitDiscarded";
	}
}

interface ParkedCommit {
	release(): void;
	drop(error: Error): void;
	/** Resolves once the released commit landed; rejects if it was dropped or failed. */
	readonly landing: Promise<void>;
}

export class GatingStorage extends StorageDecorator {
	private armed = false;
	private discarded = false;
	private readonly queue: ParkedCommit[] = [];
	private readonly waiters: Array<{ count: number; resolve: () => void }> = [];

	/** Setup bypass: fixture writes commit ungated until arm() is called. */
	arm(): void { this.armed = true; }
	pending(): number { return this.queue.length; }

	/** Resolves once at least `count` commits are parked. Removes the next()/drive race. */
	waitPending(count = 1): Promise<void> {
		if (this.queue.length >= count) return Promise.resolve();
		return new Promise<void>((resolve) => { this.waiters.push({ count, resolve }); });
	}

	override async commit(writes: Write[], context: Context): Promise<CommitResult> {
		// After discard() this storage is dead. A late effect settling afterwards must never
		// reach the backend, so there is no bypass here — not even for unarmed commits.
		if (this.discarded) throw new CommitDiscarded("commit rejected: storage discarded");
		if (!this.armed) return super.commit(writes, context);

		let landed!: () => void;
		let lost!: (error: Error) => void;
		const landing = new Promise<void>((resolve, reject) => { landed = resolve; lost = reject; });
		void landing.catch(() => {});                 // observed by next(); keep Node quiet meanwhile

		const released = new Promise<void>((resolve, reject) => {
			this.queue.push({ release: resolve, drop: reject, landing });
		});
		this.notifyWaiters();

		try {
			await released;
			if (this.discarded) throw new CommitDiscarded("commit rejected: storage discarded");
			const result = await super.commit(writes, context);
			landed();
			return result;
		} catch (error) {
			lost(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	/** Release `count` parked commits, waiting for each to be parked and to land. */
	async next(count = 1): Promise<void> {
		for (let i = 0; i < count; i++) {
			await this.waitPending(1);
			const parked = this.queue.shift();
			if (parked === undefined) throw new Error("no parked commit");
			parked.release();
			await parked.landing;                     // resolves only after the write is in the backend
		}
	}

	/** Crash simulation: parked commits are dropped and no future commit may land. */
	discard(): void {
		this.discarded = true;
		for (const parked of this.queue.splice(0)) {
			parked.drop(new CommitDiscarded("commit discarded"));
		}
		this.notifyWaiters();
	}

	private notifyWaiters(): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			if (this.queue.length >= this.waiters[i].count) this.waiters.splice(i, 1)[0].resolve();
		}
	}
}
```

Composition (approved): `new InstrumentedStorage(new GatingStorage(new MemoryStorage({ now })))` — attempts are recorded at attempt time, gating parks between recording and storage.

```ts
// representative deterministic test (illustrative body, approved structure)
const storage = new InstrumentedStorage(new GatingStorage(new MemoryStorage({ now: () => NOW })));
const { harness, gating, provider } = await createDriveFixture(storage);   // setup bypass active
const admission = unwrap(await harness.accept({ kind: "prompt", prompt: "q" }, ctx));
gating.arm();

const driving = harness.drive({ operationId: admission.operationId }, ctx);
await gating.next();                                  // starting -> checkpoint (waits to be parked)
await gating.next();                                  // checkpoint -> assistant ready
await gating.next();                                  // intent: effect_pending
expect(await phaseOf(session, admission.operationId)).toMatchObject({ kind: "assistant" });

provider.resolve(fauxAssistantMessage("answer"));     // effect window released
await gating.next();                                  // settlement
gating.discard();                                     // crash before terminal
await expect(driving).rejects.toBeDefined();

// A late effect settling after the crash must not reach the backend.
await expect(storage.commit([/* any write */], ctx)).rejects.toBeInstanceOf(CommitDiscarded);

await harness.close(ctx);
const reopened = await repo.open(session.metadata, ctx);
// the discarded commit never landed; drive resumes from the settled checkpoint
```

Determinism: `MemoryStorage` accepts `now`; `Session.idGenerator` must become injectable (M1 API change) or tests compare under first-appearance id normalization.

### 2.11 Direct Lane procedure access and generic discipline — approved

Drive procedures are package-internal and receive the concrete `Lane<TContext>` plus `Drive`. There is no capability interface or dependency bundle.

```ts
// every drive procedure
import type { Lane } from "../lane.ts";
import type { Drive, ProcedureResult } from "../types.ts";

async function runCheckpoint<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive, run: RunState,
	phase: Extract<RunPhase, { kind: "checkpoint" }>,
): Promise<ProcedureResult> { /* ... */ }
```

`Lane` already exposes the package-internal members procedures need: `state`, `session`, `models`, `hooks`, `command`, `emitBatch`, `readConfig`, `mismatch`, and `isDriveActive`; M2 adds only `commandDriveOwned` for exact-Drive commit admission. The package root exports only `AgentLane` / `AgentHarness`, so these members do not widen public API. Procedure imports of `Lane` are type-only and erase; `lane.ts` may value-import `drive.ts` in M8 without a runtime cycle.

Rules:
- `TContext extends object | undefined` everywhere; no other bound.
- No `any`, `Lane<any>`, `as unknown as`, or `@ts-expect-error`.
- `Lane<TContext>` remains invariant because config consumes and produces `TContext`; never widen it.
- Tests use a concrete `Lane<undefined>` or `Lane<{ cwd: string }>` and install a `Drive` directly.
- A procedure never calls public reentrant lane mutations from inside a `Lane.command` planner. The command contract remains the single write path.
- Tool update options retain the exact `checkpoint?: true` literal shape.

### 2.12 Usage totals from the commit boundary — approved

A usage event must carry the session totals **as of its own commit**, and `Lane.command` already materializes and emits synchronously from `CommitResult`:

```ts
materialize(commit: CommitResult): Synchronous<TResult>;
events?(commit: CommitResult): HarnessEvent[];
```

So the totals must be on `CommitResult`. A process-local accumulator would have to be seeded on attach and ordered across lanes by commit sequence, and would be wrong after any write that did not go through it (reopen, fork, external writer). The backends already maintain exactly the needed number incrementally.

**Target: `CommitResult` carries the post-commit `SessionStats` snapshot.**

```ts
// packages/agent/src/harness/session/types.ts
export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
	/** Session totals immediately after this commit was applied. */
	stats: SessionStats;
}
```

For the deliberately materialized Memory and JSONL backends, `InMemoryStorageState` already folds `messageCount` and `usage` in `applyValidated` and is rebuilt from the log on JSONL open. It is not an architecture for database backends or long-running sessions that may not fit in memory. SQLite maintains and reads indexed durable aggregates inside its commit transaction.

| File | Change |
|---|---|
| `src/harness/session/types.ts` | add `stats: SessionStats` to `CommitResult` |
| `src/harness/session/commit.ts` | `PreparedCommit.result` becomes `Omit<CommitResult, "stats">`; `prepareStorageCommit` is unchanged otherwise (it runs before apply and cannot know the totals) |
| `src/harness/session/in-memory-storage-state.ts` | `InMemoryStorageState.applyValidated(writes)` returns the post-apply `SessionStats` for the deliberately materialized Memory and JSONL backends |
| `src/harness/session/memory.ts` | `const stats = this.storageState.applyValidated(prepared.writes); return { ...prepared.result, stats };` |
| `src/harness/session/jsonl/storage.ts` | same composition inside `applyCommit` |
| `packages/session-backends/sqlite-node/src/sqlite/storage.ts` | **third backend — do not miss it.** `applyCommit` already runs inside `this.db.transaction(…)` and already maintains stats there via `incrementMessageCount` / `addUsageToSessionStats`. Read them back with `readSessionStats(this.db)` **inside the same transaction closure**, after `advanceNextSeq`, so the snapshot is atomic with the writes that produced it (see below) |
| `src/harness/session/testing/{storage-decorator,instrumented-storage}.ts` | no change: both forward the backend's `CommitResult` unmodified. Verify, do not rewrite |
| `src/harness/session/testing/conformance/storage.ts` | assert `(await storage.commit(…)).stats` deep-equals `await storage.getStats(…)` after every commit, and that totals after reopen include history. All three backends run this suite |
| `packages/session-backends/sqlite-node/test/storage-conformance.test.ts`, `packages/session-backends/sqlite-node/test/storage.test.ts` | the shared suite covers SQLite through `"SqliteStorage conformance"`; add a backend-local assertion that the returned `stats` is the post-write snapshot, not a pre-write one. Every path in this row is outside `packages/agent`, unlike every other bare `test/…` path in this handoff |

The SQLite composition, in full — the placement is the whole point:

```ts
// packages/session-backends/sqlite-node/src/sqlite/storage.ts
private applyCommit(writes: Write[]): CommitResult {
	this.beforeCommit();
	return this.db.transaction(() => {
		const firstSeq = readNextSeq(this.db);
		const prepared = prepareStorageCommit(writes, firstSeq, this.now());
		for (const write of prepared.writes) {
			// … unchanged: entry / usage / value / list, including incrementMessageCount
			//    and addUsageToSessionStats, which already write the stats row here.
		}
		advanceNextSeq(this.db, firstSeq + prepared.writes.length);
		// Read AFTER the loop and INSIDE the transaction: it must observe this commit's own
		// increments, and it must be atomic with them. Reading outside would race the next
		// queued commit and could report totals that include writes this caller never made.
		return { ...prepared.result, stats: readSessionStats(this.db) };
	});
}
```

The event shape is fixed by `agent-harness.ts` and must be emitted exactly:

```ts
| { type: "usage"; lane: string; row: UsageRow; totals: Usage }
```

There is no `runId` field, and `row` is a complete `UsageRow` **including its committed `seq`**. But `insertUsage` takes `Omit<UsageRow, "seq">` — storage assigns the seq. `prepareStorageCommit` assigns `seqs[i] = firstSeq + i` for `writes[i]`, so a write's committed seq is `commit.seqs[<its index in the writes array>]`. Name that index; do not recompute it from `firstSeq`:

```ts
const usageRow: Omit<UsageRow, "seq"> = { id: usageId, usage: response.usage, entryId: responseEntryId, adjustment: false };

const writes: Write[] = [
	insertEntry(responseEntry),                                       // 0
	insertUsage(usageRow),                                            // 1
	setValue(branchTip(lane.name), responseEntryId),             // 2
	deleteList(pendingAssistantFrames(drive.operationId, responseEntryId)),
	setValue(operationStateValue(drive.operationId), nextState),
];
const ENTRY_WRITE = 0;
const USAGE_WRITE = 1;

return {
	kind: "commit", writes,
	next: { ...state, operation: { meta: operation.meta, state: nextState } },
	materialize: (): ProcedureResult => ({ kind: "continue" }),
	events: (commit) => [
		{ type: "entry_added", lane: lane.name,
		  entry: { ...responseEntry, seq: commit.seqs[ENTRY_WRITE], timestamp: commit.timestamp } },
		{ type: "usage", lane: lane.name,
		  row: { ...usageRow, seq: commit.seqs[USAGE_WRITE] },
		  totals: commit.stats.usage },      // exact totals as of THIS commit, synchronously
	],
};
```

Cross-lane ordering is first the sole Session mutation line and then the storage commit queue: two lanes committing usage observe two different snapshots in commit order, and the later one includes the earlier. A consumer keeping the greatest `row.seq` it applied therefore never regresses totals (harness.md §5.5).

**Fabricated `CommitResult` literals must be inventoried**, because adding a required field breaks every hand-written one. Current sites:

| Site | Literal |
|---|---|
| `test/harness/types.test.ts:375`, `:388` | structural type `Promise<{ firstSeq: number; seqs: number[]; timestamp: number }>` — add `stats: SessionStats` |
| `test/harness/instrumented-storage.test.ts:58`, `:62`, `:74` | `{ firstSeq: 1, seqs: [1], timestamp: 10 }` — add `stats` |

Audit for any others with `grep -rn "firstSeq" packages/agent/src packages/agent/test` and fix every match before `npm run check`.

---

## 3. Milestones

Every milestone uses the same subsections. Public drive stays disabled until M8.

### Guard that keeps public drive disabled (M1–M7)

`runtime/lane.ts` keeps throwing `SliceNotImplemented` from `drive`, `requestAbort`, `prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`, `resume`, `abort`, `steer`, `followUp`, `nextRun`, `cancelQueued`, `recordUsage`, `waitForIdle`, `runWhenIdle`, and from `accept({ kind: "compaction" })` / `accept({ kind: "navigation" })`. `requestAbort` stays guarded through M7 even though its primitive lands there: a durable `cancel_requested` marker on an operation that nothing can drive has no exit. Procedures are exercised with a concrete `Lane` and `Drive` constructed in each focused test against directly constructed durable state. **M8 removes those throws in one commit**, after every phase and reconciliation path exists.

---

### M0 — Remove breakpoints and manual drive (independently committable)

**Goal.** No breakpoint or manual-drive concept anywhere. No behavior added.

**Read completely before editing**
- `packages/agent/src/harness/execution/breakpoint.ts`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/runtime/{lane,types,harness}.ts`
- `packages/protocol/src/harness.ts`, `packages/protocol/src/codec.ts`
- `packages/coding-agent/src/experimental/harness-wire-adapter.ts`
- `packages/agent/test/harness/execution-primitives.test.ts`, `test/harness/types.test.ts`
- `packages/protocol/test/protocol.test.ts`, `packages/coding-agent/test/experimental-harness-wire-adapter.test.ts`
- `packages/agent/docs/harness.md` §4.1, §4.2, §4.5, §4.6, §4.7, §5.1, §5.2, §5.4, §9.1, §9.3, glossary

**Delete**
- `packages/agent/src/harness/execution/breakpoint.ts`

**Create** — none.

**Modify**
| Path | Symbols/sections |
|---|---|
| `src/harness/agent-harness.ts` | `ActionInfo`, `ActionRequired`; `ActionRequired` member of `RunOutcome`/`CompactionOutcome`/`NavigationOutcome`; `action_required` member of `DriveOutcome`; `SettledResumeOutcome`; `Exclude<…, ActionRequired>` in `TerminalOperationOutcome`; `LaneSnapshot.operation.action`; `AgentLane.peekAction`/`executeAction`/`runToCompletion`; `AgentHarnessOptions.drive` |
| `src/harness/runtime/types.ts` | `Config.drive` |
| `src/harness/runtime/harness.ts` | `drive: options.drive ?? "automatic"` |
| `src/harness/runtime/lane.ts` | the three action-method stubs |
| `packages/protocol/src/harness.ts` | `ActionInfoSchema`; `action_required` member of `RunValueSchema`; optional `action` on the operation snapshot schema |
| `packages/coding-agent/src/experimental/harness-wire-adapter.ts` | `case "action_required":` |
| `packages/agent/docs/harness.md` | sections listed above |
| `packages/agent/docs/work-packages/{02-atomic-run-acceptance,03-remove-drive-deadlines,04-mutation-publication}.md` | forward-looking pointers only |
| `packages/agent/CHANGELOG.md`, `packages/protocol/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md` | Breaking/Removed entries |

**Behavior/invariants landed.** `AgentLane` has no manual-action surface; `DriveOutcome` is `settled | waiting`; no wire schema carries `ActionInfo`.

**Focused tests to create/modify**
| Path | Theme |
|---|---|
| `test/harness/execution-primitives.test.ts` | delete `describe("Breakpoint")` + import; keep gate/hooks/events blocks |
| `test/harness/types.test.ts` | `DriveOutcome["kind"]` → `"settled" \| "waiting"` |
| `packages/protocol/test/protocol.test.ts` | drop the `action_required` fixture; add a decode-rejection case |
| `packages/coding-agent/test/experimental-harness-wire-adapter.test.ts` | drop the `action_required` fixture |

**Commands**
```bash
npm run check
./test.sh
grep -rn "Breakpoint\|action_required\|ActionInfo\|ActionRequired\|peekAction\|executeAction\|runToCompletion\|SettledResumeOutcome" \
  packages/*/src packages/*/test packages/agent/docs/harness.md
```
Only `packages/coding-agent/src/core/cache-stats.ts` (comment) and vendored `highlight.min.js` may match.

**Do not implement yet.** No `Drive`, no `Gate`, no drive procedures.

**Exit condition / review questions.** Grep clean; `npm run check` and `./test.sh` pass; changelogs updated. Did any removed sentence carry a durability requirement that must be kept in reworded form?

**Protocol version decision.** `PROTOCOL_VERSION` is **not** bumped: `action_required` was reachable only through manual drive, which never shipped enabled, so no producer emitted it. Record the decision in `packages/protocol/CHANGELOG.md`.

---

### M1 — Foundations (review checkpoint)

**Goal.** Ownership record, gate, progress, generic parameters, commit-boundary totals, deterministic test harness. Nothing drives.

**Read completely before editing**
- `src/harness/execution/effect-gate.ts`, `src/harness/hooks.ts`
- `src/harness/runtime/{lane,types,harness,restore}.ts`
- `src/harness/session/{values,types,session,commit,in-memory-storage-state,memory}.ts`
- `src/harness/session/jsonl/storage.ts`
- `src/harness/session/testing/{storage-decorator,instrumented-storage,index}.ts`
- `src/harness/session/testing/conformance/storage.ts`
- `packages/agent/src/index.ts` (confirm it exports no `runtime` module, §2.11)
- `test/harness/runtime/test-utils.ts`, `test/harness/instrumented-storage.test.ts`, `test/harness/types.test.ts`

**Delete** — none.

**Create**
- `src/harness/session/testing/gating-storage.ts` — `GatingStorage` (§2.10)
- `src/harness/runtime/progress.ts` — `ProgressChannel`, `openFrameProgress`, `openToolProgress` (§2.7)
- `test/harness/gating-storage.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/execution/effect-gate.ts` | add `Gate`, `GateControl`, `createGate()`, `DriveAbandoned` (§2.2); keep `AbortRequested`; retire `EffectGate.assertOpen` from the procedure-facing surface |
| `src/harness/hooks.ts` | `runWithGate`/`runToolWithGate` accept `Gate` and use `admit` |
| `src/harness/result.ts`, `src/harness/agent-harness.ts` | keep tagged/runtime errors in the dependency-neutral result module and re-export them from `agent-harness.ts`; this lets `agent-harness.ts` directly wire `createAgentHarness` while concrete Lane imports remain order-independent |
| `src/harness/runtime/types.ts` | add the `Drive` class (completion, gate control, stripped pass Context, installer signal, wait policy, mutable `deferredPermits`, mutable `finalizedOutcome`) and the initial procedure-result union, simplified in M2; move `LaneCommand<TResult>` here from `lane.ts` |
| `src/harness/runtime/lane.ts` | make the class `Lane<TContext extends object | undefined>`; expose package-internal `session`, `models`, `hooks`, `emitBatch`, `command`, `readConfig`, and `mismatch` for direct procedure use; add package-internal `activeDrive: Drive | undefined` and `isDriveActive(drive)`; import `LaneCommand` from `types.ts`; remove the obsolete `AcceptanceConfig` type |
| `src/harness/runtime/harness.ts` | `Harness<TContext>` manages ordinary `Lane<TContext>` objects by composition; `buildLane` returns `Lane<TContext>`; pass `HookRegistry` and full `Config` into each Lane |
| `src/harness/runtime/restore.ts` | name `Lane<TContext>` wherever it names `Lane` |
| `src/harness/session/types.ts` | add `stats: SessionStats` to `CommitResult` (§2.12) |
| `src/harness/session/commit.ts` | `PreparedCommit.result` becomes `Omit<CommitResult, "stats">` |
| `src/harness/session/in-memory-storage-state.ts` | `InMemoryStorageState.applyValidated` returns the post-apply `SessionStats` for Memory and JSONL |
| `src/harness/session/memory.ts`, `src/harness/session/jsonl/storage.ts` | compose `{ ...prepared.result, stats }` |
| `packages/session-backends/sqlite-node/src/sqlite/storage.ts` | return `{ ...prepared.result, stats: readSessionStats(this.db) }` from **inside** the `db.transaction` closure (§2.12) |
| `packages/session-backends/sqlite-node/test/storage-conformance.test.ts`, `packages/session-backends/sqlite-node/test/storage.test.ts` | SQLite conformance plus a post-write-snapshot assertion |
| `src/harness/session/testing/conformance/storage.ts` | assert commit-result totals against `getStats`, including after reopen |
| `test/harness/types.test.ts` | the two structural `CommitResult` literals at `:375` and `:388` gain `stats: SessionStats` (§2.12) |
| `test/harness/instrumented-storage.test.ts` | the three fabricated literals at `:58`, `:62`, `:74` gain `stats` (§2.12) |
| `src/harness/session/session.ts` | make `idGenerator` injectable through constructor options (**named API change**; alternative: canonical id normalization in tests) |
| `src/harness/session/testing/index.ts` | export `GatingStorage`, `CommitDiscarded` |
| `test/harness/runtime/test-utils.ts` | construct concrete `Lane<TContext>` and `Drive` objects directly; name concrete contexts wherever a Lane is constructed |

**Behavior/invariants landed.** `admit` is the only gate check; `GateControl` is owner-held; progress `drain()` propagates write failures; `GatingStorage` parks, waits, releases, and discards deterministically, and after `discard()` no commit reaches the backend by any path; `CommitResult.stats` reports exact post-commit session totals seeded from storage state; `Lane`/`Harness` remain generic in `TContext`; `Drive` is context-type independent; no `any`.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/gating-storage.test.ts` | setup bypass; `waitPending()` resolves for a commit parked after the call; FIFO `next()` resolves only after the released commit lands; `pending()`; `discard()` rejects parked commits **and** every later commit with `CommitDiscarded`, including an unarmed one; composition order with `InstrumentedStorage` |
| `test/harness/execution-primitives.test.ts` | `createGate` admit/abort/close; `DriveAbandoned` distinct from `AbortRequested` |
| `test/harness/types.test.ts` | `CommitResult` carries `stats`; the published surface is unchanged — `AgentLane`/`AgentHarness` gain no member from `Lane` |
| `src/harness/session/testing/conformance/storage.ts` | `commit(…).stats` equals `getStats()` after each commit; totals after reopen include historical usage |

**Commands.** `npm run check` · `./test.sh`

**Do not implement yet.** No phase procedures, no `drive.ts`, no `runDrive`, no public wiring.

**Exit condition / review questions.** Gate has no `assertOpen` reachable from procedures. Can any commit reach the backend after `discard()`? Does `next()` ever resolve before the write landed? Is there a single `any` or variance widening introduced by the generic change? Is `idGenerator` injection or normalization decided and recorded?

---

### M2 — Terminal mechanics and bounded hydration

**Goal.** Land only the mechanical pieces used by terminal commands. No procedure finishes an operation in M2; each later phase-owning procedure writes its terminal transaction inline when that phase lands.

**Read completely before editing**
- `src/harness/session/types.ts` (`OperationState`, `LaneLastResult`; `TerminalOperationOutcome` in `agent-harness.ts`)
- `src/harness/session/values.ts` (all operation cleanup prefix constructors)
- `src/harness/runtime/{lane,types,restore,progress}.ts`
- `test/harness/runtime/{harness,watch,restore}.test.ts`

**Create**
- `src/harness/runtime/drive/terminal.ts` — `operationCleanupWrites`, `hydrateTerminalOutcome` (§2.9)
- `test/harness/runtime/drive-terminal.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime/types.ts` | replaced global `StepResult.advance/reload` with `ProcedureResult.continue`; retained waiting, settled, and lost ownership (§2.4) |
| `src/harness/runtime/lane.ts` | add `commandDriveOwned`, with exact-Drive identity checked immediately before commit admission (§2.5); document `state` as the live control authority |
| `src/harness/runtime/progress.ts` | use the planner's current `LaneState` and `commandDriveOwned`; remove durable lane/operation control reads (§2.7) |
| `src/harness/session/session.ts` | document retained mutators as forbidden while a harness owns the Session; no runtime compatibility layer |

**Behavior/invariants landed.** A live `Lane.state` is the sole control-flow authority. Process loss restores it from durable values. Runtime reads dereference payloads only. Exact-Drive replacement between planner return and commit admission declines the commit. Cleanup enumerates every operation-owned address through typed prefix scans and concrete deletes; `pendingNextRun` is not cleanup-owned. Hydration reads only the bounded latest-result value and entries it directly names.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/lane.test.ts` | exact owner replaced after an async planner returns but before commit admission → no write; commit admitted first → write and projection publish complete before replacement |
| `test/harness/runtime/progress.test.ts` | current projection permits matching frame/tool progress; terminal or phase movement first → queued write declines; no durable control reads |
| `test/harness/runtime/drive-terminal.test.ts` | cleanup completeness for run, compaction, navigation, including leftovers and exact live frame list; `pendingNextRun` excluded; bounded hydration equality for directly constructed latest-result values per kind |
| `test/harness/runtime/restore.test.ts` | required durable projection absence/contradiction remains attachment corruption; a stored null tip remains valid |

**Commands.** `npm run check` · targeted vitest for every modified test file

**Do not implement yet.** No terminal commit procedure, synthetic recovery, switch, generation, or public wiring.

**Exit condition / review questions.** Does any supported control write bypass the owning Lane? Is exact Drive identity adjacent to commit admission? Does terminal.ts contain anything beyond mechanical cleanup and bounded hydration?

### M3 — Generation (review checkpoint)

**Goal.** `starting → checkpoint → assistant ready → intent → stream → settlement`, frames, configuration failure.

**Read completely before editing**
- `src/harness/execution/assistant.ts` (full), `src/harness/hooks.ts`
- `src/harness/session/context.ts`, `src/harness/messages.ts`, `src/harness/system-prompt.ts`
- `src/harness/compaction/compaction.ts` (settings only)
- `test/harness/execution-assistant.test.ts`

**Create**
- `src/harness/runtime/drive/checkpoint.ts` — `startRun`, `runCheckpoint`
- `src/harness/runtime/drive/generation.ts` — `runGeneration`, `settleAssistant`, `enterConfigurationFailure` (§2.6)
- `src/harness/runtime/drive/recovery.ts` — synthetic interrupted-assistant settlement from committed frames, owned beside generation classification
- `test/harness/runtime/drive-generation.test.ts`

**Do not create `drive.ts` here.** A switch written now would have to import `drive/deferred.ts` (M4), `drive/tools.ts` (M5), `drive/structural.ts` (M6), and `drive/reconcile.ts` (M7), none of which exist — the package would not compile, and stubbing those modules to make it compile would create exactly the half-built graph this plan forbids. `Drive` lives in `runtime/types.ts` from M1 and `ProcedureResult` from M2, so procedures compile and are tested standalone. `drive.ts` is created once, in M7.

**Modify**
| Path | Change |
|---|---|
| `src/harness/execution/assistant.ts` | use provider-facing `Tool` declarations; observer callbacks receive trailing Context, and `start` receives the actual start event; pre-generation errors synthesize no start, while updates or successful completion before start are protocol defects; the runtime request adapter admits `Models.streamSimple` through `Gate` |

**Behavior/invariants landed.** Preparation precedes intent; ids reserved at intent and honoured at settlement; frames enqueued synchronously without per-frame awaits; settlement deletes the frame list; every transition plans from the current owned projection and publishes its exact next projection; checkpoint separates tree parent/tip from `triggerEntryId` for unprojected custom writes.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/drive-generation.test.ts` | each procedure invoked directly with a concrete `Lane` and `Drive`, no switch; intent before provider; reserved-id settlement; frame order without storage awaits; orphan recovery without provider call; mixed projecting/unprojected drains (tip vs trigger); queued inbox mutation before intent → intent commits while preserving it; cancellation before intent → procedure returns `continue` and commits nothing; fence taken by another operation → returns `lost_ownership` and commits nothing; published projection equals fresh restore |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** `drive.ts`, retry, deferred, tools, structural, reconciliation, public wiring.

**Exit condition / review questions.** Does any planner throw for an expected verification failure? Does any procedure start an effect on a path whose intent did not commit? Does any procedure derive state from a pre-job snapshot? Does `packages/agent/src/harness/runtime/` contain any module importing a file that does not exist yet?

---

### M4 — Retry and deferred

**Goal.** Durable waiting.

**Read completely before editing**
- `src/harness/session/types.ts` (`Generation.retry_wait`, `Deferred`)
- `src/harness/config.ts` (`validateRetryPolicy`, normalization)
- `src/harness/agent-harness.ts` (`DriveOptions.waitForRetry`, `pollDeferred`, `DriveOutcome.waiting`)

**Create**
- `src/harness/runtime/drive/deferred.ts`
- `test/harness/runtime/drive-retry-deferred.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime/drive/generation.ts` | retry classification → `retry_wait`; `waitForRetry` policy |
| `src/harness/runtime/drive/deferred.ts` | `drive.deferredPermits` consumption lives with the deferred procedure. **Do not touch `drive.ts`** — it does not exist until M7 |

**Behavior/invariants landed.** No durable armed poll state: `suspended` never becomes a durable pollable `ready`; the permit is consumed by the **fresh intent commit** that reserves new ids; a crash before that commit leaves `suspended` at the same poll number; an unknown-outcome poll does not consume a poll, deletes the old frame list, and mints fresh ids next poll; an unknown-outcome structural attempt *does* consume an attempt.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/drive-retry-deferred.test.ts` | waiting outcomes; permit consumption point; crash before intent stays suspended; unknown-outcome poll number and id freshness; pass-local permit never mutates caller options |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Tools, structural, reconciliation, public wiring.

**Exit condition / review questions.** Can any durable state poll without a permit?

---

### M5 — Tools (review checkpoint)

**Goal.** The complete tool batch.

**Read completely before editing**
- `src/harness/execution/tools.ts` (full), `src/harness/types.ts`
- `src/harness/tools/{bash,tool-context,index}.ts`
- `src/types.ts` (`AgentToolResult`, `AgentToolUpdateCallback`, `addedToolNames`)
- `test/harness/execution-tools.test.ts`, `test/harness/tools.test.ts`

**Create**
- `src/harness/runtime/drive/tools.ts` (§2.8)
- `test/harness/runtime/drive-tools.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/types.ts` | add `AgentHarnessToolUpdateOptions { checkpoint?: true }` — the literal `true`, not `boolean`, because `false` and absent mean the same thing — and `AgentHarnessToolUpdateCallback` (§2.11); add memo accessors to `AgentHarnessToolInvocation` (**named API change**: these are referenced by the spec but absent today) |
| `src/harness/execution/tools.ts` | admit `execute` through `Gate`; thread invocation + update options |
| `src/harness/tools/bash.ts` | keep `BASH_UPDATE_THROTTLE_MS = 100`; add a distinct checkpoint cadence of at most one per 2 s, only when the bounded snapshot changed |

**Behavior/invariants landed.** Clearance order lookup → `prepareArguments` (ungated, throw normalizes to a synthetic error) → `before_tool` → argument intent commit; missing tools stage detail-free synthetic results; `toolContext` resolved once per batch; memos under `operationToolMemo`, deleted by staging; per-invocation update + checkpoint drain before `after_tool`; local started map; current-state patching; completion-order staging with source-order materialization; `addedToolNames` effective only at placement; abort after admission unwinds the batch.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/drive-tools.test.ts` | sequential and parallel two-call batches preserving sibling status; out-of-order completion → source-order placement; safe replay re-executes, unsafe does not; `outcome_ready` never re-executes; memo lifetime; checkpoint cadence; drain before `after_tool`; `addedToolNames` at placement; abort after admission |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Structural, reconciliation, public wiring.

**Exit condition / review questions.** Does any status patch read a batch captured before its job?

---

### M6 — Structural and navigation

**Goal.** Compaction (threshold/overflow/manual) and navigation.

**Read completely before editing**
- `src/harness/compaction/{compaction,branch-summarization,utils}.ts`
- `src/harness/session/types.ts` (`StructuralDecision`, `SummaryGeneration`, `SummaryContext`, `NavigationState`)
- `test/harness/{compaction,branch-summarization}.test.ts`

**Ownership split (approved).** `runtime/drive/structural.ts` owns **all** persistence: the preparation row, the decision, request intent rows, usage writes, the result entry, and the terminal transaction. The compaction modules stay pure generators of summary text and keep their existing behavior for their existing callers; they gain one seam so the runtime can wrap each provider call with commit intent → `gate.admit` → commit usage.

Today `compact()`, `generateSummaryWithUsage()`, and the private `generateTurnPrefixSummary()` each call `completeSimpleWithRetries(models, model, …)` directly, and `generateBranchSummary()` does the same through `GenerateBranchSummaryOptions`.

**The seam must be one provider request, not one retrying call.** `completeSimpleWithRetries` wraps `models.completeSimple` in `retryAssistantCall`, so wrapping *it* would put a whole retry loop inside a single durable intent: several billed requests would settle against one reserved `usageId`, and a crash mid-loop would leave an attempt whose cost the ledger cannot attribute. harness.md §3.9 is explicit that each nested request commits its own `request:{index,usageId}` and then atomically writes usage and clears the field.

So the runtime disables the helper's internal retry and owns **whole-attempt** retries itself through the durable `SummaryGeneration` states (`ready` → `effect_pending` → `retry_wait`), which is where the captured policy already lives.

```ts
// packages/agent/src/harness/compaction/compaction.ts

/** Identifies a nested request within one structural attempt, so its intent row is deterministic. */
export type NestedRequestLabel = "history" | "turn_prefix" | "branch";

/** Executes exactly ONE provider request. No retry inside — the caller owns that. */
export type NestedRequest = (
	label: NestedRequestLabel,
	aiContext: AiContext,
	options: SimpleStreamOptions,
	context: Context,
) => Promise<AssistantMessage>;

/** Default for existing callers: preserves today's in-helper retry behavior exactly. */
export function retryingNestedRequest(
	models: Models, model: Model<Api>,
	retry: RetryPolicy | undefined, callbacks: RetryCallbacks | undefined,
): NestedRequest {
	return (_label, aiContext, options, context) =>
		completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, context);
}
```

The drive implementation supplies its own, and each call is one intent, one admitted request, one usage commit. **It must reproduce every option `completeSimpleWithRetries` sets**, because dropping the seam below that function also drops the option composition it performs. Today that body is:

```ts
// current packages/agent/src/harness/compaction/compaction.ts — for reference
const requestOptions: SimpleStreamOptions = {
	...options,
	signal: context.abortSignal,
	telemetryContext: context.telemetryContext,
	cacheRetention: "none",        // summaries are standalone; cache writes cannot be reused
	sessionId: uuidv7(),           // isolate routing, fresh per request
};
```

So the drive runner composes the same four, with the signal and telemetry parent taken from the **admitted** context rather than the ambient one:

```ts
// packages/agent/src/harness/runtime/drive/structural.ts — sketch
const request: NestedRequest = async (label, aiContext, options, context) => {
	const index = nextRequestIndex(label);                       // 0 for history, 1 for turn_prefix
	const usageId = lane.session.idGenerator.next();
	const intent = await commitRequestIntent(lane, drive, taskId, index, usageId);
	// NestedRequest has no return channel for a declined intent, so this module-local
	// signal unwinds to the structural procedure without starting the provider.
	if (intent.kind !== "committed") throw new StructuralAttemptDeclined(intent);

	// Preparation finishes here, BEFORE the gate check, so admit() and the Models call stay
	// adjacent (harness.md §4.2). The admitted context composes the invocation signal with
	// the operation gate's signal.
	const admitted = withAbortSignal(drive.gate.signal, context);
	const requestOptions: SimpleStreamOptions = {
		...options,
		signal: admitted.abortSignal,
		telemetryContext: admitted.telemetryContext,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};

	// ONE request. No retry here: a retryable failure unwinds to the attempt level, which
	// commits retry_wait and starts a later numbered attempt (harness.md §3.9).
	const message = await drive.gate.admit(() =>
		lane.models.completeSimple(model, aiContext, requestOptions));

	await commitRequestUsage(lane, drive, taskId, usageId, message.usage);
	return message;
};
```

**`completeSimple` is the correct call here — do not "upgrade" it to `streamSimple`.** `packages/ai/src/models.ts` defines `completeSimple` as `this.streamSimple(model, context, options).result()`, so it is the same request with the same options, the same provider dispatch, and the same abort path. It also returns a started request synchronously from inside the closure, so `admit()` adjacency (harness.md §4.2) is identical.

The difference that matters is what it does **not** hand you. harness.md §3.9 requires structural streams to emit no public assistant-message lifecycle and persist no `pendingAssistantFrames` list. Because `completeSimple` never yields the event stream, that prohibition cannot be violated by accident — which is a stronger guarantee than a comment next to a stream telling the next implementer not to use it. Should structural diagnostics ever be wanted, §3.9 already states the shape: a separate, explicitly scoped consumer, not a silent reuse of transcript-assistant semantics.

The default `retryingNestedRequest` keeps calling `completeSimpleWithRetries` unchanged, so existing callers are byte-identical and the two paths cannot diverge.

```ts
// packages/agent/src/harness/runtime/drive/structural.ts — module-private, never exported.

/** A NestedRequest cannot return without an AssistantMessage, so a declined local intent
 * unwinds to the owning structural procedure. This signal never escapes the module. */
type StructuralIntentDecline = { kind: "state_changed" } | LostOwnership;
class StructuralAttemptDeclined extends Error {
	readonly result: StructuralIntentDecline;
	constructor(result: StructuralIntentDecline) {
		super(`Structural request intent declined: ${result.kind}`);
		this.name = "StructuralAttemptDeclined";
		this.result = result;
	}
}

type StructuralIntentResult = { kind: "committed" } | StructuralIntentDecline;
declare function commitRequestIntent<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive, taskId: string, index: number, usageId: string,
): Promise<StructuralIntentResult>;

async function runStructuralAttempt<TContext extends object | undefined>(
	lane: Lane<TContext>, drive: Drive, operation: Operation, decision: StructuralDecision,
): Promise<ProcedureResult> {
	try {
		const result = await compact(preparation, lane.models, model, customInstructions,
			thinkingLevel, /* retry */ undefined, /* callbacks */ undefined, drive.context, request);
		return await publishStructuralResult(lane, drive, operation, decision, result);
	} catch (error) {
		if (error instanceof StructuralAttemptDeclined) {
			return error.result.kind === "lost_ownership"
				? error.result
				: { kind: "continue" };
		}
		throw error; // AbortRequested, OperationEnded, provider errors
	}
}
```

The throw site is the only one: `if (intent.kind !== "committed") throw new StructuralAttemptDeclined(intent);`

A test must pin the option composition: assert the options reaching a faux `Models.completeSimple` from the drive path carry `cacheRetention: "none"`, a **distinct** `sessionId` per request within one split-turn attempt, the gate-composed signal, and the invocation telemetry parent — and that they match what `retryingNestedRequest` produces for the same input apart from the signal source. Assert also that no `message_start`/`message_update`/`message_end` event is emitted and no `pendingAssistantFrames` address is written during a structural attempt.

Split-turn compaction makes two such calls — `"history"` then `"turn_prefix"` — so it produces two intents and two usage rows, which is exactly what harness.md §3.9 requires (`usageIds` accumulates). `AssistantMessage` already carries `usage`, so the runner persists what it needs without the compaction code knowing about storage.

**Create**
- `src/harness/runtime/drive/structural.ts`
- `test/harness/runtime/drive-structural.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime/drive/checkpoint.ts` | threshold check keyed by `thresholdCheckedTriggerEntryId` |
| `src/harness/compaction/compaction.ts` | add `NestedRequestLabel`, `NestedRequest`, `retryingNestedRequest`; add an **optional trailing** `request?: NestedRequest` parameter to `compact()`, `generateSummaryWithUsage()`, and the private `generateTurnPrefixSummary()`. Each replaces its `completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, context)` call with `(request ?? retryingNestedRequest(models, model, retry, callbacks))(label, aiContext, options, context)`, label `"history"` in `generateSummaryWithUsage` and `"turn_prefix"` in `generateTurnPrefixSummary`; `compact()` threads its `request` into both. `models`/`model` stay — they are still needed for `maxTokens`/`contextWindow` budgeting. **No persistence here**: `compaction.ts` never writes `operationPreparation` or any other value |
| `src/harness/compaction/branch-summarization.ts` | add optional `request?: NestedRequest` to `GenerateBranchSummaryOptions`, defaulted in the destructuring in `generateBranchSummary` to `retryingNestedRequest(models, model, retry, callbacks)`, label `"branch"` |
| `src/harness/runtime/drive/structural.ts` | owns **all** persistence: writes `operationPreparation(operationId, taskId)` before the decision hook and revalidates it against its source on resume; commits each request intent and usage; commits the result entry and the terminal transaction |

The parameter is optional and defaulted precisely so existing callers are untouched and keep in-helper retry: `packages/coding-agent/src/core/agent-session.ts` (`compact(…)` at the compaction path and `generateBranchSummary(…)`) and `packages/agent/test/harness/compaction.test.ts` compile and behave identically. Only `drive/structural.ts` passes a `request`, and when it does, `retry` is left `undefined` so no retry can happen below the attempt level.

**Behavior/invariants landed.** Preparation written before the decision hook and revalidated on resume; each nested request commits intent (index + reserved `usageId`), is admitted through the gate, then atomically writes usage and clears the request; crash after request one leaves the row and an uncertain attempt; an unknown-outcome attempt consumes an attempt; model disappearance between split requests fails in band; result entry id reserved once; standalone publication and terminal end share one transaction; in-run compaction resumes the stored checkpoint; threshold considered at most once per boundary; structural retry waiting is gated and its policy stated.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/drive-structural.test.ts` | threshold once per boundary; decline/success/crash resume; **one intent and one usage row per provider request**, asserted through `InstrumentedStorage` for a split-turn attempt (two of each, not one); a retryable failure inside an attempt produces **zero** extra provider calls before the attempt-level `retry_wait` commit; crash after request one leaves its usage row and an uncertain attempt; model disappearance between requests fails in band; unknown attempt consumption; preparation written and revalidated by `drive/structural.ts` only; navigation with and without summary |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Reconciliation, public wiring.

**Exit condition / review questions.** Is any structural state reachable without a driver?

---

### M7 — Reconciliation and lifecycle (review checkpoint)

**Goal.** Abort, close, fault, external finalization. Graph becomes total.

**Read completely before editing**
- `src/harness/runtime/harness.ts` (`fault`, `close`), `src/harness/runtime/lane.ts` (`seal`)
- `src/harness/events.ts`, `src/harness/context.ts`
- `packages/agent/docs/harness.md` §4.6, §4.7, §4.9

**Create**
- `src/harness/runtime/drive/reconcile.ts` — reconciliation per phase **and** the package-private cancellation primitive `requestOperationAbort(lane, operationId, context)`
- `src/harness/runtime/drive.ts` — the total switch: `runDrive`, `hydrateSettled`, `dispatch`, `dispatchRun` (§2.4). Created **here**, not earlier, because this is the first milestone at which every module it imports (`checkpoint`, `generation`, `deferred`, `tools`, `structural`, `reconcile`, `terminal`, `recovery`) exists
- `test/harness/runtime/drive-reconcile.test.ts`
- `test/harness/runtime/drive-lifecycle.test.ts`
- `test/harness/runtime/drive-switch.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime/lane.ts` | add package-internal `startDrive`, exact `removeDrive`, `abandonDrive`, finalization notification, and seal behavior; lifecycle tests call these directly with an installed `Drive`. `Lane.requestAbort` and public `drive` keep their `SliceNotImplemented` guards until M8 |
| `src/harness/runtime/harness.ts` | fault seals owners; close detaches non-cooperative effects |

**External finalization — owner notification (approved).** harness.md §4.9 requires the in-process finalizer to notify a live owner *immediately after* the terminal commit, not to let it discover the loss later. Discovery-only would let the task keep a provider stream or tool running until its next lane job, and would risk a second end event.

```ts
// packages/agent/src/harness/runtime/lane.ts
/** Package-internal M7 lifecycle seam; not part of AgentLane. */
interruptOwnerForFinalization(
	operationId: string, outcome: TerminalOperationOutcome,
): Drive | undefined {
	const drive = this.activeDrive;
	if (drive === undefined || drive.operationId !== operationId) return undefined;

	const settled: DriveOutcome = { kind: "settled", operationId, outcome };
	drive.finalizedOutcome = settled;             // before OperationEnded can reach runDrive
	drive.closeGate(new OperationEnded());         // stop/detach work immediately after commit
	// Do not remove here: ownership spans event delivery and any remaining pass work.
	return drive;                                  // finalizer settles it after event delivery
}

settleOwnerAfterFinalization(drive: Drive, outcome: DriveOutcome): void {
	// Called only after the finalizer's Lane.command delivered its terminal event.
	if (drive.passEnded) this.removeDrive(drive);
	drive.settle(outcome);
}

/** Package-internal M7 lifecycle seam; exercised through startDrive cancellation tests. */
abandonDrive(drive: Drive, error: DriveAbandoned): void {
	if (drive.finalizedOutcome !== undefined) return; // finalization already chose retained cleanup
	drive.closeGate(error);
	drive.fail(error);                             // shared pass completion; every joiner retries
	this.removeDrive(drive);                       // replacement may recover effect_pending now
}
```

Both methods run on `Lane`; procedures do not remove ownership. The external finalizer calls `interruptOwnerForFinalization` from its committed `materialize`, returns that owner in its internal command result, and calls `settleOwnerAfterFinalization(owner, { kind: "settled", operationId, outcome })` only after `Lane.command` has delivered the terminal event. If the pass ended first, this removes before settling; if event delivery/settlement happened first, pass `finally` removes later. Until both happen, same-id callers join the retained Drive rather than hydrating early.

`OperationEnded` is added to `execution/effect-gate.ts` alongside `AbortRequested` and `DriveAbandoned`. A non-cooperative effect that ignores the pulled signal is **observed and detached** under the same policy as close (§4.7): the pass does not block on it, and its later rejection is observed so it produces no unhandled rejection. It can no longer commit — every drive-owned commit is fenced by the current projection and exact Drive identity at commit admission.

**Behavior/invariants landed.** `requestOperationAbort` order: `beginAbort` → interrupt → commit marker → `signalAbort`. `runDrive` inspects the current owned operation and its control status **before** `before_drive`, and skips `before_drive` entirely when the operation is already `cancel_requested` — that pass only reconciles. Reconciliation walks `assistant.effect_pending`, `deferred`, `tools` (mixed statuses), `compaction`, `checkpoint`, `failure_drain`. Invocation cancellation (`DriveAbandoned`) never writes durable cancellation. A `lost_ownership` step terminates the pass immediately and writes nothing more. Close writes no synthetic settlement, does not block on a non-cooperative effect, and produces no unhandled rejection. External finalization interrupts the owner synchronously after the terminal commit, delivers the terminal event, then settles it; the old task stops without writing and resolves from `finalizedOutcome` (falling back to `laneLastResult` when it was finalized by a replacement process), and emits no duplicate terminal event.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/drive-reconcile.test.ts` | `requestOperationAbort` exercised directly with a concrete `Lane` and `Drive`, not through `Lane.requestAbort`; abort before/after admission at each admit site; mid-batch abort; reconciliation per phase; `aborted` response always under `cancel_requested` |
| `test/harness/runtime/drive-switch.test.ts` | `before_drive` runs once, after the current owned operation is inspected; `before_drive` is **not** invoked for an already `cancel_requested` operation; `continue` requires a replaced projection and re-dispatches; unchanged `continue` faults instead of spinning; `lost_ownership` ends the pass with zero further commits; external finalization → `hydrateSettled` returns the same outcome; foreign operation on the fence → `OperationMismatch` |
| `test/harness/runtime/drive-lifecycle.test.ts` | close **before** admission returns `Result.err(Closed)`; close **during** admitted work rejects `HarnessClosed` (these two are asserted separately, never with a shared loose matcher); non-cooperative effect; fault sealing; invocation cancel abandons at `effect_pending` with no durable write |
| `test/harness/runtime/drive-lifecycle.test.ts` (finalization) | finalize while a **provider stream** is active, and again while a **tool** is active; also let an effect return successfully after committed finalization but before terminal event delivery, and attempt a same-id `drive` during that delivery: the owner's gate closes and its signal fires within committed materialization; the terminal event is delivered before shared completion settles; a cooperative effect rejects with `OperationEnded` and resolves through `drive.finalizedOutcome` **without entering a lane job**, while a successful return racing event delivery reaches `lost_ownership` but still returns `finalizedOutcome`; neither path settles/fails the Drive from the pass continuation or writes after the terminal commit (asserted through `InstrumentedStorage`: zero commit attempts after the terminal one); exactly **one** `run_end` is delivered; `accept` returns `LaneBusy` until both event-delivered settlement and the owner's `finally` have occurred, then succeeds; a non-cooperative effect that ignores the signal delays nothing and produces no unhandled rejection |
| `test/harness/runtime/drive-lifecycle.test.ts` (catch boundary) | each signal from admitted work reaches its own arm and no other: `OperationEnded` → settled outcome, no second end event; `AbortRequested` → marker awaited, reconciliation runs, `aborted` under `cancel_requested`; `DriveAbandoned` → pass rejects, state stays `effect_pending`, **zero** durable writes, next drive recovers it as an orphan; `HarnessClosed` and `HarnessFault` → propagate unchanged, no synthetic settlement; `OperationMismatch` from `hydrateSettled` → propagates to `Result.err`. Every arm ends with the owner removed exactly once (§2.1 ordering) |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Public wiring (`SliceNotImplemented` guards remain on all sixteen methods, `requestAbort` included).

**Exit condition / review questions.** Is every `RunPhase`, `CompactionState`, and `NavigationState` reachable by the classifier now driveable *and* reconcilable? Does `drive.ts` import any module that does not exist? Is `Lane.requestAbort` still guarded?

---

### M8 — Public surfaces

**Goal.** Remove the guards; wire ownership and every public method.

**Read completely before editing**
- `src/harness/agent-harness.ts` (`AgentLane`, `AgentHarness`)
- `src/harness/runtime/lane.ts` (all `SliceNotImplemented` stubs)
- `test/harness/runtime/{accept,lane,harness,watch}.test.ts`

**Create**
- `test/harness/runtime/drive-ownership.test.ts`
- `test/harness/runtime/drive-surfaces.test.ts`
- `test/harness/runtime/drive-crash-matrix.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime/lane.ts` | **ordered**: (1) `accept` accepts `kind: "compaction"` and `kind: "navigation"` — today both throw `SliceNotImplemented` at the top of `accept`, so a standalone structural operation cannot be admitted at all; (2) implement the public `drive` claim/join/hydration surface (§2.3) using M7's internal lifecycle methods; `accept` returns `LaneBusy` while an owner exists; (3) expose `requestAbort` by delegating to the M7 primitive; (4) only then the convenience compositions `prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`, `resume`, `abort`, `steer`, `followUp`, `nextRun`, `cancelQueued`, `recordUsage`, `waitForIdle`, `runWhenIdle`; `inspectExecution` reports `running` when owned |
| `src/harness/runtime/restore.ts` | restore every phase projection |
| `src/harness/telemetry.ts` | drive spans |
| `src/harness/runtime/types.ts` | `SliceNotImplemented` retained only for `watchSession` |

`compact()` and `navigateTree()` are *accept + drive*, so they cannot be written before `accept` admits their operation kinds. Doing the composition first would force a second admission path that only the convenience method can reach.

**Behavior/invariants landed.** Owner-before-idle claim order; join observes delivered events; usage row `seq` from `CommitResult`, and usage-event totals read `commit.stats.usage` inside `events(commit)` — no process accumulator (§2.12); every hook/event/observation carries the emitting Context. Pi-ai's per-stream frame encoder treats provider `partial` as a shared live helper and removes already-covered queued deltas without cloning the growing message per event; the crash matrix pins synchronous shared-partial bursts. `AgentHarness.watchSession` is **explicitly deferred** and keeps its rejection.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime/drive-ownership.test.ts` | join before hydration; same-id join observes delivered events; mismatch ids. Both paths use the same result/error adapter: normal outcome → `Result.ok`; `OperationMismatch` and `Closed` → `Result.err`; `HarnessClosed`, `HarnessFault`, `DriveAbandoned` → rejection. Installer cancellation rejects installer and existing joiners with `DriveAbandoned`; joiner cancellation rejects only that joiner and leaves the Drive installed |
| `test/harness/runtime/drive-ownership.test.ts` (independent completion/removal) | run each case with a **non-cooperative provider** and again with a **non-cooperative tool** that ignores its signal and never settles. **External finalization**: after the terminal event is delivered, public completion resolves with the finalizer's outcome while the effect is still stuck; `accept` returns `LaneBusy` throughout; exactly **one** `run_end` is delivered; after the effect finally returns the owner clears and `accept` succeeds. **Invocation abandonment**: the public promise rejects `DriveAbandoned`, a new `drive` claims the lane **before** the old effect returns, durable state is still `effect_pending`, and the new pass runs orphan recovery. **Close/fault**: resolves without waiting; public promises reject `HarnessClosed`/`HarnessFault`. In every case the detached pass produces no unhandled rejection, and `Drive.settle`/`Drive.fail` and exact `removeDrive` remain idempotent |
| `test/harness/runtime/drive-ownership.test.ts` (ABA fencing) | abandon an invocation whose effect is still running, let a **replacement owner claim the same `operationId`**, then let the old effect return: its transition planner and its progress writes both decline via `isDriveActive` even though the operation id is unchanged; zero commits attributed to the old task (asserted through `InstrumentedStorage`); the replacement owner is **not** cleared by the old task's cleanup; the replacement's own commits succeed |
| `test/harness/runtime/drive-surfaces.test.ts` | `accept({kind:"compaction"})` and `accept({kind:"navigation"})` admit and drive before any convenience method is used; convenience = accept + drive; `resume`; `requestAbort` through the public method reaches the M7 primitive; `Closed` returned not thrown; listeners settle before the next procedure hook; usage totals per settlement equal `getStats()`; **reopen a session with historical usage** → the first new usage event's totals include the history; **two lanes committing usage concurrently** → each event's totals match its own commit position and the final totals equal `getStats()`; Context lineage |
| `test/harness/runtime/drive-crash-matrix.test.ts` | release N commits → discard → reopen → drive, for every N in every phase path; every gated boundary exposes its exact committed writes; gated vs ungated byte-identical writes; a provider that publishes start, block start, and deltas synchronously against one shared live partial persists a reducible non-duplicated frame sequence |

**Commands.** `npm run check` · `./test.sh`

**Do not implement yet.** `watchSession`.

**Exit condition / review questions.** Any public path reachable over a partial graph? Any `SliceNotImplemented` left besides `watchSession`? Does any usage total come from anywhere but `CommitResult.stats`?

---

## 4. File manifest

**Delete**
- `packages/agent/src/harness/execution/breakpoint.ts`

Milestone in parentheses where creation order matters.

**Create**
- `packages/agent/src/harness/runtime/drive.ts` (**M7** — not before; it imports every procedure module)
- `packages/agent/src/harness/runtime/drive/checkpoint.ts`
- `packages/agent/src/harness/runtime/drive/generation.ts`
- `packages/agent/src/harness/runtime/drive/recovery.ts`
- `packages/agent/src/harness/runtime/drive/deferred.ts`
- `packages/agent/src/harness/runtime/drive/tools.ts`
- `packages/agent/src/harness/runtime/drive/structural.ts`
- `packages/agent/src/harness/runtime/drive/reconcile.ts`
- `packages/agent/src/harness/runtime/drive/terminal.ts`
- `packages/agent/src/harness/runtime/progress.ts`
- `packages/agent/src/harness/session/testing/gating-storage.ts`
- `packages/agent/test/harness/gating-storage.test.ts`
- `packages/agent/test/harness/runtime/drive-terminal.test.ts`
- `packages/agent/test/harness/runtime/drive-generation.test.ts`
- `packages/agent/test/harness/runtime/drive-retry-deferred.test.ts`
- `packages/agent/test/harness/runtime/drive-tools.test.ts`
- `packages/agent/test/harness/runtime/drive-structural.test.ts`
- `packages/agent/test/harness/runtime/drive-reconcile.test.ts`
- `packages/agent/test/harness/runtime/drive-switch.test.ts`
- `packages/agent/test/harness/runtime/drive-lifecycle.test.ts`
- `packages/agent/test/harness/runtime/drive-ownership.test.ts`
- `packages/agent/test/harness/runtime/drive-surfaces.test.ts`
- `packages/agent/test/harness/runtime/drive-crash-matrix.test.ts`

**Modify**
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/result.ts`
- `packages/agent/src/harness/types.ts`
- `packages/agent/src/harness/hooks.ts`
- `packages/agent/src/harness/telemetry.ts`
- `packages/agent/src/harness/execution/effect-gate.ts`
- `packages/agent/src/harness/execution/assistant.ts`
- `packages/agent/src/harness/execution/tools.ts`
- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/agent/src/harness/compaction/branch-summarization.ts`
- `packages/agent/src/harness/tools/bash.ts`
- `packages/agent/src/harness/runtime/lane.ts`
- `packages/agent/src/harness/runtime/harness.ts`
- `packages/agent/src/harness/runtime/types.ts`
- `packages/agent/src/harness/runtime/restore.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/session/commit.ts`
- `packages/agent/src/harness/session/in-memory-storage-state.ts`
- `packages/agent/src/harness/session/memory.ts`
- `packages/agent/src/harness/session/jsonl/storage.ts`
- `packages/agent/src/harness/session/testing/conformance/storage.ts`
- `packages/agent/src/harness/session/testing/index.ts`
- `packages/session-backends/sqlite-node/src/sqlite/storage.ts`
- `packages/session-backends/sqlite-node/test/storage-conformance.test.ts`
- `packages/session-backends/sqlite-node/test/storage.test.ts`
- `packages/agent/test/harness/execution-primitives.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/runtime/test-utils.ts`
- `packages/agent/test/harness/runtime/accept.test.ts`
- `packages/agent/test/harness/runtime/lane.test.ts`
- `packages/agent/test/harness/runtime/harness.test.ts`
- `packages/agent/test/harness/runtime/restore.test.ts`
- `packages/agent/test/harness/runtime/watch.test.ts`
- `packages/agent/docs/harness.md`
- `packages/agent/docs/work-packages/02-atomic-run-acceptance.md`
- `packages/agent/docs/work-packages/03-remove-drive-deadlines.md`
- `packages/agent/docs/work-packages/04-mutation-publication.md`
- `packages/agent/CHANGELOG.md`
- `packages/protocol/src/harness.ts`
- `packages/protocol/test/protocol.test.ts`
- `packages/protocol/CHANGELOG.md`
- `packages/coding-agent/src/experimental/harness-wire-adapter.ts`
- `packages/coding-agent/test/experimental-harness-wire-adapter.test.ts`
- `packages/coding-agent/CHANGELOG.md`

**Conditional**
| Path | Decide by |
|---|---|
| `packages/agent/src/harness/session/values.ts` | create a new address only if a required durable fact has none; default is no change |

`session/types.ts` is listed under **Modify** rather than Conditional because §2.12 requires the `CommitResult.stats` field. That is an in-memory result shape, not a durable record, so it needs no migration. Any change to a *durable* shape (`RunPhase`, `Generation`, `OperationMeta`, `LaneLastResult`, …) remains forbidden without a stated migration.

---

## 5. Exclusions

Do not introduce: a `Deps` object; a generic scheduler, effect combinator, or action interpreter; callbacks that hide a commit (`classifyAndCommit`-style); string addresses; a `delete_prefix` write op; a parallel `Line`/`Tx` framework; activation epochs or tokens; manual-action state; changes to durable shapes (`RunPhase`/`Generation`/`CompactionSettings`/`LaneConfiguration`).

Also do not introduce: focused or partial durable readers, read-budget accounting, a read cache or memoized read layer, or a batching `getValues` API (§2.5); a process-local usage accumulator (§2.12); `any`, `Lane<any>`, or variance widening to make a generic assignment compile (§2.11); a `drive.ts` switch that imports modules from a later milestone (§2.4).

Classification is a pure function returning a typed decision; the calling procedure keeps its writes visible.

---

## 6. Final validation

```bash
npm run check
./test.sh
grep -rn "Breakpoint\|action_required\|ActionInfo\|ActionRequired\|peekAction\|executeAction\|runToCompletion\|SettledResumeOutcome" \
  packages/*/src packages/*/test packages/agent/docs/harness.md
grep -rn "delete_prefix\|interface Deps\b" packages/agent/src
grep -rn "SliceNotImplemented" packages/agent/src/harness/runtime   # watchSession only
grep -rn ": any\b\|<any>\|as unknown as\|@ts-expect-error" packages/agent/src/harness/runtime
grep -rn 'kind: "advance"\|kind: "reload"' packages/agent/src/harness/runtime   # must stay empty
grep -n "runtime" packages/agent/src/index.ts                   # must stay empty (§2.11)
# CommitResult.stats reaches all THREE backends, not just the two in packages/agent:
grep -rn "firstSeq" packages/agent/src packages/agent/test packages/session-backends
grep -rn "prepared.result" packages/agent/src packages/session-backends   # each composes stats
```

The storage conformance suite runs against Memory, JSONL, **and** SQLite; all three must report `commit(…).stats` equal to `getStats()` after every commit and after reopen. A green `packages/agent` run alone does not prove this — `packages/session-backends/sqlite-node/test/storage-conformance.test.ts` must pass too.

Stop condition: grep results as specified; every `RunPhase`/`CompactionState`/`NavigationState` driveable and reconcilable; every milestone exit condition met; every milestone compiles at its own commit with no forward imports; **all three storage backends pass conformance**; reviews at M1, M3, M5, M7 and final report no findings; `harness.md` updated in the same commits as its code.
