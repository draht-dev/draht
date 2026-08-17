# Harness RPC Design Notes

> **Status:** Design input, not a normative contract. Required trailing `Context` parameters have landed across the harness, sessions, hosted-harness interfaces, server manager, and worker adapters. The current Pi service protocol remains a hand-written projection and still enters through `TODO_CONTEXT`; generic harness/session proxies, request cancellation, and trace-carrier propagation remain design or implementation work. Fold accepted final behavior into `harness.md`.

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
- receive one required trailing invocation context when the receiver method is context-aware.

`void` is represented by a successful response envelope without a result field. It does not require encoding `undefined` as a JSON value.

Remote object references and subscriptions are protocol envelopes, not domain codecs. Methods returning non-JSON domain objects require an adapter projection or a change to a JSON result shape.

Current examples requiring review include `SessionReader.getEntries()`, which returns a `Map`, and methods returning `AgentLane`, `SessionTree`, executable tools, or callback-bearing handles. The intended response is not a catalog of hand-written codecs. Use a remote reference, a JSON projection, or mark the member host-local.

## Context position

Receiver methods use one required trailing `Context`. The implemented `Context` has no runtime brand, so a generic proxy must use trusted method metadata to distinguish context-aware methods from methods with no context. Position does not solve method discovery by itself.

A trailing context keeps propagation visible and consistent across ordinary receivers and callbacks:

```ts
harness.prompt(text, undefined, context);
harness.prompt(messages, context);
```

The first form exposes a strict JSON issue: after removing the context, the optional image argument still occupies an `undefined` array slot. A generic adapter must normalize omitted trailing business arguments or use an adapter projection with an explicit JSON shape. The current Pi service protocol uses `PromptArguments` as such a projection; it never serializes the harness method's raw argument list.

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
→ use trusted method metadata to remove the required trailing Context, when present
→ normalize omitted optional arguments and validate remaining arguments as JSON
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

A trusted manifest records whether the target method receives a trailing context. Untrusted wire input cannot select context placement.

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
→ append context for a context-aware target method
→ invoke exposed real method or adapter override
→ validate result
→ return JSON/protocol envelope
```

A cancel frame aborts only the matching request controller. Disconnect aborts every active request and closes every subscription owned by that connection.

`packages/protocol/src/rpc.ts` already separates a server implementation context from serialized arguments through `RpcImplementation<TManifest, TContext>`. Its implementation context is dispatcher-owned and context-first; an adapter then calls the real receiver with its required trailing `Context`. The current client API has no invocation-context/cancellation/trace integration, and the manifest model does not yet cover remote object references or subscriptions.

## Current hosted-harness adapter

The current Pi service protocol is an explicit adapter, not the generic proxy described below. `PiServerHost`, `HostedHarnessHandle`, `HostedHarnessAttachment`, and `HostedHarnessWatch` receive trailing contexts, and `HostedHarnessManager` forwards one context through session discovery, creation, attachment, prompting, watch lifecycle, and close.

At Pi request ingress, `PiServer` still supplies `TODO_CONTEXT`. The coding-agent worker manager accepts contexts on its hosted interfaces, but worker operation frames carry neither cancellation nor trace metadata and the worker reconstructs calls with `TODO_CONTEXT`. This is interface propagation only, not remote cancellation or telemetry support.

## Remote object identity

In the future generic proxy, `AgentHarness`, `AgentLane`, `Session`, and `SessionTree` are stateful capabilities that cross RPC boundaries as opaque references. The current Pi service exposes session IDs and adapter-owned hosted handles instead; it does not expose these domain objects directly.

Target reference shape:

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

The current watch adapter preserves snapshot-first buffering and forwards an event context through in-process hosted-harness callbacks. The worker event frame and public Pi event envelope do not yet carry trace metadata, so both process boundaries lose the emitting context.

The final protocol requires each event frame to carry trace metadata from the context that emitted the event. The client reconstructs a fresh event-delivery context and invokes local listeners under that parent. It does not receive the server's `Context` object or arbitrary context values.

Subscriptions are ongoing invocation-scoped resources. They may retain their creation context and own cancellation controller; ordinary harness/session proxies may not. Aborting the subscription context or disconnecting must unconditionally unsubscribe. The current hosted interfaces expose contexts for watch creation, start, and unsubscribe, but no cancellation controller is connected to them yet.

The current protocol buffers events across the snapshot/start handshake but has no sequence numbers, acknowledgements, or bounded backpressure policy. Those mechanisms remain necessary to prevent unbounded memory growth and define delivery guarantees.

`watch()` and `watchSession()` additionally require a race-free snapshot handshake:

```text
server installs watcher in buffering mode
→ server captures snapshot
→ server sends subscription ID + snapshot
→ server starts buffered/future event delivery
→ client returns local WatchHandle
```

This preserves the current snapshot-plus-buffer semantics without serializing listener callbacks.

The current `PiClient` reconstructs its service-specific `PiLaneWatch` facade on top of `watch`, `startWatch`, and `stopWatch`. A future generic client may reconstruct the domain `Events`/`WatchHandle` experience on top of the richer subscription protocol described here.

## Request cancellation

Request cancellation is not implemented in the current Pi client, protocol, server, or worker transport. The final adapter maps each invocation's `abortSignal`, when present, to one request ID:

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

RPC telemetry is not implemented in the current wire protocol. The target parentage is:

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

The required trailing-context migration has landed, but it remains scaffolding rather than proof of RPC behavior.

`TODO_CONTEXT` marks a boundary whose real parent cannot yet be reconstructed. Current uses cluster at Pi protocol request ingress and worker RPC ingress. `BACKGROUND_CONTEXT` is reserved for intentional roots. Context-accepting shims that cannot yet transport cancellation or telemetry must not be described as semantic support.

Because the superseded harness implementation has been removed, all eventual semantics must target the current harness runtime. Old-runtime propagation changes are not implementation evidence.

## Required tests for the later handoff

Current protocol and server tests cover manifest-based argument/result validation, ordinary Pi service calls, attachment/watch lifecycle, and snapshot-first event buffering. Remaining generic RPC and context coverage includes:

- static rejection of non-JSON ordinary interface members;
- runtime rejection of functions, cycles, non-finite numbers, sparse arrays, and class instances;
- trailing context is removed from serialized arguments and reconstructed server-side;
- omitted optional arguments are normalized without serializing `undefined`;
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

## Resolved migration decisions

- Context-aware receiver methods use one required trailing `Context`.
- `Context`, `AbortSignal`, and `TelemetryContext` objects are never serialized.
- The current Pi service remains an explicit adapter projection rather than a generic `AgentHarness` proxy.

## Open decisions before `harness.md`

- whether all ordinary results must be JSON-compatible or some interfaces need RPC projections;
- static contract-checking API and test location;
- object-reference ownership, lifetime, and nested result encoding;
- exact adapter descriptor/override API;
- event flow-control and reconnection policy;
- whether remote transaction or hook protocols are required at all;
- telemetry carrier adapter ownership;
- drive ownership policy under multiple callers;
- exact package boundaries for generic RPC, harness adapters, and protocol schemas.
