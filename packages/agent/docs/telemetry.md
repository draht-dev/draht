# Invocation Context and Telemetry Design Notes

> **Status:** Design input, not a normative contract or implementation handoff. After the invocation-context interface migration lands, reconcile these notes with the actual types, resolve the open decisions, and fold the accepted design into `harness.md`. `telemetry-schema.md` remains the generated reference for span names and attributes.

## Goal

`Session`, `SessionTree`, `AgentLane`, and `AgentHarness` must receive invocation-scoped control data explicitly. The same receiver may serve concurrent local callers or RPC clients, so it cannot retain a mutable or default caller context.

The invocation context must solve two related problems without `AsyncLocalStorage`:

1. preserve correct telemetry parentage through concurrent asynchronous work;
2. carry the `AbortSignal` that an RPC adapter can map to request cancellation.

This work must reuse `@draht/telemetry`. It must not introduce another span abstraction.

## Target context model

The final names still need reconciliation with the interface migration. The intended semantics are:

```ts
interface InvocationContext {
	readonly signal: AbortSignal;
	readonly telemetry: TelemetryContext;
	value<T>(key: ContextKey<T>): T | undefined;
}
```

A context is immutable. Derivation creates a parent-linked layer:

```ts
const requestContext = withSignal(parentContext, requestSignal);
const spanContext = withTelemetry(requestContext, span);
const tenantContext = withContextValue(spanContext, tenantKey, tenantId);
```

Required properties:

- `signal` is always present. The background context uses a never-aborted signal rather than `undefined`.
- `telemetry` is always present. The background context uses `NOOP_TELEMETRY_CONTEXT`.
- typed values use symbol identity and immutable copy-on-write layers;
- context values are cross-cutting request metadata, not business dependencies;
- contexts, signals, telemetry objects, and backend-native span objects are never durable data.

Suitable typed values include request IDs, authenticated principals, tenant IDs, and diagnostic metadata. Storage, models, tools, durable state, and business payloads do not belong in the context.

## Receiver ownership

Shared receivers retain identity and durable/process state, not invocation context:

```text
AgentHarness receiver  ── no caller context
AgentLane receiver     ── no caller context
Session receiver       ── no caller context
SessionTree receiver   ── no caller context
```

Every invocation supplies its own context. This prevents concurrent callers from overwriting each other's telemetry parent or cancellation signal.

A process-local object representing one ongoing invocation may retain its derived context. Examples are an active drive task or an event subscription. This is different from storing a default context on the shared harness or session receiver.

`AgentHarnessOptions.telemetryContext` must disappear. A harness-level default cannot represent two concurrent callers with different parents.

## Existing typed telemetry remains authoritative

The design retains:

- `TelemetryContext` and `TelemetrySpan`;
- callback-owned span lifetime;
- `AI_TELEMETRY_SCHEMA` and `HARNESS_TELEMETRY_SCHEMA`;
- typed span names, start attributes, completion attributes, and events;
- `startAiSpan()`, `startHarnessSpan()`, and `createTypedSpanStarter()`;
- adapter conformance behavior.

Starting a harness span must derive the invocation context passed to lower work:

```ts
return startHarnessSpan(
	context.telemetry,
	"pi.harness.run",
	attributes,
	async (span) => {
		const runContext = withTelemetry(context, span);
		return runDrive(runContext);
	},
);
```

A helper may package this pattern by giving its callback both the typed span and the derived invocation context. It still delegates to the existing `TelemetryContext.startSpan()` contract.

Do not mutate a context to install an active span. Do not use a process-global or receiver-global current span.

## Concurrent parentage

Explicit propagation supports concurrent sibling calls:

```ts
await parent.telemetry.startSpan({ name: "caller" }, async (callerSpan) => {
	const callerContext = withTelemetry(parent, callerSpan);
	await Promise.all([
		laneA.drive(callerContext, optionsA),
		laneB.drive(callerContext, optionsB),
	]);
});
```

Each invocation derives its own child context. Nested work receives the child belonging to that invocation. Correct parentage does not depend on promise scheduling or ambient state.

Tests must cross concurrent branches deliberately so accidental receiver-level context is visible. A sequential parent/child test is insufficient.

## Callbacks, hooks, and events

Host-local callbacks invoked as part of an operation receive the current invocation context:

```ts
handler(event, context);
tool.execute(context, invocation, arguments);
mutation(mutator, context);
```

A hook span derives a child context before invoking the hook. Hook-triggered lower work therefore remains under `pi.harness.hook`.

Events preserve the context that caused each event. A buffered event watcher must buffer `{ event, context }`, not only `event`; otherwise delayed delivery is parented to the wrong caller. Each listener invocation starts `pi.harness.event_handler` from the event context and passes the resulting child context to the listener.

Event registration itself is host-local configuration and has no operation parent. Event delivery has the operation parent.

Session commits similarly start `pi.session.write` from the invocation that issued the transaction. The mutation callback and its sole commit continue to use the same explicit invocation lineage unless they deliberately derive child spans.

## Drive execution and joiners

Several callers may call `drive()` for the same durable operation. Arbitration decides which call installs process-local execution and which calls join it. This is a core runtime concern, not an RPC concern; concurrent local callers have the same issue.

One active execution has one telemetry parent. It cannot be reparented when another caller joins.

```text
installer caller
└─ drive.execute
   └─ provider/tool work

joiner caller
└─ drive.join
```

A joiner span describes that caller's wait. It carries at least lane name, durable operation ID, and a process-local execution ID. It ends with an outcome such as `settled`, `caller_cancelled`, `execution_stopped`, or `harness_closed`.

The joiner must not overwrite the active execution context. Correlate the two spans using operation/execution attributes. Telemetry span links would model this relationship better, but the current telemetry contract has no links. Adding links is an optional telemetry-package design question, not a reason to invent multiple parents.

Distributed traces permit an execution span to outlive the installer RPC span. Parent and child spans may overlap or settle in either order once the child has started.

## Invocation cancellation versus durable cancellation

An aborted invocation signal is process-local control. It does not mean that durable cancellation was requested.

```text
context.signal aborts
→ stop or detach process-local waiting/work according to drive ownership policy
→ do not write cancel_requested
→ preserve a valid durable restart point
```

Only `requestAbort()`/`abort()` writes durable `cancel_requested` and permits durable aborted settlement.

The runtime must track the stop cause instead of interpreting every aborted provider response as durable cancellation:

```ts
type ExecutionStopCause =
	| "no_drive_waiters"
	| "invocation_cancelled"
	| "harness_closed"
	| "durable_cancel_requested";
```

Only `durable_cancel_requested` may normalize and commit a durable aborted outcome. An invocation/disconnect abort must not produce an assistant `stopReason: "aborted"` settlement while durable control remains `running`; that path would violate the durable state machine.

The drive ownership policy remains to be finalized:

1. **Installer-owned:** the installer signal controls execution; joiner signals control only their waits.
2. **Caller leases:** every drive caller owns a wait lease; execution is aborted process-locally only when the last lease disappears.
3. **Harness-owned:** drive execution survives all caller disconnects until durable settlement, durable cancellation, close, or fault.

Signals from unrelated joiners must never be combined with `AbortSignal.any()` and attached directly to shared execution. One canceled joiner cannot cancel every other caller.

## RPC trace propagation

Client and server spans can belong to one distributed trace:

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ harness/session operation
```

The client does not serialize `TelemetryContext`. It injects a backend-neutral trace carrier from the `rpc.client` span. The server extracts that carrier into a fresh local `TelemetryContext` and starts `rpc.server` from it.

A transport-facing adapter boundary is required:

```ts
interface TelemetryPropagation {
	inject(context: TelemetryContext): JsonValue | undefined;
	extract(carrier: JsonValue | undefined): TelemetryContext;
}
```

A production implementation may use W3C `traceparent`/`tracestate`. The current telemetry package has no carrier injection/extraction API, so the accepted design must decide whether this adapter belongs in the telemetry package, RPC infrastructure, or a backend integration package. It must still reuse the existing `TelemetryContext` span contract.

RPC cancellation and telemetry propagation are independent control-plane channels:

- trace metadata reconstructs telemetry parentage;
- request ID plus cancel/disconnect messages controls the server request signal;
- neither channel appears in serialized method arguments.

## Interface migration scaffolding

`TODO_CONTEXT` is a temporary migration marker, not a semantic root. Use it where a caller has not yet been taught which context to propagate. `BACKGROUND_CONTEXT` means intentionally start without a caller.

TypeScript permits an implementation method to accept fewer parameters than its interface. Therefore changing public interfaces alone does not find every implementation or concrete-class call. The migration must:

- update concrete method signatures explicitly, even when they temporarily ignore `_context`;
- inventory concrete calls, callback adapters, and object-literal façades;
- grep or check `TODO_CONTEXT` separately;
- eventually remove every unapproved `TODO_CONTEXT` use.

This migration can make the repository compile before semantics are implemented. Compilation does not prove telemetry or cancellation correctness.

## Required tests for the later handoff

- immutable typed-value layering and key isolation;
- never-aborted background signal;
- crossed concurrent telemetry branches on one shared receiver;
- nested hook, tool, event-handler, and session-write parentage;
- buffered events retain their emitting context;
- no receiver-level telemetry default;
- pre-aborted invocation starts no external effect;
- installer and joiner cancellation isolation;
- last-waiter/owner policy selected by the final design;
- invocation abort leaves resumable durable state;
- durable abort commits the durable aborted outcome;
- close and disconnect do not masquerade as durable cancellation;
- client → server trace reconstruction;
- event delivery reconstructs source trace metadata;
- missing/malformed trace carriers degrade to no-op/root telemetry without affecting business behavior.

## Open decisions before `harness.md`

- final type and field names;
- context argument position;
- runtime brand and public visibility;
- installer-owned, lease-owned, or harness-owned drive execution;
- whether telemetry links are required for joiners;
- trace-carrier adapter ownership and shape;
- which context values, if any, may cross an RPC boundary;
- exact span names/outcome attributes for RPC calls and drive join waits.
