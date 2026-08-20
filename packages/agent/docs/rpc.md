# Plugin Service RPC Design Notes

> **Status:** Design input, not a normative contract or implementation handoff. This document specifies only the RPC semantics required by `plugins.md`. Exact control-frame shapes and local proxy implementation are intentionally deferred.

## Role

`provide()`/`use()` and `provideKeyed().spawn()`/`observe()` are the plugin system's hidden RPC. Plugin facets share TypeScript service contracts, while the transport carries only service/member identifiers, strict JSON values, request/subscription correlation, and trace/control metadata. Hosts construct the typed local implementation or facade; TypeScript types and arbitrary objects never cross the wire. Connected hosts may temporarily run different manifest generations, so their service contracts must remain forward compatible across the supported skew window; version negotiation remains deferred.

```text
session/server facet: provide() / provideKeyed().spawn()
                    ↕ hidden service RPC
presentation/session facet: use() / observe()
```

The service system is the plugin boundary. Presentation facets receive semantic services, replicated state, and semantic events; they never receive a raw Harness, Session, tool registry, hook registry, credential store, or storage handle.

## Non-goals

Do not serialize `Context`, `AbortSignal`, telemetry objects, callbacks, tools, hooks, functions, or arbitrary object graphs. Do not make core Harness or Session implementations aware of transport mechanics. Do not make disconnect perform durable or service-owned cancellation. Do not build per-method codecs for values already constrained to JSON.

## Service contracts and typed facades

A remote-service token is a shared TypeScript contract and stable service ID. It is not a generated descriptor and creates no provider. `provide()` exposes one singleton implementation. `provideKeyed()` registers one keyed-service owner during facet setup and returns a scoped handle whose later `spawn()` calls expose instances. A token has one mode in one namespace: mixing singleton and keyed use is an error.

The provider must make enough control-plane information available for the host to validate an accessed member as a method, `RemoteState`, or `RemoteEvents`. The consumer must be able to obtain the member name from ordinary property access—for example, a JavaScript `Proxy` receives `"state"` for `models.state` and `"refresh"` for `models.refresh(context)`. How a disconnected lazy proxy represents an unresolved member, and the exact provider-kind validation exchange, are implementation details.

A local `use()` returns the actual implementation. A remote `use()` returns one stable, lazy typed facade shared by local consumers of that token. While disconnected, invoking a method fails and state remains unhydrated; no call is queued merely because it was made through a proxy.

Remote methods return promises and accept and return strict JSON apart from their declared `Context`; `void` is a successful response without a result field. A private returned reference is a separately validated control envelope, not a business JSON value. The client removes the context before transport and the receiving host constructs a fresh local context. The contract position is host-controlled and must be consistent; the current examples use one required trailing `Context`. Business absence is JSON `null` or an options object, never transported `undefined`.

Use static assertions and runtime validation. Static checks constrain remote methods and state/event members; runtime boundaries reject unsupported members and non-JSON arguments, results, state, and event values. TypeScript supplies typed facades but does not authenticate a peer or create runtime metadata.

## Dependency ledger

Type erasure does not hide service identity: every service token retains its stable ID at runtime. Facet contexts are created by the host with a non-forgeable owner identity, and their setup-time service methods append to a generation-scoped ledger:

- `provide()` records a singleton provision;
- `provideKeyed()` records a keyed provision;
- `use()` records a singleton requirement; and
- `observe()` records a keyed requirement.

The context or namespace on which the method is called supplies the service scope (`local`, `server`, or `session`). The method supplies the mode. The token supplies the ID. The host therefore needs no reflection over the erased `T` and no handwritten parallel dependency list.

First acquisition or provision is permitted only during facet setup. Later commands, hooks, events, and activation callbacks use setup-acquired singleton facades, observer registrations, or keyed-provider handles. In particular, dynamic keyed instances are spawned through the handle returned by `provideKeyed()`; a late direct `spawn(service, ...)` cannot introduce a previously undeclared provision.

After setup, each host produces a JSON-safe facet plan containing owner, facet kind, requirements, and provisions. Host control combines plans by scope, service ID, and mode to reject missing or duplicate providers and mode mismatches, derive allowlists, and record lifecycle edges. This service graph is distinct from the module loader's source import graph.

## Namespaces, bindings, and identity

The host exposes two remote namespaces: `server` names services provided by the connected server; `session` names services from the presentation's currently selected session. A session-service call never accepts a client-selected durable `sessionId`. The server authorizes attachment and routes the selected session namespace to its worker.

### Server control plane

Session listing and management are ordinary server singleton services, not generic remote `Session` methods. `SessionDirectory` exposes presentation-safe session summaries as replicated state plus semantic directory events. `SessionManagement` exposes `create`, `remove`, `attach`, and `detach` methods. Presentation facets consume both through `server.use()`:

```ts
const directory = context.server.use(SessionDirectory);
const management = context.server.use(SessionManagement);
```

The server derives workspace and client authority from its locally authenticated identity, not from the summary or method arguments. It may project directory state per client; either way, summaries never expose server-private fields such as owner IDs or working directories.

`management.attach(sessionId, context)` is the bridge between the namespaces. The server authorizes the requested managed session, closes the presentation's previous session-scoped requests, subscriptions, references, and observer tasks, binds its `session` namespace to the worker, then hydrates the new singleton state and keyed-instance directory. `session.attachment` is host control state reporting this selection and its health; it is not a directory service. `detach()` performs the same cleanup without a replacement.

The host needs a private, host-owned binding incarnation for that route. It changes when the presentation attaches, detaches, switches session, or replaces a failed worker. Its representation is deliberately unspecified. The binding prevents a delayed frame for the old selected session from being applied to the new one; it is not a plugin-visible service value or a substitute for authorization.

A state or event source has structural identity:

```text
(provider binding, service ID, optional instance key + generation, member name)
```

There is no separately discoverable state ID. A spawned instance key is a plugin-level logical key. Its host-owned generation changes when a closed key is reused, so a stale proxy cannot call the replacement. `requestId` identifies one transport invocation for response, cancellation, and tracing. A Harness/tool `invocationId` may be a useful instance key—as in the question plugin—but it does not replace the service, binding, or generation parts of the live address.

## Calls, context, and routing

A call carries enough control-plane information to select a namespace, service, optional keyed instance, and member, plus a request ID, JSON arguments, and trace carrier. The server may parse those control-plane fields to route a session call, but it does not parse plugin business payloads or load plugin contracts. The service endpoint validates the member and values, creates a request-local abort controller and `Context`, installs authenticated client identity as a server-created context value, and invokes the local implementation.

The client maps `context.abortSignal` to cancellation of that one request. Disconnect cancels that connection's active calls and closes its subscriptions. Neither action cancels service-owned work or writes durable Harness cancellation. Per-client request correlation reaches the worker so request IDs from different presentations cannot collide.

## Replicated state, events, and keyed instances

`RemoteState` is authoritative latest-value replication, not event history, durable storage, a CRDT, or multi-writer state. A cold replica has `value === undefined`; subscribing before hydration records a listener without invoking it. Hydration installs a complete snapshot atomically before later updates are delivered, so there is no snapshot/update gap. Once hydrated, `value` is synchronous and subscribing reports the current value followed by later updates. The first snapshot callback uses a fresh hydration context; an already hydrated replica uses a fresh local delivery context rather than retaining the original write context. State values are borrowed immutable JSON and are not defensively cloned; callers must not mutate or retain them.

The providing host attaches source trace metadata to updates. The consumer reconstructs fresh delivery contexts; hydration uses a fresh context parented to the subscription. Disconnect may retain a value as stale display data. Reconnect replaces it from a complete snapshot, while a switch to a different provider clears readiness and disposes binding-specific resources. The precise subscription, buffering, sequence, acknowledgement, and flow-control frames are transport mechanics.

`RemoteEvents` is a projection of provider-local events. Listeners run only in the consuming process; callbacks never cross the wire. Events are non-durable and never replayed after reconnect. Event delivery carries source trace metadata. State subscriptions, event subscriptions, and their cleanup are host-owned resources, not retained caller contexts.

`observe()` is keyed-instance discovery, not a `RemoteState` containing proxies. It reconciles a complete initial directory with ordered additions, replacements, and removals. Each instance's initial state members hydrate before its observer task starts. Closing an instance rejects new calls, aborts only that instance's observer task, and allows admitted calls to settle. A stable `session.observe()` registration aborts old tasks and reconciles the fresh directory on a binding switch.

## Private returned references

A service method may return a private remote reference for caller-owned work, such as `IndexJob`. This is distinct from a keyed service: a reference is passed explicitly and is not discovered by `observe()`. It is scoped to the recipient and its provider/binding lifetime, and must be invalidated on the relevant close, switch, or disconnect. Exact reference encoding, ownership, and collection remain open.

No generic Harness projection is part of this design. Raw Harness, Session, lane, tool, hook, and storage objects remain local authority. If a future integration needs a remote callback or a general object capability, it needs a separate explicit protocol and policy; it is not an extension of service RPC.

## Context, cancellation, and telemetry

Every remote method receives a fresh local `Context`; the sender's object, signal, telemetry implementation, and arbitrary typed values never cross the wire. The client starts `rpc.client`, injects its trace carrier, and maps the call's abort signal to that request. The endpoint extracts the carrier, starts `rpc.server`, and constructs a request-local abort signal and server-created typed values such as authenticated client identity.

```text
caller
└─ rpc.client
   └─ rpc.server
      └─ service implementation
```

State and event delivery independently carry source trace metadata. The consumer reconstructs a delivery context from it rather than retaining the context that established the subscription.

Three cancellation domains remain separate: aborting one RPC invocation; explicitly cancelling service-owned work such as `job.cancel()`; and durable Harness cancellation such as `requestAbort()`. Transport cancellation and disconnect perform only the first. Work that outlives a call must detach into a service-owned task with its own controller and telemetry root.

## Security and lifecycle

Only manifest-allowlisted remote service IDs may be provided or registered as keyed services. Only the owning keyed-provider handle may spawn instances. Local services are never discoverable remotely. Providers validate member kinds and every JSON business value; clients cannot forge control envelopes as ordinary values, choose instance generations, select another session's route, choose server context values, or cancel another client's request.

The server authenticates its connection and authorizes attachment. It reconstructs client identity locally at the service endpoint; ordinary arguments never carry authority. Credentials, prompts, completions, tool data, filesystem contents, and other sensitive values cross only through an explicit presentation-safe contract.

Facet scopes own registrations, spawned instances, subscriptions, observations, in-flight RPCs, and presentation resources. Disposal and binding changes close the relevant resources in dependency order. The provider's own session work remains alive unless its own lifecycle policy stops it.

## Required tests

Test the plugin-facing semantics over loopback and a real framed transport:

- setup-time dependency-ledger ownership, rejection of late acquisition, local and remote `use()`, keyed-provider ownership, singleton/keyed mode validation, manifest allowlisting, lazy member access, and local services remaining unreachable remotely;
- strict JSON boundaries, method context reconstruction, request cancellation isolation, and trace propagation without serializing context values;
- server/session namespace isolation, authorized attach, selected-session switching, stale-frame rejection, and worker-side per-client request correlation;
- cold and hydrated `RemoteState`, snapshot/update race freedom, delivery contexts, stale display on reconnect, and clearing on provider switch;
- event subscription setup, non-replay, ordering, cleanup, and bounded flow control;
- instance directory hydration, ordered reconciliation, state hydration before observer tasks, generation-based stale rejection, and task cleanup on close or switch;
- private returned-reference lifetime distinct from keyed-service discovery; and
- the question and shared-review patterns: concurrent instances, late presentation attachment, disconnect without cancelling session work, worker replacement, and durable application-level settlement.

## Open protocol mechanics

The following are intentionally not specified here: exact control-frame schemas; member-kind discovery and lazy-proxy implementation; subscription sequencing, acknowledgements, buffering, and flow control; provider replacement and reference collection; and how a future multi-pane presentation represents more than one selected session. They must preserve the semantics above without changing the plugin contract.

## Example: directory and selected session

The directory and management services are normal server services. Their contracts carry only presentation-safe values:

```ts
interface SessionSummary {
	sessionId: string;
	title: string;
	workspaceId: string;
	status: "starting" | "active" | "idle" | "closed" | "unreachable";
	updatedAt: string;
}

type SessionDirectoryEvent =
	| { type: "created" | "changed"; session: SessionSummary }
	| { type: "deleted"; sessionId: string };

interface SessionDirectoryService {
	readonly state: RemoteState<{ revision: number; sessions: SessionSummary[] }>;
	readonly events: RemoteEvents<SessionDirectoryEvent>;
}

interface SessionManagementService {
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

const SessionDirectory = defineRemoteService<SessionDirectoryService>("session-directory");
const SessionManagement = defineRemoteService<SessionManagementService>("session-management");
```

A server facet supplies the services. The host-local attachment capability derives the client from `Context`, authorizes the requested session, and performs the binding transition:

```ts
serverContext.provide(SessionDirectory, { state: directoryState, events: directoryEvents });
serverContext.provide(SessionManagement, {
	async attach(sessionId, context) {
		const client = requireClientIdentity(context);
		authorizeSession(client, sessionId);
		await attachments.bind(client.clientId, sessionId, context);
	},
	async detach(context) {
		await attachments.unbind(requireClientIdentity(context).clientId, context);
	},
});
```

A presentation uses server services to render and select, then continues using the same stable session-service facade after the host rebinds it:

```ts
const directory = tuiContext.server.use(SessionDirectory);
const management = tuiContext.server.use(SessionManagement);
const models = tuiContext.session.use(Models);

tuiContext.commands.register("sessions.switch", async (operation) => {
	const snapshot = directory.state.value;
	if (snapshot === undefined) return;

	const sessionId = await tuiContext.ui.select(
		"Sessions",
		snapshot.sessions.map((session) => ({ label: session.title, value: session.sessionId })),
		{ signal: operation.abortSignal },
	);
	if (sessionId !== undefined) await management.attach(sessionId, operation);
});

// After attach() settles, `models` addresses the selected worker. Its state
// is cleared or retained as stale according to the binding transition, then
// replaced by that worker's fresh authoritative snapshot.
```

The presentation never routes `models` with a selected `sessionId`; that remains host routing state. The server closes the prior session binding's resources before hydrating the new one.
