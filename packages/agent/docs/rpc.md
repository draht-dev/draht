# Harness RPC Design Notes

> **Status:** Design input, not a normative contract or implementation handoff. Commit `3fbfcf48f` added context-last parameters and mechanically threads them through the current harness, session implementations, hooks, events, and backends. RPC integration, telemetry carriers, and cancellation semantics remain design work. Resolve the open decisions and fold the accepted behavior into `harness.md` before creating a work package.

## Goal

Make the ordinary `AgentHarness`, `AgentLane`, `Session`, and `SessionTree` surfaces straightforward to expose through RPC with generic client/server machinery and small adapter-specific touch-ups.

The core implementations remain transport-agnostic. They must not know about request IDs, serialization, sockets, remote references, trace carriers, disconnects, or subscription frames.

```text
AgentHarness / AgentLane / Session / SessionTree
                        ↑
                  server adapter
                        ↕
                  wire protocol
                        ↕
                  client proxies
```

Invocation context kills two integration problems at the boundary:

- the adapter reconstructs the telemetry parent for the server invocation;
- the adapter maps request cancellation/disconnect to `context.abortSignal`.

The core sees only an ordinary explicit `Context`.

## Landed interface state

The current public APIs put context last:

```ts
lane.drive(options, context);
session.getEntry(id, context);
harness.prompt(text, images, context);
```

This shape is now threaded through `AgentHarness`, `AgentLane`, `Storage`, `SessionReader`, `SessionMutator`, `SessionTree`, `Session`, `SessionRepo`, runtime2, hooks, events, and session backends. Hook handlers, event listeners, mutation callbacks, entry projectors, system-prompt callbacks, tool-context factories, and provider-message conversion receive the invocation context.

This is mechanical propagation, not complete RPC support. Known contract gaps are:

- optional business arguments became required `T | undefined` positions before context;
- `SessionReader.getEntries()` returns `Map`;
- methods and results expose remote object capabilities directly;
- `AgentHarnessTool.execute()` still receives a separate `AbortSignal` and no invocation `Context`;
- the exported `AgentHarnessToolContextSource` still has a zero-argument factory;
- `AgentHarnessOptions.telemetryContext` still installs receiver-level telemetry;
- callback surfaces such as hooks, `Session.mutate()`, and `runWhenIdle()` are not ordinary RPC.

The remaining `TODO_CONTEXT` uses are at coding-agent experimental process boundaries where RPC reconstruction has not been implemented.

## Non-goals

Do not:

- add RPC methods, reference types, request IDs, or transport state to real harness/session implementations;
- serialize `Context`, `AbortSignal`, `TelemetryContext`, hooks, tools, or callbacks;
- make the core depend on one transport or telemetry backend;
- use `AsyncLocalStorage` for parent discovery;
- hide durable cancellation behind an RPC disconnect;
- build per-method codecs for values already constrained to JSON.

## Ordinary RPC contract

An ordinary proxyable method should:

- return a promise;
- accept only `JsonValue`-compatible business arguments;
- return a `JsonValue`-compatible ordinary result or `void`;
- optionally receive one required invocation context in the declared context position.

`void` is represented by a successful response envelope without a result field. It does not require encoding `undefined` as a JSON value.

Remote object references and subscriptions are protocol envelopes, not domain codecs. Methods returning non-JSON domain objects require an adapter projection or a change to a JSON result shape.

Current examples requiring review include `SessionReader.getEntries()`, which returns a `Map`, and methods returning `AgentLane`, `SessionTree`, executable tools, or callback-bearing handles. The intended response is not a catalog of hand-written codecs. Use a remote reference, a JSON projection, or mark the member host-local.

## Context position and `undefined`

The implemented `Context` has no runtime brand. The landed receiver methods use context last, while methods such as `Session.view()` and host-local registration surfaces have no context. A generic proxy therefore needs trusted method metadata; position alone cannot distinguish contextual from non-contextual methods.

The landed shape has a strict JSON problem:

```ts
harness.prompt(text, undefined, context);
session.readList(address, undefined, context);
```

After the proxy strips context, the ordinary argument array still contains `undefined`, which is not a `JsonValue`.

The final design must choose one of these approaches:

1. move context first so optional business arguments remain trailing and can be omitted;
2. retain context last but add trusted arity metadata that removes trailing `undefined` values on the wire and restores their positions before invoking the implementation;
3. replace these positional optional arguments with JSON values such as options objects or `null`.

An untyped `undefined` sentinel is a protocol codec and weakens the strict JSON contract. Do not silently rely on `JSON.stringify()` converting array `undefined` to `null`.

## Contract checking

Use both static and runtime checks.

A mapped TypeScript assertion can reject ordinary members whose arguments/results are not JSON-compatible, are synchronous, or are non-method properties. Adapter-declared escape members are excluded from that ordinary check.

Runtime transport boundaries must reject:

- functions and symbols;
- `undefined` array entries;
- non-finite numbers;
- sparse arrays;
- cyclic data;
- class instances, `Map`, `Set`, `Date`, and other non-plain objects;
- symbol-keyed object state.

JavaScript reflection can enumerate exposed implementation methods and validate values from executed calls. It cannot invent semantically valid arguments for arbitrary methods, so it cannot automatically execute every interface member. Static contract assertions and focused behavior fixtures remain necessary.

TypeScript also permits concrete implementations to accept fewer parameters than their interfaces. Exact-signature type tests or explicit implementation inventories are needed during the context migration.

## Generic client call

Conceptually, the client proxy performs:

```text
method invocation
→ use method metadata to remove Context from its declared position, if present
→ validate remaining arguments as JSON
→ start rpc.client span
→ inject trace carrier
→ allocate request ID
→ send target + method + arguments + trace carrier
→ if context.abortSignal exists, send cancel(request ID) when it aborts
→ decode JSON result or remote protocol envelope
```

A request frame can be transport-specific, but carries equivalent information:

```ts
interface RpcRequest {
	id: string;
	target: ObjectReference;
	method: string;
	args: JsonValue[];
	trace?: JsonValue;
}
```

The trusted method manifest records whether context exists, its position, and any argument padding needed by the selected `undefined` policy. An untrusted client must not choose context placement.

The context object, its values, signal, and telemetry implementation never appear in `args`.

## Generic server call

The server performs:

```text
receive request
→ validate target, method, and JSON arguments
→ allocate request-local AbortController
→ derive cancellation context with withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
→ extract trace carrier into local TelemetryContext
→ start rpc.server span
→ derive Context with withTelemetryContext(serverSpan, cancellationContext)
→ insert context at declared position
→ invoke exposed real method or adapter override
→ validate result
→ return JSON/protocol envelope
```

A cancel frame aborts only the matching request controller. Disconnect aborts every active request and closes every subscription owned by that connection.

`packages/protocol/src/rpc.ts` already separates a server implementation context from serialized arguments through `RpcImplementation<TManifest, TContext>`. It can inform this design, but the current client API has no invocation-context/cancellation/trace integration and the manifest model does not yet cover remote object references or subscriptions.

## Remote object identity

`AgentHarness`, `AgentLane`, `Session`, and `SessionTree` are stateful capabilities. They cross RPC boundaries as opaque references:

```ts
interface ObjectReference {
	readonly id: string;
	readonly interface: "AgentHarness" | "AgentLane" | "Session" | "SessionTree";
}
```

The protocol serializes a reserved JSON envelope. The client decodes it into another identity-only proxy. A proxy retains transport and remote identity, never an invocation context.

Examples:

- `harness.lane()` returns an `AgentLane` reference;
- successful `harness.createLane()` contains an `AgentLane` reference;
- `session.createLane()` returns a `SessionTree` reference;
- `harness.sessionTree` resolves to a linked `SessionTree` reference.

References may be registry IDs or deterministic selectors. For example, `session.view(lane)` can be represented as `{ sessionId, lane }` without calling the server until a method on that tree is invoked.

## Adapter escape hatch

Most methods should use generic reflection/dispatch. Exceptional members are described in the server adapter, not implemented in the real harness/session classes.

Conceptual exposure:

```ts
function exposeHarness(server: RpcServer, harness: AgentHarness): ObjectReference {
	return server.expose(harness, {
		properties: {
			sessionTree: remote((target) => target.sessionTree),
		},
		results: {
			lane: optionalRemote("AgentLane"),
			createLane: resultRemote("AgentLane"),
		},
		subscriptions: {
			events: (target, publish) => installEventForwarder(target.events, publish),
		},
		excluded: ["hooks", "getTools", "setTools", "runWhenIdle"],
	});
}
```

The exact descriptor API is open. It should support these operations:

- invoke or decorate the corresponding real method;
- expose a returned object as another remote capability;
- project a readonly property;
- add a synthetic RPC projection when an existing callback/synchronous member cannot cross directly;
- create a subscription;
- exclude a host-local member.

No descriptor, `$rpc` envelope, or transport concept belongs in `AgentHarness`, `Lane`, `Session`, or `SessionTree` implementations.

## Surface classification

### `SessionTree`

Most asynchronous reads and writes are ordinary RPC after their argument/result types satisfy the JSON contract. Bound value/list payloads must themselves be JSON-compatible.

A derived tree proxy retains only session/tree identity. It never captures the context used to obtain it.

### `Session`

Ordinary candidates include inherited tree/reader operations, lane creation, and close.

Members requiring adaptation:

- `metadata`: include a JSON snapshot with the reference or expose an async getter;
- `idGenerator`: host-local capability, not remotely exposed;
- `view(lane)`: synchronous remote-object return; use a deterministic client proxy or adapter projection;
- `mutate(callback)`: not ordinary RPC because it contains executable callback code and holds the session mutation line.

If remote mutation is required, design a separate transaction protocol with explicit open/read/commit/close, timeout, cancellation, and disconnect behavior. Do not transparently serialize or reverse-call `Session.mutate()`.

### `AgentLane` and `AgentHarness`

Ordinary candidates include operation admission/drive/control, prompts, queue operations, navigation, configuration, inspection, idle waiting, lane lookup/creation, and close, subject to JSON-compatible types.

Members requiring adaptation or exclusion:

- returned `AgentLane` and `SessionTree` values become references;
- `runWhenIdle(callback)` is host-local; remote callers use `waitForIdle()`;
- executable tools and callback-bearing tool configuration remain host-local;
- constructor callbacks remain in the process hosting the harness;
- hooks remain host-local;
- events and watchers use subscriptions.

Plain resources such as skill and prompt-template data may cross when their complete values are JSON-compatible and contain no executable behavior.

## Hooks

Do not proxy `hooks.on()` as an ordinary method.

Hooks synchronously affect execution and may modify, block, decline, or terminate work. A remote hook requires explicit policy for:

- registration lifetime;
- invocation IDs and duplicate delivery;
- ordering;
- timeout/deadline;
- disconnect;
- retry;
- fail-open versus fail-closed behavior;
- telemetry and cancellation for the reverse call.

If remote hooks become a requirement, define a dedicated interceptor/reverse-RPC protocol. Do not make generic callback serialization part of the harness proxy.

## Events and watchers

Events are passive and one-way, so they map naturally to subscriptions.

A subscription protocol needs frames equivalent to:

```ts
type EventFrame =
	| { type: "subscribe"; requestId: string; target: ObjectReference; filter?: JsonValue }
	| { type: "subscribed"; requestId: string; subscriptionId: string }
	| { type: "event"; subscriptionId: string; sequence: number; value: JsonValue; trace?: JsonValue }
	| { type: "ack"; subscriptionId: string; sequence: number }
	| { type: "unsubscribe"; subscriptionId: string };
```

The server adapts host-local `events.on()` into this protocol. The real event bus remains unaware of RPC.

Each event frame carries trace metadata from the context that emitted the event. The client reconstructs a fresh event-delivery context and invokes local listeners under that parent. It does not receive the server's `Context` object or arbitrary context values.

Subscriptions are ongoing invocation-scoped resources. They may retain their creation context and own cancellation controller; ordinary harness/session proxies may not. Aborting the subscription context or disconnecting sends/unconditionally performs unsubscribe.

The transport must buffer events arriving between server subscription installation and client reference decoding. Sequence numbers plus acknowledgements or a bounded flow-control policy prevent unbounded memory growth.

`watch()` and `watchSession()` additionally require a race-free snapshot handshake:

```text
server installs watcher in buffering mode
→ server captures snapshot
→ server sends subscription ID + snapshot
→ server starts buffered/future event delivery
→ client returns local WatchHandle
```

This preserves the current snapshot-plus-buffer semantics without serializing listener callbacks.

A future client facade may reconstruct the familiar local `Events`/`WatchHandle` experience on top of this protocol. That facade lives in the RPC client package.

## Request cancellation

The adapter maps each invocation's `abortSignal`, when present, to one request ID:

```text
client context.abortSignal aborts
→ cancel(request ID)
→ server request AbortController aborts
→ reconstructed context.abortSignal aborts
```

An undefined client `abortSignal` means that the call has no client-side cancellation signal. Pre-aborted calls must not start server work. Disconnect aborts all active request controllers for that connection.

This is process-local invocation cancellation. It must not call `requestAbort()` or write durable `cancel_requested` automatically.

## `drive()` concurrency

RPC does not decide whether a `drive()` caller installs execution or joins an existing process-local owner. The core lane arbitration decides that after receiving the reconstructed context.

Every concurrent RPC has an independent `abortSignal` and telemetry parent. Never combine every joiner's signal into the active execution signal. A canceled joiner must cancel only its own wait.

The runtime must choose one execution ownership policy:

- installer-owned execution;
- caller leases, where execution stops only after the last waiter leaves;
- harness-owned execution independent of caller lifetime.

The adapter only maps disconnect to the affected invocation signal. See `telemetry.md` for joiner spans and the durable-cancellation distinction.

## Telemetry across RPC

RPC telemetry follows:

```text
client caller
└─ rpc.client
   └─ rpc.server
      └─ harness/session span
```

The client injects trace metadata from `rpc.client`; the server extracts a new local parent before `rpc.server`. No telemetry object crosses the wire.

A joiner's `rpc.server`/`drive.join` spans remain under the joiner's incoming trace. They correlate with active execution by lane, operation ID, execution ID, and eventually span links. They cannot become a second parent of already-running execution.

Event frames independently inject the source event context so client-side event processing remains related to the operation that emitted the event rather than the subscription-establishment call.

## Security and lifecycle

The server exposure layer must:

- allowlist methods or derive a trusted manifest rather than reflecting arbitrary property names from untrusted input;
- validate all request arguments before invocation and results before response;
- reserve and validate protocol-envelope keys;
- scope object references and subscriptions to the appropriate connection/authorization domain;
- release references, active requests, and subscriptions on disconnect;
- prevent clients from selecting arbitrary server-side context placement or internal implementation members;
- treat telemetry recording failures as passive and business-neutral.

Authentication, authorization, and tenant metadata may be reconstructed as typed local context values by the server adapter. Client-supplied arbitrary context values are not trusted and do not cross by default.

## Interface migration status

Commit `3fbfcf48f` updated the concrete current-runtime and session signatures rather than relying only on TypeScript's permissive `implements` checks. Context is mechanically forwarded through the agent package and session backends.

`TODO_CONTEXT` marks a boundary whose real parent is not yet reconstructed. `BACKGROUND_CONTEXT` is reserved for intentional roots. The remaining production `TODO_CONTEXT` uses are in coding-agent experimental server/worker code; they are the RPC integration boundary, not completed propagation.

Compilation proves signature coverage only. It does not prove correct trace parentage, pre-abort admission, drive ownership, durable cancellation, or RPC behavior. All eventual semantics target the current harness runtime; changes to the removed runtime are irrelevant.

## Required tests for the later handoff

- static rejection of non-JSON ordinary interface members;
- runtime rejection of functions, cycles, non-finite numbers, sparse arrays, and class instances;
- context is removed from serialized arguments and reconstructed server-side;
- landed context-last calls, plus the selected JSON-safe optional-argument strategy;
- ordinary transparent method calls;
- nested remote references and stable proxy identity;
- adapter override invokes/decorates the real method;
- property and synchronous remote-object projections;
- unknown target/method and malformed envelope rejection;
- pre-aborted request starts no server work;
- one request cancellation does not abort another;
- disconnect aborts requests and closes subscriptions;
- client/server telemetry parentage;
- malformed/missing trace carrier degrades safely;
- event subscription establishment race;
- event source telemetry reconstruction;
- unsubscribe, disconnect, ordering, buffering, and backpressure;
- snapshot plus buffered events has no observation gap;
- drive joiner cancellation does not cancel shared execution;
- invocation cancellation writes no durable cancellation state.

## Open decisions before `harness.md`

- whether to retain context last or migrate context first;
- if context remains last, the JSON-safe trailing-`undefined`/arity protocol;
- whether all ordinary results must be JSON-compatible or some interfaces need RPC projections;
- static contract-checking API and test location;
- object-reference ownership, lifetime, and nested result encoding;
- exact adapter descriptor/override API;
- event flow-control and reconnection policy;
- whether remote transaction or hook protocols are required at all;
- telemetry carrier adapter ownership;
- drive ownership policy under multiple callers;
- exact package boundaries for generic RPC, harness adapters, and protocol schemas.
