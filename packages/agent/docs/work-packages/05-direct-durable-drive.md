# WP05 — Direct durable drive

**Status: design draft.** Not implementation-ready until both independent reviews pass.

Removes breakpoints/manual drive, then implements the complete durable execution graph. Public drive stays disabled until every reachable phase and reconciliation path exists.

---

## 0. Mandatory reading order

Read completely, in this order, before editing anything. Do not rely on any external prototype, `/tmp` archive, or prior conversation.

1. `packages/agent/docs/harness.md` — all parts, normative.
2. `packages/agent/src/harness/agent-harness.ts` — public types and interfaces.
3. `packages/agent/src/harness/session/types.ts` — durable types (`OperationState`, `RunState`, `RunPhase`, `Generation`, `Deferred`, `ToolBatch`, `ToolCall`, `StructuralDecision`, `NavigationState`, `LaneLastResult`, `SessionReader`, `Write`, `CommitResult`).
4. `packages/agent/src/harness/session/values.ts` — every typed address and write helper.
5. `packages/agent/src/harness/runtime2/lane.ts` — `Lane`, `Lane.command`, `LaneCommand`, `accept`.
6. `packages/agent/src/harness/runtime2/types.ts` — `Config`, `LaneState`, `AcceptanceConfig`, `SliceNotImplemented`.
7. `packages/agent/src/harness/runtime2/harness.ts` — `Harness`, config store, `fault`, `close`.
8. `packages/agent/src/harness/runtime2/restore.ts` — projection restore.
9. `packages/agent/src/harness/execution/effect-gate.ts`, `execution/assistant.ts`, `execution/tools.ts`.
10. `packages/agent/src/harness/hooks.ts`, `events.ts`, `context.ts`, `result.ts`, `telemetry.ts`.
11. `packages/agent/src/harness/types.ts` — `AgentHarnessTool`, `AgentHarnessToolInvocation`.
12. `packages/agent/src/harness/session/testing/storage-decorator.ts`, `instrumented-storage.ts`, `testing/index.ts`.
13. Tests: `test/harness/runtime2/{accept,harness,lane,restore,watch}.test.ts`, `test/harness/runtime2/test-utils.ts`, `test/harness/execution-primitives.test.ts`, `test/harness/types.test.ts`.

---

## 1. Module ownership and import direction

```
agent-harness.ts        public types                      imports no runtime module
session/**              durable storage + session         imports no harness runtime module
execution/effect-gate   Gate / GateControl / AbortRequested
execution/assistant     provider streaming
execution/tools         tool phase helpers
runtime2/progress.ts    progress channels                 -> session/values, Lane (type-only)
runtime2/drive/*.ts     procedures                        -> progress, execution/*, session/values, Lane (type-only)
runtime2/drive.ts       the switch                        -> runtime2/drive/*, Lane (type-only)
runtime2/lane.ts        Lane owner + public surfaces      -> runtime2/drive.ts (value import)
runtime2/harness.ts     Harness                           -> runtime2/lane.ts
```

Rules:
- `drive.ts` and `drive/**` import `Lane` with `import type` only. No runtime cycle.
- No `Deps` object. Procedures receive `DriveScope` (§2.4), which carries the existing `Lane` instance plus per-pass values.
- No generic scheduler, effect combinator, action interpreter, or callback that hides a commit.
- Addresses are typed constructors from `session/values.ts`. Never string addresses. Never a `delete_prefix` write op — it does not exist in `Write`.

---

## 2. Approved source shape

**Approved** = the target structure; deviation needs a stated reason.
**Illustrative** = names/fields inside a body that may change while the structure holds.

### 2.1 ActiveDrive + deferred completion + exact-object cleanup — approved

```ts
// packages/agent/src/harness/runtime2/types.ts
import type { DriveOutcome } from "../agent-harness.ts";
import type { Gate, GateControl } from "../execution/effect-gate.ts";
import { createGate } from "../execution/effect-gate.ts";

export interface ActiveDrive {
	readonly operationId: string;
	readonly completion: Promise<DriveOutcome>;
	readonly gate: Gate;
	readonly control: GateControl;
}

export interface ActiveDriveHandle {
	readonly active: ActiveDrive;
	settle(outcome: DriveOutcome): void;
	fail(error: unknown): void;
}

export function createActiveDrive(operationId: string): ActiveDriveHandle {
	let settle!: (outcome: DriveOutcome) => void;
	let fail!: (error: unknown) => void;
	const completion = new Promise<DriveOutcome>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	// Joiners may attach later; keep the rejection observed without swallowing it.
	void completion.catch(() => {});
	const { gate, control } = createGate();
	return { active: { operationId, completion, gate, control }, settle, fail };
}
```

```ts
// packages/agent/src/harness/runtime2/lane.ts — exact-object cleanup (approved)
private async removeOwner(active: ActiveDrive, context: Context): Promise<void> {
	if (this.closedError === undefined) {
		try {
			await this.command(() => {
				if (this.activeDrive === active) this.activeDrive = undefined;
				return { kind: "return", result: undefined };
			}, context);
			return;
		} catch {
			// close/fault raced the cleanup job; fall through to process-local removal
		}
	}
	if (this.activeDrive === active) this.activeDrive = undefined;
}
```

Ordering: `runDrive` returns → final events already delivered (`Lane.command` awaits delivery) → `removeOwner` → `settle()/fail()`. A joiner therefore never observes completion before delivery and cleanup.

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
| installing invocation aborted **after** intent/admission | `control.close(new DriveAbandoned())`; owner removed; durable state stays at last commit (`effect_pending`); next drive recovers it as an orphan |
| joiner invocation aborted | only that joiner's observation ends |
| `requestAbort` | `beginAbort` → interrupt → commit `cancel_requested` → **then** `signalAbort()` |

`DriveAbandoned` never writes `cancel_requested`, never commits an aborted settlement, never calls `requestAbort`.
The retained pass context is `withoutAbortSignal(installerContext)`; admitted effects compose `withAbortSignal(gate.signal, …)`.

### 2.3 Lane.drive claim / join / hydration — approved

```ts
// packages/agent/src/harness/runtime2/lane.ts
type DriveClaim =
	| { kind: "join"; active: ActiveDrive }
	| { kind: "install"; handle: ActiveDriveHandle }
	| { kind: "settled"; outcome: DriveOutcome }
	| { kind: "mismatch"; error: OperationMismatch };

async drive(options: DriveOptions, context: Context): Promise<DriveResult> {
	if (this.closedError instanceof HarnessClosed) {
		return Result.err(new Closed({ message: this.closedError.message }));
	}
	this.assertOpen();

	const claim = await this.command<DriveClaim>(async (_projection, reader) => {
		// 1. A matching local owner wins over durable idle: after the terminal
		//    commit the lane is durably idle while the old owner is still
		//    delivering final events and removing itself. No durable read needed.
		const owner = this.activeDrive;
		if (owner !== undefined && owner.operationId === options.operationId) {
			return { kind: "return", result: { kind: "join", active: owner } };
		}

		const durableLane = (await reader.getValue(laneStateValue(this.name), context))?.value;
		const currentId = durableLane?.currentOperationId ?? null;

		// 2. Another operation is still owned locally.
		if (owner !== undefined) return { kind: "return", result: await this.mismatchClaim(reader, options.operationId, currentId, context) };

		// 3. Durable operation matches and has no owner: install. Hot path, one read.
		if (currentId === options.operationId) {
			const handle = createActiveDrive(options.operationId);
			this.activeDrive = handle.active;
			return { kind: "return", result: { kind: "install", handle } };
		}

		// 4. Idle: the latest result is read only here.
		if (currentId === null) {
			const last = await readMatchingLastResult(reader, this.name, options.operationId, context);
			if (last !== undefined) {
				const outcome = await hydrateTerminalOutcome(reader, last, context);
				return { kind: "return", result: { kind: "settled", outcome: { kind: "settled", operationId: options.operationId, outcome } } };
			}
		}
		return { kind: "return", result: await this.mismatchClaim(reader, options.operationId, currentId, context) };
	}, context);

	switch (claim.kind) {
		case "mismatch":
			return Result.err(claim.error);
		case "settled":
			return Result.ok(claim.outcome);
		case "join":
			return Result.ok(await claim.active.completion);
		case "install":
			this.startDrive(claim.handle, options, context); // AFTER the line released
			return Result.ok(await claim.handle.active.completion);
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

`accept` gains one guard (approved): while `this.activeDrive !== undefined`, return `LaneBusy` even when durable state is idle.

### 2.4 Drive switch contract — approved

```ts
// packages/agent/src/harness/runtime2/drive.ts
import type { Lane } from "./lane.ts";              // type-only: no runtime cycle

export interface PassPolicy {
	waitForRetry: boolean;
	deferredPermits: number;                          // pass-local; never mutates caller options
}

export interface DriveScope {
	readonly lane: Lane;                              // existing owner object, not a Deps bag
	readonly operationId: string;
	readonly gate: Gate;
	readonly context: Context;                        // installer context, cancellation stripped
	readonly pass: PassPolicy;
}

/** Every procedure returns one of exactly three things. */
export type StepResult =
	| { kind: "advance" }                             // committed durable progress; re-dispatch
	| { kind: "waiting"; outcome: DriveOutcome }      // durable wait: retry or deferred
	| { kind: "settled"; outcome: TerminalOperationOutcome };

export async function runDrive(scope: DriveScope): Promise<DriveOutcome> {
	await runBeforeDrive(scope);
	for (;;) {
		const operation = await readOperation(scope);
		if (operation === undefined) return hydrateSettled(scope);
		if (operation.state.control.status === "cancel_requested") {
			return { kind: "settled", operationId: scope.operationId, outcome: await reconcile(scope, operation) };
		}
		const step = await dispatch(scope, operation);
		if (step.kind === "waiting") return step.outcome;
		if (step.kind === "settled") {
			return { kind: "settled", operationId: scope.operationId, outcome: step.outcome };
		}
	}
}

async function dispatch(scope: DriveScope, operation: Operation): Promise<StepResult> {
	switch (operation.state.kind) {
		case "run":         return dispatchRun(scope, operation, operation.state);
		case "compaction":  return runStandaloneCompaction(scope, operation, operation.state);
		case "navigation":  return runNavigation(scope, operation, operation.state);
	}
}

async function dispatchRun(scope: DriveScope, operation: Operation, state: RunState): Promise<StepResult> {
	const phase = state.phase;
	switch (phase.kind) {
		case "starting":      return startRun(scope, operation, state);
		case "checkpoint":    return runCheckpoint(scope, operation, state, phase);
		case "assistant":     return runGeneration(scope, operation, state, phase.generation);
		case "tools":         return runToolBatch(scope, operation, state, phase.batch);
		case "compaction":    return runInRunCompaction(scope, operation, state, phase);
		case "deferred":      return runDeferred(scope, operation, state, phase.deferred);
		case "failure_drain": return finishRun(scope, operation, state, phase.error);
	}
}
```

`advance` carries an obligation: return it only after committing. Asserted by test (§5, `drive-crash-matrix.test.ts`).

### 2.5 Transition planner / decision shape — approved

`Lane.command` passes `this.state` (the **process-local projection**), not a durable read. Drive transitions must not trust it.

Each transition reads **only** the durable values it fences on or changes. There is no omnibus read.

```ts
// packages/agent/src/harness/runtime2/drive/transition.ts

/** The durable fence every run transition needs, and nothing else. */
export interface DurableCurrentRun {
	readonly pendingNextRun: string[];
	readonly state: RunState;
}

/**
 * Two indexed reads: the lane fence, then the operation state. Returns undefined
 * when this operation no longer owns the lane — an EXPECTED outcome, never a throw.
 */
export async function readCurrentRun(
	reader: SessionReader, lane: string, expectedOperationId: string, context: Context,
): Promise<DurableCurrentRun | undefined> {
	const laneStateStored = await reader.getValue(laneStateValue(lane), context);
	if (laneStateStored?.value.currentOperationId !== expectedOperationId) return undefined;
	const stored = await reader.getValue(operationState(expectedOperationId), context);
	if (stored === undefined || stored.value.kind !== "run") return undefined;
	return { pendingNextRun: laneStateStored.value.pendingNextRun, state: stored.value };
}

/** Same fence for the switch, before the run/compaction/navigation narrowing. */
export async function readCurrentOperationState(
	reader: SessionReader, lane: string, expectedOperationId: string, context: Context,
): Promise<{ pendingNextRun: string[]; state: OperationState } | undefined>;

// ---- focused readers: called only by the transitions that need them ----

/** Immutable intent / terminal kind. Written once at acceptance. */
export async function readRunMeta(
	reader: SessionReader, operationId: string, context: Context,
): Promise<OperationMeta | undefined>;

/** Append, placement, and finish transitions only. */
export async function readRunLeaf(
	reader: SessionReader, lane: string, context: Context,
): Promise<string | null>;

/** Generation and structural snapshot only. Absent configuration is corruption. */
export async function readRunConfiguration(
	reader: SessionReader, lane: string, context: Context,
): Promise<LaneConfiguration>;

/** Claim and hydration only. Undefined unless the latest result is this operation's. */
export async function readMatchingLastResult(
	reader: SessionReader, lane: string, operationId: string, context: Context,
): Promise<LaneLastResult | undefined>;

/**
 * Meta is write-once at acceptance, so a projection copy cannot be stale in a way
 * that matters. Use it when the durable fence does not depend on meta; fall back to
 * readRunMeta when the projection has none (fresh restore, directly constructed state).
 */
export function metaFromProjection(projection: LaneState, operationId: string): OperationMeta | undefined {
	const operation = projection.operation;
	return operation?.meta.operationId === operationId ? operation.meta : undefined;
}

// ---- projection helpers: every required piece is explicit ----

export interface RunProjectionParts {
	readonly meta: OperationMeta;
	readonly state: RunState;
	readonly pendingNextRun: string[];
	/** Supply only when this transition read or moved the leaf. */
	readonly leafId?: string | null;
	/** Supply only when this transition read configuration. */
	readonly configuration?: LaneConfiguration;
	readonly lastResult?: LaneLastResult;
}

/**
 * The exact next LaneState. Unsupplied pieces are retained from the planner's
 * projection, which is legal only for values this transition neither fences on
 * nor changes.
 */
export function projectRun(projection: LaneState, parts: RunProjectionParts): LaneState {
	return {
		leafId: parts.leafId === undefined ? projection.leafId : parts.leafId,
		configuration: parts.configuration ?? projection.configuration,
		pendingNextRun: parts.pendingNextRun,
		...(parts.lastResult === undefined
			? (projection.lastResult === undefined ? {} : { lastResult: projection.lastResult })
			: { lastResult: parts.lastResult }),
		operation: { meta: parts.meta, state: parts.state },
	};
}

/** Terminal projection: the operation ceases to exist. */
export function projectIdle(
	projection: LaneState,
	parts: { pendingNextRun: string[]; lastResult: LaneLastResult; leafId?: string | null },
): LaneState {
	return {
		leafId: parts.leafId === undefined ? projection.leafId : parts.leafId,
		configuration: projection.configuration,
		pendingNextRun: parts.pendingNextRun,
		lastResult: parts.lastResult,
		operation: null,
	};
}
```

Read budget per transition (approved):

| Transition | Reads |
|---|---|
| generation intent, tool status patch, staging | `readCurrentRun` (2) |
| settlement, materialization, drains | `readCurrentRun` + `readRunLeaf` (3) |
| checkpoint → assistant ready, structural snapshot | `readCurrentRun` + `readRunConfiguration` (3) |
| `startRun` | `readCurrentRun` + `readRunLeaf` + `readRunMeta` (4) |
| terminal | `readCurrentRun` + `readRunLeaf` + `readRunMeta` + 4 prefix scans |
| claim / hydration | `laneState` (1), then `readMatchingLastResult` only on the idle/mismatch branches |

Usage inside any drive transition (approved shape; body illustrative):

```ts
const committed = await scope.lane.command<boolean>(async (projection, reader) => {
	const run = await readCurrentRun(reader, scope.lane.name, scope.operationId, scope.context);
	// Verification failure is EXPECTED. Lane.command turns a planner throw into a
	// harness fault, so decline with an explicit no-commit return instead.
	if (run === undefined || run.state.phase.kind !== "assistant") return { kind: "return", result: false };
	if (run.state.phase.generation.status !== "ready") return { kind: "return", result: false };
	if (run.state.phase.generation.context.stepId !== expectedStepId) return { kind: "return", result: false };
	if (!scope.lane.ownsDrive(scope)) return { kind: "return", result: false };

	const meta = metaFromProjection(projection, scope.operationId)
		?? (await readRunMeta(reader, scope.operationId, scope.context));
	if (meta === undefined) return { kind: "return", result: false };

	const nextState: RunState = { ...run.state, phase: { kind: "assistant", generation } };
	return {
		kind: "commit",
		writes: [setValue(operationState(scope.operationId), nextState)],
		next: projectRun(projection, { meta, state: nextState, pendingNextRun: run.pendingNextRun }),
		materialize: () => true,
		events: () => [{ type: "turn_start", runId: scope.operationId, turnId: stepId, lane: scope.lane.name }],
	};
}, scope.context);
if (!committed) return { kind: "advance" };
```

**Optimization note.** Reads are indexed point lookups; SQLite is expected to serve them cheaply from the hot path. Do **not** add caching, a memoized read layer, or a batching `getValues` API in this package. Batching is a later, profiling-driven change.

### 2.6 Generation procedure — approved shape, illustrative bodies

```ts
// packages/agent/src/harness/runtime2/drive/generation.ts
// The ready generation already carries its configuration snapshot in gen.context,
// so this procedure never reads laneConfig. Only checkpoint -> ready snapshots it.
async function runReadyGeneration(
	scope: DriveScope, run: DurableCurrentRun, gen: Extract<Generation, { status: "ready" }>,
): Promise<StepResult> {
	const config = scope.lane.readConfig();
	const identity = gen.context.configuration.model;
	const model = scope.lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) return enterConfigurationFailure(scope, "model_unavailable", identity);

	// ---- prepare: pure/local, nothing reserved yet ----
	const messages = await buildRequestMessages(scope, gen.context, run);
	const systemPrompt = await resolveSystemPrompt(config, scope.context);
	const patch = await scope.lane.hooks.runWithGate(
		"before_request",
		{ lane: scope.lane.name, runId: scope.operationId, model, step: "assistant", attempt: gen.nextAttempt, streamOptions: gen.context.streamOptions },
		scope.gate, scope.context,
	);
	const streamOptions = applyStreamOptionsPatch(gen.context.streamOptions, patch?.streamOptions);
	const at = Date.now();
	const responseEntryId = scope.lane.session.idGenerator.next(at);
	const usageId = scope.lane.session.idGenerator.next(at);

	// ---- intent: one visible commit ----
	const generation: Generation = {
		status: "effect_pending", context: gen.context, attempt: gen.nextAttempt,
		responseEntryId, usageId,
		intendedOutputLimit: model.maxTokens, contextWindow: model.contextWindow,
	};
	const admitted = await commitGenerationIntent(scope, gen.context.stepId, generation);
	if (!admitted) return { kind: "advance" };

	// ---- effect: admitted, off the lane line ----
	const progress = openFrameProgress(scope, responseEntryId);
	let response: SettledAssistantMessage;
	try {
		response = await streamHarnessAssistant(messages, {
			model, systemPrompt, thinkingLevel: gen.context.configuration.thinkingLevel, streamOptions,
			toProviderMessages: config.toProviderMessages,
			request: (aiContext, options) =>
				scope.gate.admit(() => scope.lane.models.streamSimple(model, aiContext, options)),
			observer: frameObserver(scope, progress, responseEntryId),
		}, withAbortSignal(scope.gate.signal, scope.context));
	} finally {
		progress.seal();
	}
	await progress.drain();                              // rejects if any frame write failed

	// ---- outcome: one visible commit ----
	return settleAssistant(scope, { responseEntryId, usageId, stepId: gen.context.stepId }, response);
}
```

Constraints: preparation precedes the intent commit; settlement writes under the reserved ids; the frame observer enqueues synchronously and never awaits storage; `progress.drain()` precedes settlement.

### 2.7 Progress helper — approved

```ts
// packages/agent/src/harness/runtime2/progress.ts
export interface ProgressChannel<T> {
	write(item: T): void;        // synchronous enqueue; never awaited per item
	seal(): void;
	drain(): Promise<void>;      // rejects if any retained write rejected
	clearWrite(): Write;         // the delete included in the settling transaction
}

function openProgress<T>(
	scope: DriveScope,
	commitWrite: (item: T) => Write,
	clear: () => Write,
	stillOwns: (reader: SessionReader) => Promise<boolean>,
): ProgressChannel<T> {
	let sealed = false;
	let latest: Promise<void> = Promise.resolve();
	return {
		write(item) {
			if (sealed) return;
			const write = scope.lane.command(async (_projection, reader) => {
				if (!(await stillOwns(reader))) return { kind: "return", result: undefined };
				return { kind: "commit", writes: [commitWrite(item)], next: /* unchanged projection */ …,
				         materialize: () => undefined };
			}, scope.context);
			latest = write;                       // retained RAW: drain() must still reject
			void write.catch(() => {});           // separate observer only silences the warning
		},
		seal() { sealed = true; },
		async drain() { await latest; },
		clearWrite: clear,
	};
}

export const openFrameProgress = (scope: DriveScope, responseEntryId: string) =>
	openProgress<AssistantMessageFrame>(
		scope,
		(frame) => appendList(pendingAssistantFrames(scope.operationId, responseEntryId), frame),
		() => deleteList(pendingAssistantFrames(scope.operationId, responseEntryId)),
		/* stillOwns: phase assistant + effect_pending + same responseEntryId */ …,
	);

export const openToolProgress = (scope: DriveScope, invocationId: string) =>
	openProgress<AgentToolResult<unknown>>(
		scope,
		(snapshot) => setValue(pendingToolOutput(scope.operationId, invocationId), snapshot),
		() => deleteValue(pendingToolOutput(scope.operationId, invocationId)),
		/* stillOwns: phase tools + this call effect_pending */ …,
	);
```

`latest` keeps the **rejecting** promise so `drain()` propagates the failure; the `void write.catch` observer must not replace it.

### 2.8 Tool batch — approved shape, illustrative bodies

```ts
// packages/agent/src/harness/runtime2/drive/tools.ts
async function runToolBatch(scope: DriveScope, run: DurableCurrentRun, batch: ToolBatch): Promise<StepResult> {
	const sequential = run.state.settings.toolExecution === "sequential";
	const started = new Map<number, Promise<void>>();     // process-local, never durable
	const toolContext = await resolveToolContext(scope);  // once per batch, not per call

	try {
		for (const call of batch.calls) {
			if (call.status === "completed" || call.status === "outcome_ready") continue;
			const work = call.status === "effect_pending"
				? recoverCall(scope, batch, call, toolContext)   // orphan by construction
				: runCall(scope, batch, call, toolContext);
			started.set(call.sourceIndex, work);
			if (sequential) await work;
		}
		if (!sequential) await Promise.all(started.values());
	} catch (error) {
		if (!(error instanceof AbortRequested)) throw error;
		await error.cancellation;
		await Promise.allSettled(started.values());
		await stageUnstartedCalls(scope, batch);
		await materializeReadyPrefix(scope, batch.turnId);
		return { kind: "advance" };
	}
	return { kind: "advance" };
}
```

Every status patch is derived from the state reread inside its own `Lane.command`:

```ts
function patchCall(state: RunState, sourceIndex: number, next: ToolCall): RunState {
	if (state.phase.kind !== "tools") throw new SessionInvariantError("not a tools phase");
	return {
		...state,
		phase: { kind: "tools", batch: {
			...state.phase.batch,
			calls: state.phase.batch.calls.map((c) => (c.sourceIndex === sourceIndex ? next : c)),
		} },
	};
}
// call site: const run = await readCurrentRun(reader, lane, operationId, ctx);  // 2 reads
//            patchCall(run.state, i, next)
// NEVER patchCall(batchCapturedBeforeTheJob, …)
```

Staging is completion-ordered (`outcome_ready`); `materializeReadyPrefix` places the contiguous ready prefix in source order in one commit, and `addedToolNames` takes effect only at placement.

### 2.9 Terminal transaction — approved

```ts
// packages/agent/src/harness/runtime2/drive/terminal.ts
async function commitTerminal(scope: DriveScope, request: TerminalRequest): Promise<TerminalOperationOutcome> {
	return scope.lane.command(async (projection, reader) => {
		// Terminal needs the fence, the result leaf, and meta for the terminal kind
		// (and navigation's oldLeafId). Nothing else.
		const run = await readCurrentRun(reader, scope.lane.name, scope.operationId, scope.context);
		if (run === undefined) throw new SessionInvariantError("terminal transaction lost its operation");
		const leafId = await readRunLeaf(reader, scope.lane.name, scope.context);
		const meta = metaFromProjection(projection, scope.operationId)
			?? (await readRunMeta(reader, scope.operationId, scope.context));
		if (meta === undefined) throw new SessionInvariantError("terminal transaction lost its metadata");

		const [toolArgs, toolMemos, preparations, toolOutputs] = await Promise.all([
			reader.scanValues(operationToolArgsPrefix(scope.operationId), scope.context),
			reader.scanValues(operationToolMemoPrefix(scope.operationId), scope.context),
			reader.scanValues(operationPreparationPrefix(scope.operationId), scope.context),
			reader.scanValues(pendingToolOutputPrefix(scope.operationId), scope.context),
		]);

		const writes: Write[] = [
			deleteValue(operationMeta(scope.operationId)),
			deleteValue(operationState(scope.operationId)),
			...toolArgs.map((v) => deleteValue(v.address)),
			...toolMemos.map((v) => deleteValue(v.address)),
			...preparations.map((v) => deleteValue(v.address)),
			...toolOutputs.map((v) => deleteValue(v.address)),
			...liveFrameListWrites(run.state),            // exact deleteList for an unsettled response
			...stagedPendingEntryWrites(run.state),       // staged results + queued/drained ids
			setValue(laneLastResult(scope.lane.name), lastResult),
			setValue(laneStateValue(scope.lane.name), { currentOperationId: null, pendingNextRun: run.pendingNextRun }),
		];
		return { kind: "commit", writes,
		         next: projectIdle(projection, { pendingNextRun: run.pendingNextRun, lastResult, leafId }),
		         materialize: () => outcome, events: () => [endEvent] };
	}, scope.context);
}
```

`pendingNextRun` is lane-owned and survives. Defensive deletes of already-removed addresses are no-ops. **Never** add `delete_prefix`.

### 2.10 GatingStorage + representative test — approved

```ts
// packages/agent/src/harness/session/testing/gating-storage.ts
export class GatingStorage extends StorageDecorator {
	private armed = false;
	private discarded = false;
	private readonly queue: Array<{ release: () => void; drop: () => void }> = [];

	/** Setup bypass: fixture writes commit ungated until arm() is called. */
	arm(): void { this.armed = true; }
	pending(): number { return this.queue.length; }

	override async commit(writes: Write[], context: Context): Promise<CommitResult> {
		if (!this.armed || this.discarded) return super.commit(writes, context);
		await new Promise<void>((resolve, reject) => {
			this.queue.push({ release: resolve, drop: () => reject(new Error("commit discarded")) });
		});
		return super.commit(writes, context);
	}

	/** Release exactly `count` parked commits, resolving after each lands. */
	async next(count = 1): Promise<void> {
		for (let i = 0; i < count; i++) {
			const parked = this.queue.shift();
			if (parked === undefined) throw new Error("no parked commit");
			parked.release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	/** Crash simulation: unreleased commits can never land afterwards. */
	discard(): void {
		this.discarded = true;
		for (const parked of this.queue.splice(0)) parked.drop();
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
await gating.next();                                  // starting -> checkpoint
await gating.next();                                  // checkpoint -> assistant ready
await gating.next();                                  // intent: effect_pending
expect(await phaseOf(session, admission.operationId)).toMatchObject({ kind: "assistant" });

provider.resolve(fauxAssistantMessage("answer"));     // effect window released
await gating.next();                                  // settlement
gating.discard();                                     // crash before terminal
await expect(driving).rejects.toBeDefined();

await harness.close(ctx);
const reopened = await repo.open(session.metadata, ctx);
// the discarded commit never landed; drive resumes from the settled checkpoint
```

Determinism: `MemoryStorage` accepts `now`; `Session.idGenerator` must become injectable (M1 API change) or tests compare under first-appearance id normalization.

---

## 3. Milestones

Every milestone uses the same subsections. Public drive stays disabled until M8.

### Guard that keeps public drive disabled (M1–M7)

`runtime2/lane.ts` keeps throwing `SliceNotImplemented` from `drive`, `requestAbort`, `prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`, `resume`, `abort`, `steer`, `followUp`, `nextRun`, `cancelQueued`, `recordUsage`, `waitForIdle`, `runWhenIdle`. Procedures are exercised only through `createDriveScope()` in `test/harness/runtime2/test-utils.ts` against directly constructed durable state. **M8 removes those throws in one commit**, after every phase and reconciliation path exists.

---

### M0 — Remove breakpoints and manual drive (independently committable)

**Goal.** No breakpoint or manual-drive concept anywhere. No behavior added.

**Read completely before editing**
- `packages/agent/src/harness/execution/breakpoint.ts`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/runtime2/{lane,types,harness}.ts`
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
| `src/harness/runtime2/types.ts` | `Config.drive` |
| `src/harness/runtime2/harness.ts` | `drive: options.drive ?? "automatic"` |
| `src/harness/runtime2/lane.ts` | the three action-method stubs |
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

**Do not implement yet.** No `ActiveDrive`, no `Gate`, no drive procedures.

**Exit condition / review questions.** Grep clean; `npm run check` and `./test.sh` pass; changelogs updated. Did any removed sentence carry a durability requirement that must be kept in reworded form?

**Protocol version decision.** `PROTOCOL_VERSION` is **not** bumped: `action_required` was reachable only through manual drive, which never shipped enabled, so no producer emitted it. Record the decision in `packages/protocol/CHANGELOG.md`.

---

### M1 — Foundations (review checkpoint)

**Goal.** Ownership record, gate, progress, deterministic test harness. Nothing drives.

**Read completely before editing**
- `src/harness/execution/effect-gate.ts`, `src/harness/hooks.ts`
- `src/harness/runtime2/{lane,types,harness}.ts`
- `src/harness/session/{values,types,session}.ts`
- `src/harness/session/testing/{storage-decorator,instrumented-storage,index}.ts`
- `src/harness/session/memory.ts`
- `test/harness/runtime2/test-utils.ts`, `test/harness/instrumented-storage.test.ts`

**Delete** — none.

**Create**
- `src/harness/session/testing/gating-storage.ts` — `GatingStorage` (§2.10)
- `src/harness/runtime2/progress.ts` — `ProgressChannel`, `openFrameProgress`, `openToolProgress` (§2.7)
- `test/harness/gating-storage.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/execution/effect-gate.ts` | add `Gate`, `GateControl`, `createGate()`, `DriveAbandoned` (§2.2); keep `AbortRequested`; retire `EffectGate.assertOpen` from the procedure-facing surface |
| `src/harness/hooks.ts` | `runWithGate`/`runToolWithGate` accept `Gate` and use `admit` |
| `src/harness/runtime2/types.ts` | add `ActiveDrive`, `ActiveDriveHandle`, `createActiveDrive` (§2.1) |
| `src/harness/runtime2/lane.ts` | add `private activeDrive: ActiveDrive \| undefined`; widen `emitBatch`/`readConfig` to `internal` visibility for `drive/**`; replace `getAcceptanceConfig: () => AcceptanceConfig` with `readConfig: () => Config<TContext>`; add `hooks: HookRegistry` constructor parameter |
| `src/harness/runtime2/harness.ts` | pass `HookRegistry` and full `Config` into `Lane`/`buildLane`; usage accumulator |
| `src/harness/session/session.ts` | make `idGenerator` injectable through constructor options (**named API change**; alternative: canonical id normalization in tests) |
| `src/harness/session/testing/index.ts` | export `GatingStorage` |
| `test/harness/runtime2/test-utils.ts` | add `createDriveScope()` and `createDriveFixture()` |

**Behavior/invariants landed.** `admit` is the only gate check; `GateControl` is owner-held; progress `drain()` propagates write failures; `GatingStorage` parks/releases/discards deterministically.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/gating-storage.test.ts` | setup bypass; FIFO `next()`; `pending()`; `discard()` prevents a later land; composition order with `InstrumentedStorage` |
| `test/harness/execution-primitives.test.ts` | `createGate` admit/abort/close; `DriveAbandoned` distinct from `AbortRequested` |

**Commands.** `npm run check` · `./test.sh`

**Do not implement yet.** No phase procedures, no `runDrive`, no public wiring.

**Exit condition / review questions.** Gate has no `assertOpen` reachable from procedures. Can an unreleased commit land after `discard()` + reopen? Is `idGenerator` injection or normalization decided and recorded?

---

### M2 — Terminal, hydration, synthetic settlement, orphan recovery

**Goal.** The exits of the graph, testable from constructed state.

**Read completely before editing**
- `src/harness/session/types.ts` (`LaneLastResult`, `TerminalOperationOutcome` in `agent-harness.ts`)
- `src/harness/session/values.ts` (all `*Prefix` constructors)
- `src/harness/runtime2/restore.ts`
- `test/harness/runtime2/{harness,watch}.test.ts` (durable-state construction patterns)

**Create**
- `src/harness/runtime2/drive/transition.ts` — `DurableCurrentRun`, `readCurrentRun`, `readCurrentOperationState`, `readRunMeta`, `readRunLeaf`, `readRunConfiguration`, `readMatchingLastResult`, `metaFromProjection`, `projectRun`, `projectIdle` (§2.5)
- `src/harness/runtime2/drive/terminal.ts` — `commitTerminal`, `hydrateTerminalOutcome`, `settledFromLastResult` (§2.9)
- `src/harness/runtime2/drive/recovery.ts` — synthetic settlement from committed frames
- `test/harness/runtime2/drive-terminal.test.ts`

**Modify** — none beyond exports.

**Behavior/invariants landed.** Terminal deletes every operation-owned address via typed prefix scans and concrete `deleteValue`; `pendingNextRun` survives; hydration returns the same outcome the live caller receives; synthetic settlement writes under reserved ids and deletes the exact frame list.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-terminal.test.ts` | cleanup completeness incl. leftovers; `pendingNextRun` preserved; hydration equality; synthetic settlement content and zero usage |

**Commands.** `npm run check` · `node …/vitest --run test/harness/runtime2/drive-terminal.test.ts`

**Do not implement yet.** No switch, no generation, no public wiring.

**Exit condition / review questions.** Is any operation-owned address missing from cleanup? Does hydration read only bounded state?

---

### M3 — Generation (review checkpoint)

**Goal.** `starting → checkpoint → assistant ready → intent → stream → settlement`, frames, configuration failure.

**Read completely before editing**
- `src/harness/execution/assistant.ts` (full), `src/harness/hooks.ts`
- `src/harness/session/context.ts`, `src/harness/messages.ts`, `src/harness/system-prompt.ts`
- `src/harness/compaction/compaction.ts` (settings only)
- `test/harness/execution-assistant.test.ts`

**Create**
- `src/harness/runtime2/drive.ts` — `DriveScope`, `StepResult`, `runDrive`, `dispatch` (§2.4)
- `src/harness/runtime2/drive/checkpoint.ts` — `startRun`, `runCheckpoint`
- `src/harness/runtime2/drive/generation.ts` — `runGeneration`, `settleAssistant`, `enterConfigurationFailure` (§2.6)
- `test/harness/runtime2/drive-generation.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/execution/assistant.ts` | `request` admitted through `Gate`; observer receives Context |
| `src/harness/runtime2/drive/transition.ts` | add a generation-specific verification helper only if it enforces one invariant; do not widen `readCurrentRun` |

**Behavior/invariants landed.** Preparation precedes intent; ids reserved at intent and honoured at settlement; frames enqueued synchronously without per-frame awaits; settlement deletes the frame list; `advance` only after a commit; every transition rereads durable state and publishes the exact projection; checkpoint separates tree parent/leaf from `triggerEntryId` for unprojected custom writes.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-generation.test.ts` | intent before provider; reserved-id settlement; frame order without storage awaits; orphan recovery without provider call; mixed projecting/unprojected drains (leaf vs trigger); queued public mutation observed by the next planner; published projection equals fresh restore |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Retry, deferred, tools, structural, reconciliation, public wiring.

**Exit condition / review questions.** Does any planner throw for an expected verification failure? Does any procedure derive state from a pre-job snapshot?

---

### M4 — Retry and deferred

**Goal.** Durable waiting.

**Read completely before editing**
- `src/harness/session/types.ts` (`Generation.retry_wait`, `Deferred`)
- `src/harness/config.ts` (`validateRetryPolicy`, normalization)
- `src/harness/agent-harness.ts` (`DriveOptions.waitForRetry`, `pollDeferred`, `DriveOutcome.waiting`)

**Create**
- `src/harness/runtime2/drive/deferred.ts`
- `test/harness/runtime2/drive-retry-deferred.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime2/drive/generation.ts` | retry classification → `retry_wait`; `waitForRetry` policy |
| `src/harness/runtime2/drive.ts` | `PassPolicy.deferredPermits` consumption |

**Behavior/invariants landed.** No durable armed poll state: `suspended` never becomes a durable pollable `ready`; the permit is consumed by the **fresh intent commit** that reserves new ids; a crash before that commit leaves `suspended` at the same poll number; an unknown-outcome poll does not consume a poll, deletes the old frame list, and mints fresh ids next poll; an unknown-outcome structural attempt *does* consume an attempt.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-retry-deferred.test.ts` | waiting outcomes; permit consumption point; crash before intent stays suspended; unknown-outcome poll number and id freshness; pass-local permit never mutates caller options |

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
- `src/harness/runtime2/drive/tools.ts` (§2.8)
- `test/harness/runtime2/drive-tools.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/types.ts` | add `AgentHarnessToolUpdateOptions { checkpoint?: boolean }` and `AgentHarnessToolUpdateCallback`; add memo accessors to `AgentHarnessToolInvocation` (**named API change**: these are referenced by the spec but absent today) |
| `src/harness/execution/tools.ts` | admit `execute` through `Gate`; thread invocation + update options |
| `src/harness/tools/bash.ts` | keep `BASH_UPDATE_THROTTLE_MS = 100`; add a distinct checkpoint cadence of at most one per 2 s, only when the bounded snapshot changed |

**Behavior/invariants landed.** Clearance order lookup → `prepareArguments` (ungated, throw normalizes to a synthetic error) → `before_tool` → argument intent commit; missing tools stage detail-free synthetic results; `toolContext` resolved once per batch; memos under `operationToolMemo`, deleted by staging; per-invocation update + checkpoint drain before `after_tool`; local started map; current-state patching; completion-order staging with source-order materialization; `addedToolNames` effective only at placement; abort after admission unwinds the batch.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-tools.test.ts` | sequential and parallel two-call batches preserving sibling status; out-of-order completion → source-order placement; safe replay re-executes, unsafe does not; `outcome_ready` never re-executes; memo lifetime; checkpoint cadence; drain before `after_tool`; `addedToolNames` at placement; abort after admission |

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

**Create**
- `src/harness/runtime2/drive/structural.ts`
- `test/harness/runtime2/drive-structural.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime2/drive/checkpoint.ts` | threshold check keyed by `thresholdCheckedTriggerEntryId` |
| `src/harness/compaction/compaction.ts` | preparation persisted at `operationPreparation` and revalidated against its source on resume (if not already) |

**Behavior/invariants landed.** Preparation written before the decision hook and revalidated on resume; each nested request commits intent (index + reserved `usageId`), is admitted, then atomically writes usage and clears the request; crash after request one leaves the row and an uncertain attempt; an unknown-outcome attempt consumes an attempt; model disappearance between split requests fails in band; result entry id reserved once; standalone publication and terminal end share one transaction; in-run compaction resumes the stored checkpoint; threshold considered at most once per boundary; structural retry waiting is gated and its policy stated.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-structural.test.ts` | threshold once per boundary; decline/success/crash resume; nested request intent+usage; crash after request one; model disappearance; unknown attempt consumption; preparation revalidation; navigation with and without summary |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Reconciliation, public wiring.

**Exit condition / review questions.** Is any structural state reachable without a driver?

---

### M7 — Reconciliation and lifecycle (review checkpoint)

**Goal.** Abort, close, fault, external finalization. Graph becomes total.

**Read completely before editing**
- `src/harness/runtime2/harness.ts` (`fault`, `close`), `src/harness/runtime2/lane.ts` (`seal`)
- `src/harness/events.ts`, `src/harness/context.ts`
- `packages/agent/docs/harness.md` §4.6, §4.7, §4.9

**Create**
- `src/harness/runtime2/drive/reconcile.ts`
- `test/harness/runtime2/drive-reconcile.test.ts`
- `test/harness/runtime2/drive-lifecycle.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime2/lane.ts` | `requestAbort` implementation; `seal` closes the owner's gate and removes it process-locally |
| `src/harness/runtime2/harness.ts` | fault seals owners; close detaches non-cooperative effects |

**Behavior/invariants landed.** `requestAbort` order: `beginAbort` → interrupt → commit marker → `signalAbort`. Reconciliation walks `assistant.effect_pending`, `deferred`, `tools` (mixed statuses), `compaction`, `checkpoint`, `failure_drain`. Invocation cancellation (`DriveAbandoned`) never writes durable cancellation. Pre-admission close returns `Result.err(Closed)`; admitted work rejects `HarnessClosed`; close writes no synthetic settlement, does not block on a non-cooperative effect, and produces no unhandled rejection. External finalization makes the local owner's next verification fail; it resolves from `laneLastResult`.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-reconcile.test.ts` | abort before/after admission at each admit site; mid-batch abort; reconciliation per phase; `aborted` response always under `cancel_requested` |
| `test/harness/runtime2/drive-lifecycle.test.ts` | pre-admission `Closed` vs admitted `HarnessClosed`; non-cooperative effect; fault sealing; external finalization; invocation cancel abandons at `effect_pending` with no durable write |

**Commands.** `npm run check` · targeted vitest

**Do not implement yet.** Public wiring (`SliceNotImplemented` guards remain).

**Exit condition / review questions.** Is every `RunPhase`, `CompactionState`, and `NavigationState` reachable by the classifier now driveable *and* reconcilable?

---

### M8 — Public surfaces

**Goal.** Remove the guards; wire ownership and every public method.

**Read completely before editing**
- `src/harness/agent-harness.ts` (`AgentLane`, `AgentHarness`)
- `src/harness/runtime2/lane.ts` (all `SliceNotImplemented` stubs)
- `test/harness/runtime2/{accept,lane,harness,watch}.test.ts`

**Create**
- `test/harness/runtime2/drive-ownership.test.ts`
- `test/harness/runtime2/drive-surfaces.test.ts`
- `test/harness/runtime2/drive-crash-matrix.test.ts`

**Modify**
| Path | Change |
|---|---|
| `src/harness/runtime2/lane.ts` | implement `drive` (§2.3), `startDrive`, `removeOwner`; `accept` returns `LaneBusy` while an owner exists; implement `prompt`, `skill`, `promptFromTemplate`, `compact`, `navigateTree`, `resume`, `abort`, `steer`, `followUp`, `nextRun`, `cancelQueued`, `recordUsage`, `waitForIdle`, `runWhenIdle`; `inspectExecution` reports `running` when owned |
| `src/harness/runtime2/restore.ts` | restore every phase projection |
| `src/harness/telemetry.ts` | drive spans |
| `src/harness/runtime2/types.ts` | `SliceNotImplemented` retained only for `watchSession` |

**Behavior/invariants landed.** Owner-before-idle claim order; join observes delivered events; usage row `seq` from `CommitResult`, totals accumulated in `materialize` and read in `events`; every hook/event/observation carries the emitting Context. `AgentHarness.watchSession` is **explicitly deferred** and keeps its rejection.

**Focused tests**
| Path | Theme |
|---|---|
| `test/harness/runtime2/drive-ownership.test.ts` | join before hydration; terminal owner blocks acceptance (`LaneBusy`) and new ownership; same-id join observes delivered events; mismatch ids; close/fault removal |
| `test/harness/runtime2/drive-surfaces.test.ts` | convenience = accept + drive; `resume`; `Closed` returned not thrown; listeners settle before the next procedure hook; `usage` per settlement; Context lineage |
| `test/harness/runtime2/drive-crash-matrix.test.ts` | release N commits → discard → reopen → drive, for every N in every phase path; one commit per `advance`; gated vs ungated byte-identical writes |

**Commands.** `npm run check` · `./test.sh`

**Do not implement yet.** `watchSession`.

**Exit condition / review questions.** Any public path reachable over a partial graph? Any `SliceNotImplemented` left besides `watchSession`?

---

## 4. File manifest

**Delete**
- `packages/agent/src/harness/execution/breakpoint.ts`

**Create**
- `packages/agent/src/harness/runtime2/drive.ts`
- `packages/agent/src/harness/runtime2/drive/transition.ts`
- `packages/agent/src/harness/runtime2/drive/checkpoint.ts`
- `packages/agent/src/harness/runtime2/drive/generation.ts`
- `packages/agent/src/harness/runtime2/drive/deferred.ts`
- `packages/agent/src/harness/runtime2/drive/tools.ts`
- `packages/agent/src/harness/runtime2/drive/structural.ts`
- `packages/agent/src/harness/runtime2/drive/reconcile.ts`
- `packages/agent/src/harness/runtime2/drive/terminal.ts`
- `packages/agent/src/harness/runtime2/drive/recovery.ts`
- `packages/agent/src/harness/runtime2/progress.ts`
- `packages/agent/src/harness/session/testing/gating-storage.ts`
- `packages/agent/test/harness/gating-storage.test.ts`
- `packages/agent/test/harness/runtime2/drive-terminal.test.ts`
- `packages/agent/test/harness/runtime2/drive-generation.test.ts`
- `packages/agent/test/harness/runtime2/drive-retry-deferred.test.ts`
- `packages/agent/test/harness/runtime2/drive-tools.test.ts`
- `packages/agent/test/harness/runtime2/drive-structural.test.ts`
- `packages/agent/test/harness/runtime2/drive-reconcile.test.ts`
- `packages/agent/test/harness/runtime2/drive-lifecycle.test.ts`
- `packages/agent/test/harness/runtime2/drive-ownership.test.ts`
- `packages/agent/test/harness/runtime2/drive-surfaces.test.ts`
- `packages/agent/test/harness/runtime2/drive-crash-matrix.test.ts`

**Modify**
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/types.ts`
- `packages/agent/src/harness/hooks.ts`
- `packages/agent/src/harness/telemetry.ts`
- `packages/agent/src/harness/execution/effect-gate.ts`
- `packages/agent/src/harness/execution/assistant.ts`
- `packages/agent/src/harness/execution/tools.ts`
- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/agent/src/harness/tools/bash.ts`
- `packages/agent/src/harness/runtime2/lane.ts`
- `packages/agent/src/harness/runtime2/harness.ts`
- `packages/agent/src/harness/runtime2/types.ts`
- `packages/agent/src/harness/runtime2/restore.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/testing/index.ts`
- `packages/agent/test/harness/execution-primitives.test.ts`
- `packages/agent/test/harness/types.test.ts`
- `packages/agent/test/harness/runtime2/test-utils.ts`
- `packages/agent/test/harness/runtime2/accept.test.ts`
- `packages/agent/test/harness/runtime2/lane.test.ts`
- `packages/agent/test/harness/runtime2/harness.test.ts`
- `packages/agent/test/harness/runtime2/restore.test.ts`
- `packages/agent/test/harness/runtime2/watch.test.ts`
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
| `packages/agent/src/harness/session/types.ts` | modify only if a durable shape is provably missing a field; changing an existing shape needs a stated migration |
| `packages/agent/src/harness/session/session.ts` | modify only if `idGenerator` injection is chosen over test-side id normalization (M1) |

---

## 5. Exclusions

Do not introduce: a `Deps` object; a generic scheduler, effect combinator, or action interpreter; callbacks that hide a commit (`classifyAndCommit`-style); string addresses; a `delete_prefix` write op; a parallel `Line`/`Tx` framework; activation epochs or tokens; manual-action state; changes to `RunPhase`/`Generation`/`CompactionSettings`/`LaneConfiguration` shapes.

Classification is a pure function returning a typed decision; the calling procedure keeps its writes visible.

---

## 6. Final validation

```bash
npm run check
./test.sh
grep -rn "Breakpoint\|action_required\|ActionInfo\|ActionRequired\|peekAction\|executeAction\|runToCompletion\|SettledResumeOutcome" \
  packages/*/src packages/*/test packages/agent/docs/harness.md
grep -rn "delete_prefix\|interface Deps\b" packages/agent/src
grep -rn "SliceNotImplemented" packages/agent/src/harness/runtime2   # watchSession only
```

Stop condition: grep results as specified; every `RunPhase`/`CompactionState`/`NavigationState` driveable and reconcilable; every milestone exit condition met; reviews at M1, M3, M5, M7 and final report no findings; `harness.md` updated in the same commits as its code.
