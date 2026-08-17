# Harness RPC Design Notes

> **Status:** Design input, not a normative contract or implementation handoff. After the invocation-context interface migration lands, reconcile these notes with the actual interfaces, resolve the open decisions, and fold the accepted behavior into `harness.md` before creating a work package.

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
- the adapter maps request cancellation/disconnect to `context.signal`.

The core sees only an ordinary explicit invocation context.

## Non-goals

Do not:

- add RPC methods, reference types, request IDs, or transport state to real harness/session implementations;
- serialize `InvocationContext`, `AbortSignal`, `TelemetryContext`, hooks, tools, or callbacks;
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

## Context position

A generic proxy can support context first, context last, or no context by using a runtime brand or method metadata. Position does not solve method discovery by itself.

Context first is preferable under a strict JSON argument contract:

```ts
harness.prompt(context, text);
harness.prompt(context, text, images);
```

With context last, an optional argument before context requires an `undefined` array slot:

```ts
harness.prompt(text, undefined, context);
```

`undefined` is not a `JsonValue`. Context first leaves optional business arguments trailing and omittable. The final interface migration must settle this before the signature becomes normative.

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
→ find and remove branded InvocationContext
→ validate remaining arguments as JSON
→ start rpc.client span
→ inject trace carrier
→ allocate request ID
→ send target + method + arguments + trace carrier
→ on context.signal abort, send cancel(request ID)
→ decode JSON result or remote protocol envelope
```

A request frame can be transport-specific, but carries equivalent information:

```ts
interface RpcRequest {
	id: string;
	target: ObjectReference;
	method: string;
	args: JsonValue[];
	contextPosition: "first" | "last" | "none";
	trace?: JsonValue;
}
```

`contextPosition` records where the server must insert its fresh local context. A trusted manifest may contain this metadata instead of accepting it from the wire.

The context object, its values, signal, and telemetry implementation never appear in `args`.

## Generic server call

The server performs:

```text
receive request
→ validate target, method, and JSON arguments
→ allocate request-local AbortController
→ extract trace carrier into local TelemetryContext
→ construct fresh local InvocationContext
→ start rpc.server span
→ derive context containing rpc.server span
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

Each event frame carries trace metadata from the context that emitted the event. The client reconstructs a fresh event-delivery context and invokes local listeners under that parent. It does not receive the server's `InvocationContext` object or arbitrary context values.

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

The adapter maps each invocation signal to one request ID:

```text
client signal abort
→ cancel(request ID)
→ server request AbortController aborts
→ reconstructed context.signal aborts
```

Pre-aborted calls must not start server work. Disconnect aborts all active request controllers for that connection.

This is process-local invocation cancellation. It must not call `requestAbort()` or write durable `cancel_requested` automatically.

## `drive()` concurrency

RPC does not decide whether a `drive()` caller installs execution or joins an existing process-local owner. The core lane arbitration decides that after receiving the reconstructed context.

Every concurrent RPC has an independent signal and telemetry parent. Never combine every joiner's signal into the active execution signal. A canceled joiner must cancel only its own wait.

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

## Interface migration

The initial context change is scaffolding, not proof of RPC behavior.

`TODO_CONTEXT` marks a caller whose real parent is not yet threaded. `BACKGROUND_CONTEXT` is reserved for intentional roots. Temporary implementation shims may ignore context to make the repository compile, but they must not be described as cancellation or telemetry support.

Because the superseded harness implementation has been removed, all eventual semantics must target the current harness runtime. Old-runtime propagation changes are not implementation evidence.

## Required tests for the later handoff

- static rejection of non-JSON ordinary interface members;
- runtime rejection of functions, cycles, non-finite numbers, sparse arrays, and class instances;
- context is removed from serialized arguments and reconstructed server-side;
- both supported context positions or the selected final position;
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

- final context type, field names, brand, and argument position;
- whether all ordinary results must be JSON-compatible or some interfaces need RPC projections;
- static contract-checking API and test location;
- object-reference ownership, lifetime, and nested result encoding;
- exact adapter descriptor/override API;
- event flow-control and reconnection policy;
- whether remote transaction or hook protocols are required at all;
- telemetry carrier adapter ownership;
- drive ownership policy under multiple callers;
- exact package boundaries for generic RPC, harness adapters, and protocol schemas.
