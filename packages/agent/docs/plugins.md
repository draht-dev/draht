# Coding-Agent Application Hosts and Plugin Facets

> **Status:** Tentative design input, not a normative contract or implementation handoff. The transport-neutral service token, provider, singleton `use()`, keyed `observe()`, and `RemoteState` substrate now have an experimental implementation; the application host contexts, plugin kernel, events, references, telemetry propagation, and most example facets remain illustrative. Reconcile this design with `rpc.md`, `telemetry.md`, and the final harness contract before adding it to `harness.md` or creating a work package.

This document assumes you already understand `AgentHarness`, `AgentLane`, `Session`, `SessionTree`, `SessionRepo`, invocation `Context`, and telemetry. Read `rpc.md` for wire frames, remote references, subscriptions, and trace carriers, and `telemetry.md` for context propagation and cancellation semantics.

## Bird's-eye view

The new coding agent is assembled from an ordered plugin manifest, not a monolith with an extension API bolted on. Three layers:

1. The **plugin kernel** owns generic lifecycle mechanics: ordered setup, activation, scoped resource ownership, failure rollback, and reverse-order disposal. It knows nothing about Harness, tools, TUI components, RPC services, connections, or coding-agent policy.
2. An **application host** owns one concrete runtime and constructs the plugin bindings for that runtime. The **session host** normally runs in a dedicated session worker and owns session authority — the real Harness. A **presentation host** (TUI today, web later) owns a user interface. A **server host** owns server-wide authority: session records (`SessionRepo`), session-worker management, authentication, attachment, and routing between presentations and session workers.
3. A **plugin package** implements one feature as one or more host-specific **facets** — setup functions, one per host kind. Each facet receives only the bindings natural to its host instance and process.

The initial topology has one server and no server-to-server links:

```text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
```

A presentation and a session worker each connect to the server. There is no direct presentation→session-worker connection; the server routes service calls to the selected worker. The server lists and manages only its own sessions. Multi-server routing and server hierarchies are out of scope.

A session worker normally owns one session, and each session facet is instantiated for that session. A server facet is instantiated once per server process and is shared across every session and presentation connected to it. Server facets should therefore be rare and limited to inherently server-wide concerns. Per-session feature state belongs in session facets; dedicated workers provide the preferred lifecycle, crash, and state isolation. Future co-location may preserve the same logical bindings without changing what objects a facet can access.

**Host** and **client** are roles per connection, not fixed process kinds. The server hosts presentation and session-worker connections. A session worker serves its provided session services and may consume server-provided services over the same RPC binding mechanism. "Client" below always names the connection role, never a kind of plugin.

## Why this shape

- **Authority stays where it belongs.** Provider credentials, tool execution, and per-session plugin data exist only in the session worker; session records and worker control exist only in the server. Nothing reaches a presentation except through a deliberate contract.
- **One feature stays coherent.** The question plugin's tool, dialog, and renderer ship in one package around one JSON contract, yet each facet is host-native code.
- **A new surface is presentation-only work.** A web facet for the question dialog or the session picker registers against existing tokens; session and server code do not change.
- **Server state stays server-wide.** A server facet is shared by all sessions and clients, so features use one only when their authority is inherently global to that server.
- **No privileged built-ins.** Built-ins and third-party plugins receive identical bindings, so shipping the product continuously exercises the extension API.
- **Testable in pieces.** A facet tests against its host bindings, a contract against loopback, and a routed TUI → server → session-worker path against a real transport — independently.

## One feature, several host facets

A coding-agent plugin is a feature bundle that may provide a facet for any host:

```ts
interface CodingAgentPlugin {
	readonly id: string;
	readonly server?: PluginFacet<CodingAgentServerPluginContext>;
	readonly session?: PluginFacet<CodingAgentSessionPluginContext>;
	readonly tui?: PluginFacet<CodingAgentTuiPluginContext>;
	readonly web?: PluginFacet<CodingAgentWebPluginContext>;
}

type PluginFacet<PluginContext> = (context: PluginContext) => void | Promise<void>;
```

`PluginFacet` is the only plugin-facing shape the generic kernel needs; the facet names and context types belong to the coding-agent application. Facets are optional: a `models.json` plugin has only a session facet, a terminal theme only a TUI facet, the session directory a server facet plus a TUI facet. Examples use an illustrative `definePlugin()` helper returning a `CodingAgentPlugin` — the loaded, in-process shape.

A package keeps shared wire contracts separate from host dependencies:

```text
question-plugin/
  contract.ts       JSON DTOs and service tokens
  session.ts        dialog-service authority and tool contribution; imports agent/session code
  tui.ts            terminal dialog and renderer; imports TUI code
  web.ts            optional browser dialog and renderer
  index.ts          loopback bundle; production hosts resolve per-host entry points
```

The browser build never imports `session.ts`; the session process never imports TUI or DOM code.

The question plugin is this document's end-to-end example:

```text
model calls the question tool                                  (session facet)
→ session facet spawns one invocation-keyed dialog service      (session authority)
→ every connected TUI/web facet observes the service instance   (keyed service)
→ the first accepted answer settles it for everyone
→ session facet returns the durable tool result
→ closing the instance closes every presentation's dialog
```

With no presentation connected, the question remains pending. A TUI or web facet that connects later obtains the same pending question.

The models service in the next sections illustrates services and replicated state; the [server section](#the-server-directory-management-and-routing) covers server-wide services and session routing; the [question section](#session-owned-deferred-interactions-the-question-plugin) makes the full round trip concrete.

## Starting and connecting hosts

Every host receives the same **logical manifest**: JSON-safe plugin identity, order, and version. It resolves only its own package entry points (`./server`, `./session`, `./tui`, or `./web`); a missing entry point means that plugin has no facet for the host. Resolution, not convention, enforces the dependency boundary.

```ts
const manifest: PluginManifestEntry[] = [
	{ id: "@pi/session-core" },
	{ id: "@pi/providers-builtin" },
	{ id: "@pi/model-selection" },
	{ id: "@pi/question" },
];
```

Presentation and session-worker hosts do not discover servers or open sockets themselves. They receive one connection function; the server host receives a listener:

```ts
type Connect = (signal: AbortSignal) => Promise<Transport>;
type Listen = (accept: (transport: Transport) => void) => () => void;

interface Transport {
	send(frame: JsonValue): void;
	receive(listener: (frame: JsonValue) => void): void;
	close(): void;
	readonly closed: Promise<void>;
}
```

`Connect` performs one connection attempt. Its closure owns the endpoint and credential, so the host never reads an address, environment variable, or secret. `Listen` lets the server accept presentation and session-worker connections. Both operate on the same bidirectional framed `Transport`.

```ts
declare const tuiAppHost: {
	start(options: { manifest: Manifest; connect: Connect }): Promise<RunningHost>;
};

declare const sessionAppHost: {
	start(options: { manifest: Manifest; connect: Connect; identity: SessionIdentity }): Promise<RunningHost>;
};

declare const serverAppHost: {
	start(options: { manifest: Manifest; listen: Listen }): Promise<RunningServer>;
};

interface RunningHost {
	readonly connection: RemoteState<ConnectionState>;
	stop(): Promise<void>;
}

interface RunningServer {
	readonly local: Connect; // connect another host in the same process
	stop(): Promise<void>;
}
```

Every deployment uses those three entry points:

```ts
// separate processes
await serverAppHost.start({ manifest, listen: listenSocket(socketPath) });
await sessionAppHost.start({ manifest, identity, connect: dialSocket(endpoint, token) });
await tuiAppHost.start({ manifest, connect: dialSocket(endpoint, token) });

// standalone: the same hosts and boundaries, without sockets
const server = await serverAppHost.start({ manifest, listen: listenNothing() });
await sessionAppHost.start({ manifest, identity, connect: server.local });
await tuiAppHost.start({ manifest, connect: server.local });
```

This keeps deployment policy outside plugins:

- reconnecting means calling `connect(signal)` again; the host owns retry timing, while `Connect` owns one attempt;
- the accepting server assigns peer identity during its handshake from the presented credential; `SessionIdentity` identifies the durable session being run, not a trusted claim about the connection;
- `server.local` makes standalone a deployment, not a separate mode or code path.

The only connection state exposed to facets is:

```ts
type ConnectionState =
	| { status: "connecting"; attempt: number }
	| { status: "connected"; since: string }
	| { status: "disconnected"; since: string; reason: string; retryAt: string | null };
```

After transport setup, each host asks the kernel to create one lifecycle scope per selected facet, builds its host-specific bindings, and invokes the facet:

```ts
interface PluginLifecycleScope {
	onActivate(callback: () => void | Promise<void>): void;
	onDispose(callback: () => void | Promise<void>): void;
	own(disposal: () => void | Promise<void>): void;
}
```

Host infrastructure calls `own()` for every service, contribution, or subscription registered through facet bindings. Facets first register in manifest order; then `onActivate` callbacks start effects and the host exposes state snapshots. Failure and normal shutdown dispose scopes in reverse order. Duplicate services, missing dependencies, and dependency cycles are application-assembly errors.

The prototype in `packages/coding-agent/test/fixtures/plugin-app/` demonstrates the composition model with an ad hoc RPC implementation; the shared RPC design in `rpc.md` should replace that transport without replacing the host/facet architecture.

One process owns one session, and session authority never migrates. Each presentation and session worker has one multiplexed connection to its server; plugins never open private sockets. Plugin authors never implement request IDs, sockets, trace carriers, cancellation frames, remote-reference registries, or reconnect buffering.

Out of scope: arbitrary undeclared object remoting, serialized functions/classes/`Map`/`Set`, remote hook or tool execution, offline presentation writes or automatic mutation replay, a universal remote `AgentHarness` or serialized UI tree, and re-exposing forwarded frames, proxies, or references as plugin-visible objects.

## Services connect host facets

Facets communicate across processes through **services**. One token type gives a service contract its identity:

```ts
function defineRemoteService<T>(id: string): RemoteService<T>;
```

The declaration lives in the shared contract module and creates nothing. `provide(service, implementation)` exposes one singleton; `spawn(service, key, implementation)` exposes a keyed instance. Consumers select the same mode with `use(service)` or `observe(service, handler)`. Within one host namespace, a token must stay in one mode: mixing `provide`/`use` with `spawn`/`observe` is an assembly or protocol error.

TypeScript types cannot produce runtime member metadata. Plugin authors nevertheless declare no parallel descriptor. When `provide()` or `spawn()` receives an implementation, the host classifies functions as remote methods and recognizes branded `RemoteState` and `RemoteEvents` values. It rejects unsupported members and announces the resulting member table over the transport.

`use()` on a singleton returns a stable lazy proxy synchronously, even before a provider is attached. Member access creates local method, state, or event slots as they are used; attachment validates those slots against the provider-announced kinds. A mismatch is an assembly or protocol error. This runtime mechanism is implemented once by the host rather than repeated in every service declaration.

The models service — the authority behind the model picker and thinking-level control — exercises methods, replicated state, and multiple consumers.

### Shared contract

```ts
export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelsState {
	catalog: { revision: number; availableModels: Array<ModelRef & { name: string; reasoning: boolean }> };
	configuration: { model: ModelRef | null; thinkingLevel: "off" | "low" | "high" };
	refresh:
		| { status: "idle" | "refreshing" | "done" }
		| { status: "warning"; errors: Record<string, string> };
}

export interface ModelsService {
	readonly state: RemoteState<ModelsState>;
	cycleThinking(context: Context): Promise<void>;
	refresh(context: Context): Promise<void>;
	select(model: ModelRef, context: Context): Promise<void>;
}

export const Models = defineRemoteService<ModelsService>("models");
```

Everything transported in a remote contract is strict JSON: arguments, results, replicated state, and events. Business-level absence uses JSON `null`, never `undefined`. An unhydrated `RemoteState.value === undefined` is local control-plane readiness, not a transported state value. `Context` is control-plane data in a declared position; the proxy strips it and it is never serialized.

### Session facet

```ts
export const providersBuiltin = definePlugin({
	id: "@pi/providers-builtin",

	session(pluginContext: CodingAgentSessionPluginContext) {
		const providers = new ProviderRegistry(); // process-local, non-JSON
		const state = pluginContext.remoteState<ModelsState>(initialModelsState());

		pluginContext.provide(Models, {
			state,

			async cycleThinking(context) {
				const { catalog, configuration } = state.value;
				if (configuration.model === null) return;
				const spec = findSpec(catalog, configuration.model);
				if (spec === undefined || !spec.reasoning) return;
				state.set(
					{
						...state.value,
						configuration: {
							...configuration,
							thinkingLevel: nextThinkingLevel(configuration.thinkingLevel),
						},
					},
					context,
				);
			},

			async select(model, context) {
				const spec = findSpec(state.value.catalog, model);
				if (spec === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
				const thinkingLevel = spec.reasoning ? state.value.configuration.thinkingLevel : "off";
				state.set({ ...state.value, configuration: { model, thinkingLevel } }, context);
			},

			async refresh(context) {
				state.set({ ...state.value, refresh: { status: "refreshing" } }, context);
				const errors = await providers.refresh(context.abortSignal);
				state.set({ ...state.value, catalog: providers.snapshot(), refresh: toRefreshStatus(errors) }, context);
			},
		});

		pluginContext.onActivate(() => providers.rebuild());
	},
});
```

### TUI facet

```ts
export const modelSelection = definePlugin({
	id: "@pi/model-selection",

	tui(pluginContext: CodingAgentTuiPluginContext) {
		const models = pluginContext.session.use(Models);

		pluginContext.commands.register("models.select", async (context) => {
			const current = models.state.value;
			if (current === undefined) return;
			const selected = await pluginContext.ui.select(
				"Models",
				current.catalog.availableModels.map((model) => ({
					label: model.name,
					value: { provider: model.provider, modelId: model.modelId },
				})),
				{ signal: context.abortSignal },
			);
			if (selected !== undefined) await models.select(selected, context);
		});
		pluginContext.commands.register("models.cycle-thinking", (context) => models.cycleThinking(context));
		pluginContext.own(models.state.subscribe((next) => renderModelSelector(next)));
	},
});
```

The TUI facet has no credentials, registry, or refresh logic: it calls a typed lazy proxy with the contract's method signatures and renders replicated state after hydration. A web facet would do the same through the web host context.

### Service semantics

A service has **one owner and many consumers**. In singleton mode, `providersBuiltin` provides `Models` and both model-selection commands consume it. In keyed mode, one owner may spawn instances `A` and `B`, and every observer sees the same two instances.

`use()` behaves differently by locality:

- **Local:** in the process that provides the singleton, `use()` is synchronous and returns the actual implementation object. No serialization, no proxy.
- **Remote:** across a connection, `use()` synchronously returns a stable lazy proxy. Calls made while disconnected fail when invoked; state has no value until hydrated. Concurrent consumers of one token in one process share one proxy, one state replica, and one remote subscription.

Keyed services use `spawn()` and `observe()`. A keyed service is empty until its owner calls `spawn()`; observing it never creates an instance. `spawn(service, key, implementation)` returns an idempotent close function, and the key must be unique among that service's live instances. `observe(service, handler)` reconciles a snapshot of current instances and then ordered additions, replacements, and removals. After an instance's initial state members hydrate, the host starts one handler task with a fresh `Context`. Closing the instance aborts that context, rejects new calls, and lets already-admitted calls return. Cancellation from the instance context is normal task cleanup; other handler failures follow host failure policy. Reusing a closed key creates a new host-owned generation, so stale proxies cannot address the replacement.

A spawned member has structural identity `(service, key, generation, member)`. Its `RemoteState` members therefore need no independent IDs. The instance directory is control-plane metadata, not a plugin-visible `RemoteState` containing proxies. Switching sessions aborts all observed instance tasks before hydrating the selected session's current instances.

Presentation facets consume remotely through two explicit namespaces — `server.use()`/`server.observe()` and `session.use()`/`session.observe()`, defined below. Session facets consume their own process's services locally and server services remotely. These bindings are host infrastructure layered over the kernel scope, not kernel API.

## What each host context grants

This is the most important boundary in the design.

**Session facets run beside the real thing.** They execute in the process that owns the concrete `AgentHarness`, `AgentLane`, `Session`, and `SessionTree`, and receive direct, process-local, scoped capabilities backed by those instances — not RPC proxies. Calls preserve real method signatures, `Context` propagation, `Result` types, and object identity. A session facet never RPCs back into its own process.

```ts
interface AgentPluginScope {
	readonly identity: SessionIdentity; // sessionId + workspaceId
	readonly main: AgentLanePluginView;
	lane(name: string, context: Context): Promise<AgentLanePluginView | undefined>;
	readonly sessionTree: SessionTree;
	readonly hooks: ScopedHooks;
	readonly events: ScopedEvents;
}

interface CodingAgentSessionPluginContext extends PluginLifecycleScope {
	readonly agent: AgentPluginScope; // scoped local session authority

	// service/state infrastructure (session-host owned)
	provide<T>(service: RemoteService<T> | LocalService<T>, implementation: T): void;
	use<T>(service: RemoteService<T> | LocalService<T>): T;
	spawn<T>(service: RemoteService<T>, key: string, implementation: T): () => void;
	observe<T>(
		service: RemoteService<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
	remoteState<T extends JsonValue>(initial: T): MutableRemoteState<T>;
	remoteEvents<T extends JsonValue>(): MutableRemoteEvents<T>;

	readonly server: ServerServices; // remote access to the managing server

	// contribution registries (session-host owned)
	readonly providers: ProviderContributionRegistry;
	readonly tools: ToolContributionRegistry;

	// attached-client lifecycle
	onClientAttach(callback: (clientId: string) => void): void;
	onClientDetach(callback: (clientId: string) => void): void;
}
```

"Local" and "unrestricted" are separate decisions. The scope narrows authority for lifecycle and composition — hooks and event subscriptions registered through it are automatically owned by the plugin and disposed with it — but `sessionTree` may be the actual local derived object. The host keeps the unrestricted concrete instances and reserves: `AgentHarness.close()` and `Session.close()`; raw `Session.mutate()` and `SessionMutator` (unless a narrowly trusted durability plugin explicitly owns them); `idGenerator` and backend/storage objects; whole-registry setters such as `setTools()`; unscoped hook/event registration; transport exposure and remote-reference registration. This is a composition and lifecycle boundary, not a security sandbox: session facets are trusted code in the authoritative process. The manifest may explicitly grant broader local capability, but built-ins receive no implicit bypass.

**Presentation facets hold none of this.** A TUI or web facet never receives the raw Harness, Session, tree, tool registry, hooks, or credentials — not even as proxies. It receives only what a session or server facet deliberately exposes: semantic service proxies and instances, replicated state, and semantic events.

```ts
interface RemoteServiceInstance<T> {
	readonly key: string;
	readonly service: T;
}

interface RemoteServiceNamespace {
	use<T>(service: RemoteService<T>): T;
	observe<T>(
		service: RemoteService<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
}

interface ServerServices extends RemoteServiceNamespace {
	readonly connection: RemoteState<ConnectionState>;
}

type AttachmentState = { status: "detached" } | { status: "attaching" | "attached" | "degraded"; sessionId: string };

interface SessionServices extends RemoteServiceNamespace {
	readonly attachment: RemoteState<AttachmentState>;
}

interface SelectItem<T> {
	label: string;
	description?: string;
	value: T;
}

interface TuiModal {
	select<T>(title: string, items: SelectItem<T>[]): Promise<T | undefined>;
	input(title: string): Promise<string | undefined>;
	close(): void;
}

interface TuiFacilities {
	acquireModal(signal: AbortSignal): Promise<TuiModal>;
	select<T>(title: string, items: SelectItem<T>[], options: { signal: AbortSignal }): Promise<T | undefined>;
	// overlays and focus facilities
}

interface CodingAgentTuiPluginContext extends PluginLifecycleScope {
	readonly server: ServerServices; // two explicit remote namespaces
	readonly session: SessionServices;

	// terminal-specific facilities and contribution registries
	readonly ui: TuiFacilities;
	readonly commands: CommandContributions;
	readonly keybindings: KeybindingContributions;
	readonly toolRenderers: ToolRendererContributions;
	readonly slots: SlotContributions;
}
```

`acquireModal()` waits in one presentation-owned queue and holds the modal slot across a multi-step interaction. Its signal removes a queued request or dismisses an active one, and `close()` is idempotent. `select()` is the one-step acquire/select/close convenience. Both return selected values directly, so feature code never recovers identity from a display label.

The two namespaces are the topology made visible: `server.use(SessionDirectory)` returns a proxy for a service the connected server provides itself; `session.use(Models)` returns one for the **selected session** — the session this presentation is currently attached to. A presentation has at most one selected session. `session.use()` returns its shared proxy immediately; while detached, calls fail with `not_attached` and no state is present. The two namespaces fail independently: the server connection can be healthy while the selected session is unreachable (`attachment.status === "degraded"`).

A future `CodingAgentWebPluginContext` carries the same two namespaces plus browser registries — routes, views, DOM dialogs. The server context is defined in the [server section](#the-server-directory-management-and-routing). Contexts resemble each other by convention; no kernel-owned base type forces the shape.

Concretely, a chat plugin exposes a narrow `Chat` contract — `prompt(request, context)` returning `{ accepted, operationId, error }`, plus `requestAbort(operationId, context)` — and implements it with direct local lane capabilities:

```ts
session(pluginContext: CodingAgentSessionPluginContext) {
	const lane = pluginContext.agent.main;
	pluginContext.provide(Chat, {
		async prompt(request, context) {
			return toPromptResponse(await lane.prompt(request.message, context));
		},
		async requestAbort(operationId, context) {
			await lane.requestAbort(operationId, context);
		},
	});
}
```

Its TUI facet consumes `Chat` through `session.use()` exactly as the model picker consumes `Models`. Neither reveals the Harness object behind them; there is no universal remote Harness for arbitrary plugins. `rpc.md` may still define generic Harness proxies for other trusted integrations (an IDE bridge, an orchestrator) — deliberate, separate exposures, not the plugin boundary.

## Local services and narrow remote facades

Not every dependency should be remotely reachable. A **local service** is a token confined to its providing process. It may hold functions, native objects, credentials, or filesystem handles; remote `use()` cannot resolve it, and local services are never discoverable remotely. The pattern for sensitive state is a local full service plus a narrow remote facade:

```ts
const Credentials = defineLocalService<CredentialStore>("credentials"); // get/set provider secrets

interface AccountsService {
	readonly state: RemoteState<{ providers: Array<{ provider: string; configured: boolean }> }>;
	remove(provider: string, context: Context): Promise<void>;
}
const Accounts = defineRemoteService<AccountsService>("accounts");
```

The auth plugin's session facet uses `Credentials` directly; presentations see provider IDs and `configured` booleans — never secrets. If some settings must not be remotely writable, split them the same way; do not rely on presentation-side convention.

## Replicated state: `RemoteState`

`ModelsService.state` is a `RemoteState<ModelsState>`: **authoritative latest-value replication** — not event history, durable storage, a CRDT, or a multi-writer mechanism.

```ts
interface RemoteState<T> {
	/** Borrowed immutable value, or `undefined` until hydration. Do not mutate or retain it. */
	readonly value: T | undefined;
	/** Listener values are borrowed and must not be mutated or retained. */
	subscribe(listener: (value: T, context: Context) => void): () => void;
}

interface MutableRemoteState<T> extends RemoteState<T> {
	/** A providing state is always initialized. */
	readonly value: T;
	/** Transfers the JSON value to the state; the caller must not subsequently mutate it. */
	set(value: T, context: Context): void;
}
```

Required behavior:

1. The providing host owns one initialized authoritative value; remote consumers call methods rather than writing the replica.
2. A cold remote replica has no value. Its `.value` is `undefined`, and `subscribe()` registers the listener without invoking it. This `undefined` is local readiness state and never crosses the wire.
3. **Hydration** installs a complete snapshot atomically before updates flow. Subscribing before hydration is valid, and updates emitted concurrently with the snapshot are buffered, so the listener observes snapshot then updates with no gap.
4. Once hydrated, `.value` is synchronously readable and `subscribe()` immediately reports the current value, then future updates. The first snapshot callback uses a fresh **hydration context** parented to the subscription; an immediate callback for an already-present value uses a fresh local delivery context because the write that produced it may be long settled.
5. State values are borrowed immutable JSON. The state runtime does not defensively clone reads, writes, snapshots, or listener deliveries. Callers transfer ownership to `set()` and must not mutate or retain values returned by `.value` or passed to listeners; copy explicitly when ownership is required. Process and transport serialization may naturally produce a detached value, but callers must not depend on object identity or detachment.
6. Disconnect retains the last value as stale display data alongside connection or attachment state. Reconnecting to the same provider replaces it with a fresh snapshot. Switching to a different provider clears readiness and `.value` becomes `undefined` until that provider hydrates; service-bound presentation resources are disposed as part of the switch.
7. `set(value, context)` carries source trace metadata; each live delivery invokes listeners with a reconstructed delivery `Context`. Background updates use an intentional background or lifecycle context, never a retained caller context.

Anything a consumer must recover after reconnect is exposed as remote state or pulled through a remote method. Remote state is latest-value replication, not by itself durable session storage; the providing facet must reconstruct its authoritative value after a worker restart.

Prefer several coarse independent cells over one giant value or a universal patch language, so a catalogue refresh does not retransmit unrelated configuration. High-frequency data such as transcript streaming should use semantic deltas plus a final authoritative replacement. Revision metadata, gap recovery, unchanged-value suppression, and demand-driven subscription are protocol concerns, not plugin-author concerns.

## Contribution registries: many contributors, one result

Services fit one owner, many consumers. Providers and tools invert that: **many plugins contribute to one host-owned result**. A mutable global registry would make composition order-dependent and removal impossible. A contribution registry instead replays ordered contributions over a fresh draft:

```text
fresh ProviderDraft
→ built-in provider contribution        (@pi/providers-builtin)
→ remote catalogue contribution         (@pi/providers-catalog)
→ models.json transformation            (@pi/providers-models-json)
→ authentication/availability marking   (@pi/auth)
→ validated ProviderState
```

Removing a plugin removes its contribution and rebuilds; nothing runs an inverse mutation. Tools follow the same model, including wrapping:

```ts
sessionContext.tools.add((draft) => {
	draft.set("review_add", reviewAddTool);
	draft.wrap("bash", (next) => async (invocation) => {
		await authorize(invocation);
		return next(invocation);
	});
});
```

Ordered wrappers compose deterministically — `telemetry(permission(sandbox(coreBash)))` — and if the permission plugin disappears, rebuilding yields `telemetry(sandbox(coreBash))`. Only the host finalizes the draft and applies the complete registry to the Harness; plugins never call `setTools()`. Contributions configure rebuilt behavior; hooks intercept live operations — separate mechanisms.

## Context, cancellation, and telemetry for plugin authors

`rpc.md` and `telemetry.md` own the mechanisms. What a plugin author needs to know:

- Every remote method receives a `Context` in its declared position. The proxy strips it from the JSON arguments and uses it to parent `rpc.client`, inject the trace carrier, and map `context.abortSignal` to request cancellation.
- The server never deserializes the client's context. It constructs a fresh one: a request-local abort signal, a telemetry parent extracted from the trace carrier, and server-created typed values such as the authenticated client identity. Clients cannot smuggle context values across.
- No receiver-level defaults: shared service objects never retain a caller's context.

The model refresh shows the whole author-visible surface:

```ts
const controller = new AbortController();
await uiTelemetry.startSpan({ name: "ui.models.refresh" }, async (span) => {
	const context = withAbortSignal(controller.signal, withTelemetryContext(span, BACKGROUND_CONTEXT));
	await models.refresh(context);
});
```

The implementation may open its own span for lower work, producing the distributed trace:

```text
ui.models.refresh
└─ rpc.client models.refresh
   └─ rpc.server models.refresh
      └─ plugin.models.refresh
```

`controller.abort()` cancels only that one request: the server's reconstructed `context.abortSignal` aborts, and no other caller is affected.

Three cancellation domains must never blur:

1. **Invocation cancellation** aborts one remote call or wait — the `controller.abort()` above.
2. **Service-owned cancellation** is an explicit method such as `job.cancel()` that stops a service-owned task.
3. **Durable Harness cancellation** — `requestAbort()`/`abort()` — writes durable `cancel_requested` and drives durable settlement.

A transport disconnect performs only the first for active requests and closes that client's subscriptions. It must not silently cancel service-owned work or write durable cancellation. Work intended to outlive its initiating request must deliberately detach into a service-owned task with its own controller and telemetry root.

## Events

A remotely exposed event source is a projection of host-local events, not a remotely invoked callback. A Git plugin:

```ts
interface GitService {
	readonly status: RemoteState<GitStatus>;
	readonly events: RemoteEvents<GitEvent>;   // { type: "status_changed" | "head_changed" }
	refresh(context: Context): Promise<void>;
}
const Git = defineRemoteService<GitService>("git");
```

Server-side, the exposure adapter subscribes to the host-local source once per remote subscription and forwards frames. Client-side, `events` is a local facade whose listeners run in the client process — callbacks never cross the wire; `on(type, listener)` filters by discriminator, `subscribe(listener)` observes everything. Each event carries source trace metadata from the providing host's context, so client-side handling stays correlated with the originating operation. The adapter owns subscribe/unsubscribe frames, sequencing, buffering, flow control, and disconnect cleanup (`rpc.md`). Remote events are non-durable and never replayed: a new or reconnected consumer sees only events emitted after its subscription becomes active. Anything needed to reconstruct current behavior after reconnect belongs in remote state or a pull method.

## Service-owned jobs

Long-running work should return a capability rather than one method that blocks indefinitely:

```ts
interface IndexJob {
	readonly progress: RemoteState<IndexProgress>;
	wait(context: Context): Promise<IndexProgress>; // aborting this context cancels only this wait
	cancel(context: Context): Promise<void>;        // cancels the job itself, for everyone
}
```

An `IndexService.start(root, context)` returning an `IndexJob` validates the root, creates its own `AbortController` and a detached telemetry root, and returns the job. The job crosses the wire as a private **remote object reference** (`rpc.md`) known only to that caller. If every attached presentation must discover a job, `spawn()` a keyed service instance instead. Discovery is the distinction: returned references are passed explicitly; spawned instances appear in `observe()` hydration. Both make the cancellation domains concrete, and both need explicit lifetime cleanup.

## The server: directory, management, and routing

The server host does two jobs. It **owns server-wide services**—listing, creating, deleting, and attaching to sessions—and it **routes session traffic** between attached presentations and the session workers it manages. Routing is host infrastructure that plugin code does not implement.

A server facet is shared by every session and presentation connected to the server. It should be used only for inherently server-wide features. Per-session feature data belongs in session facets.

### Server host context

```ts
interface FleetPluginScope {
	readonly managed: ManagedSessionsView;  // sessions managed by this server
	readonly attachments: AttachmentsView;  // bind/unbind a client's selected session
}

interface CodingAgentServerPluginContext extends PluginLifecycleScope {
	readonly fleet: FleetPluginScope;
	// plus the same provide/spawn/use/observe/remoteState/remoteEvents as the session host context
}
```

The raw `SessionRepo`, storage handles, unrestricted process-kill authority, routing map, and routing machinery stay with the server application:

```ts
interface ManagedSessionRecord {
	sessionId: string;
	title: string;
	workspaceId: string;
	ownerId: string;
	cwd: string; // ownerId and cwd never leave the server
	status: "starting" | "active" | "idle" | "closed" | "unreachable";
	updatedAt: string;
}

type ManagedSessionChange = { type: "created" | "changed" | "deleted"; record: ManagedSessionRecord };

interface ManagedSessionsView {
	snapshot(): ManagedSessionRecord[];
	onChanged(listener: (change: ManagedSessionChange, context: Context) => void): () => void;
	create(options: { title: string; workspaceId: string }, context: Context): Promise<ManagedSessionRecord>;
	remove(sessionId: string, context: Context): Promise<void>;
}
```

### Shared contract

The directory is read; management mutates and selects. Both are presentation-safe: `ownerId` and `cwd` are stripped from summaries.

```ts
export interface SessionRecordSummary {
	sessionId: string;
	title: string;
	workspaceId: string;
	status: ManagedSessionRecord["status"];
	updatedAt: string;
}

export type SessionDirectoryEvent =
	| { type: "created" | "changed"; session: SessionRecordSummary }
	| { type: "deleted"; sessionId: string };

export interface SessionDirectoryService {
	readonly state: RemoteState<{ revision: number; sessions: SessionRecordSummary[] }>;
	readonly events: RemoteEvents<SessionDirectoryEvent>;
}

export const SessionDirectory = defineRemoteService<SessionDirectoryService>("session-directory");

export interface SessionManagementService {
	create(options: { title: string }, context: Context): Promise<SessionRecordSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineRemoteService<SessionManagementService>("session-management");
```

### Server facet

```ts
// server.ts
export function sessionDirectoryServerFacet(pluginContext: CodingAgentServerPluginContext) {
	const { managed, attachments } = pluginContext.fleet;
	const state = pluginContext.remoteState({ revision: 0, sessions: [] as SessionRecordSummary[] });
	const events = pluginContext.remoteEvents<SessionDirectoryEvent>();

	function publish(change: ManagedSessionChange, context: Context) {
		state.set({ revision: state.value.revision + 1, sessions: managed.snapshot().map(toSummary) }, context);
		events.emit(toDirectoryEvent(change), context);
	}

	pluginContext.own(managed.onChanged(publish));
	pluginContext.onActivate(() =>
		state.set({ revision: 1, sessions: managed.snapshot().map(toSummary) }, BACKGROUND_CONTEXT),
	);

	pluginContext.provide(SessionDirectory, { state, events });
	pluginContext.provide(SessionManagement, {
		async create(options, context) {
			const client = requireClientIdentity(context);
			return toSummary(await managed.create({ title: options.title, workspaceId: client.workspaceId }, context));
		},
		async remove(sessionId, context) {
			authorizeTarget(requireClientIdentity(context), managed.snapshot(), sessionId);
			await managed.remove(sessionId, context);
		},
		async attach(sessionId, context) {
			const client = requireClientIdentity(context);
			authorizeTarget(client, managed.snapshot(), sessionId);
			await attachments.bind(client.clientId, sessionId, context);
		},
		async detach(context) {
			await attachments.unbind(requireClientIdentity(context).clientId, context);
		},
	});
}

function authorizeTarget(client: ClientIdentity, records: ManagedSessionRecord[], sessionId: string) {
	const record = records.find((candidate) => candidate.sessionId === sessionId);
	if (record === undefined || record.workspaceId !== client.workspaceId) {
		throw new RemoteServiceError("not_authorized", `Not accessible: ${sessionId}`);
	}
}

function toSummary({ sessionId, title, workspaceId, status, updatedAt }: ManagedSessionRecord): SessionRecordSummary {
	return { sessionId, title, workspaceId, status, updatedAt };
}
```

Every call is authorized against the client identity that transport policy installed server-locally, never against identity supplied in ordinary arguments.

### TUI facet: the picker

```ts
// tui.ts
export function sessionPickerTuiFacet(pluginContext: CodingAgentTuiPluginContext) {
	const directory = pluginContext.server.use(SessionDirectory);
	const management = pluginContext.server.use(SessionManagement);

	pluginContext.commands.register("sessions.switch", async (context) => {
		const current = directory.state.value;
		const attachment = pluginContext.session.attachment.value;
		if (current === undefined || attachment === undefined) return;
		const selected = await pluginContext.ui.select(
			"Sessions",
			current.sessions.map((session) => ({
				label: pickerLabel(session, attachment),
				value: session.sessionId,
			})),
			{ signal: context.abortSignal },
		);
		if (selected !== undefined) await management.attach(selected, context);
	});

	pluginContext.own(directory.state.subscribe((next) => renderSessionList(next)));
}
```

The TUI facet consumes a service provided by the one connected server. There is no session facet in this plugin because sessions do not own discovery or attachment.

### Attaching and switching

`attach(sessionId)` selects the session for this presentation connection:

1. the server authorizes the client for one of its managed sessions;
2. it closes the client's previous session-scoped requests, subscriptions, references, and observed instance tasks;
3. it binds the session namespace to the selected session worker;
4. the session worker hydrates singleton state and current keyed instances from complete fresh snapshots; `session.attachment` becomes `attached`.

Session-namespace bindings are stable across switches: a proxy returned once by `session.use(Models)` keeps working against the new session, and an existing `session.observe(QuestionDialogs, ...)` registration reconciles the new session's instances. Frames belonging to closed subscriptions or requests are dropped.

### Routed session call

```text
TUI A (selected session S1): rpc.client chat.prompt
server: authorize client for S1; route to session worker S1 with authenticated client identity
S1: rpc.server chat.prompt — fresh local Context, validated JSON args → lane.prompt(...)
response returns S1 → server → TUI A
```

Aborting the TUI request sends cancellation through the server to S1, aborting the session-side request controller. Trace carriers pass through routing; `Context` is reconstructed at the service endpoint.

### Routing is host infrastructure

The server routes session traffic contract-agnostically. It parses protocol envelopes—frame kind, request ID, service ID, optional instance key/generation, and selected session—but not plugin business payloads. Validation happens at service endpoints, so the server can route a session plugin service without loading that session facet.

The server stamps routed calls with the client identity it authenticated. The session worker keys connection-owned requests by that identity, preventing collisions and cross-client cancellation. No server facet participates in routing or re-provides session services.

## Session-owned deferred interactions: the question plugin

Some session-side work must ask users for a decision. The existing `examples/extensions/question.ts` shows the experience: the model calls a `question` tool, a user selects an option or types an answer, and the tool returns that answer with a compact rendering.

A question is not a reverse RPC routed to one eligible presentation. The session spawns one temporary dialog service keyed by the invocation ID. Every connected TUI or web presentation observes that instance, a presentation connecting later discovers it through instance hydration, and the instance remains open while no users are connected.

### Shared contracts

```ts
const QuestionParamsSchema = Type.Object({
	question: Type.String(),
	options: Type.Array(
		Type.Object({
			label: Type.String(),
			description: Type.Union([Type.String(), Type.Null()]),
		}),
	),
});
type QuestionRequest = Static<typeof QuestionParamsSchema>;

type QuestionResponse =
	| { outcome: "selected"; index: number }
	| { outcome: "custom"; answer: string }
	| { outcome: "cancelled" };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
}

interface QuestionDialogService {
	readonly request: RemoteState<QuestionRequest>;
	submitAnswer(response: QuestionResponse, context: Context): Promise<void>;
}

const QuestionDialogs = defineRemoteService<QuestionDialogService>("question-dialog");
```

`QuestionDialogs` declares only the contract. Each invocation explicitly spawns one keyed instance. Its `request` state is addressed by the service, invocation key, hidden generation, and member name.

The tool-result helper remains session-local:

```ts
function questionResult(request: QuestionRequest, answer: string | null, wasCustom: boolean, text: string) {
	return {
		content: [{ type: "text", text }],
		details: { question: request.question, options: request.options.map((o) => o.label), answer, wasCustom },
	} satisfies AgentToolResult<QuestionDetails>;
}
```

### Session facet: spawn one dialog service

`memoOnce(name, candidate)` is an atomic invocation-memo operation. It keeps the first value, returns that durable winner to every caller, and reports all failures by rejecting its promise rather than throwing synchronously. `awaitAbortable()` is an ordinary shared cancellation utility.

```ts
// session.ts
export function questionSessionFacet(bindings: CodingAgentSessionPluginContext) {
	bindings.tools.add((draft) => {
		draft.set("question", {
			label: "Question",
			description: "Ask users a question and wait for an answer.",
			executionMode: "sequential",
			replay: "safe",
			parameters: QuestionParamsSchema,

			async execute(_toolCallId, params, _onUpdate, _toolContext, invocation, context) {
				if (params.options.length === 0) return questionResult(params, null, false, "No options provided");

				const memoName = "pi.question.answer";
				let response = (await invocation.getMemo(memoName)) as QuestionResponse | undefined;

				if (response === undefined) {
					const completion = Promise.withResolvers<QuestionResponse>();
					const request = bindings.remoteState<QuestionRequest>(params);
					const close = bindings.spawn(QuestionDialogs, invocation.invocationId, {
						request,
						async submitAnswer(candidate, _answerContext) {
							if (candidate.outcome === "selected" && params.options[candidate.index] === undefined) {
								throw new Error("Question response selected an invalid option");
							}
							const committed = invocation.memoOnce(memoName, candidate);
							completion.resolve(committed);
							await committed;
						},
					});

					try {
						response = await awaitAbortable(completion.promise, context.abortSignal);
					} finally {
						close();
					}
				}

				if (response.outcome === "cancelled") return questionResult(params, null, false, "User cancelled the question");
				if (response.outcome === "custom") return questionResult(params, response.answer, true, `User wrote: ${response.answer}`);
				const selected = params.options[response.index];
				if (selected === undefined) throw new Error("Question response selected an invalid option");
				return questionResult(params, selected.label, false, `User selected: ${response.index + 1}. ${selected.label}`);
			},
		});
	});
}
```

`spawn()` installs the instance before `execute()` waits. The returned close function is the single normal, cancellation, and error cleanup path. Concurrent submissions call `memoOnce()`, whose atomic first-writer rule prevents overwrite and returns the same durable winner. `completion.resolve(committed)` makes the local wait follow that durable operation: success resumes the tool, while failure rejects it and runs the same cleanup instead of leaving it suspended. Each service call also awaits its own `committed` promise, so it cannot report success before durability or leave an ignored rejection. Calls through a closed instance or an old generation fail as stale service calls.

### TUI and web facets: observe every dialog instance

```ts
// tui.ts
type QuestionChoice =
	| { outcome: "selected"; index: number }
	| { outcome: "custom" };

export function questionTuiFacet(bindings: CodingAgentTuiPluginContext) {
	bindings.own(
		bindings.session.observe(QuestionDialogs, async (dialog, context) => {
			const request = dialog.service.request.value;
			if (request === undefined) throw new Error("Question dialog was observed before hydration");

			const modal = await bindings.ui.acquireModal(context.abortSignal);
			try {
				const choice = await modal.select<QuestionChoice>(
					request.question,
					[
						...request.options.map((option, index) => ({
							label: option.label,
							...(option.description === null ? {} : { description: option.description }),
							value: { outcome: "selected" as const, index },
						})),
						{ label: "Write a custom answer", value: { outcome: "custom" as const } },
					],
				);

				let response: QuestionResponse;
				if (choice === undefined) {
					response = { outcome: "cancelled" };
				} else if (choice.outcome === "selected") {
					response = choice;
				} else {
					const answer = await modal.input(request.question);
					response = answer === undefined ? { outcome: "cancelled" } : { outcome: "custom", answer };
				}

				await dialog.service.submitAnswer(response, context);
			} finally {
				modal.close();
			}
		}),
	);

	bindings.toolRenderers.add<QuestionDetails>("question", questionRenderer);
}
```

`observe()` runs one abortable task per open instance, including instances present in the hydration snapshot. Three concurrent tool invocations therefore produce three tasks keyed by their invocation IDs. The TUI modal queue displays them one at a time; a web host may render all three. Closing one instance aborts only its task in every presentation.

With no connected presentation, the spawned instance and unresolved tool remain session-owned. A web facet observes the same service; a headless client may ignore it. Similar features—permissions, OAuth, or editor requests—may spawn their own keyed services when all presentations need to discover temporary instances. Secrets still require narrow methods and presentation-safe state.

### Durability and worker replacement

The service instance is live process state; the invocation memo is the replay receipt. The Harness already persists a safe tool's effective arguments, stable invocation ID, `effect_pending` state, and memos. `memoOnce()` synchronously enters one atomic read-or-write on the invocation's lane mutation line and verifies that the same operation, turn, source position, and invocation still own the effect. It returns the existing value or commits and returns the candidate.

If the worker dies before the answer commit, the old instance and promise disappear. Safe replay reads no answer and spawns the same logical key with a new generation. If it dies after the commit, replay reads the answer and returns without spawning. A client cannot answer while the worker is absent; calls through the old generation fail instead of locating an invocation by bare ID.

The memo has the existing invocation lifetime. Staging the tool result as `outcome_ready` atomically deletes it; cancellation and external finalization use the same cleanup. The question request is not copied into another memo because the Harness already persisted the effective tool arguments.

## Lifecycle and disposal

Every facet-owned resource — singleton registrations, still-open spawned instances, contributions, state subscriptions, watchers, timers, in-flight RPCs, subprocesses, overlays — is owned by the facet's kernel scope and disposed when that scope closes, in reverse manifest order. Scoped capabilities enforce this automatically for hooks and event subscriptions; `onDispose` handles the rest. Removing a plugin disposes its scope in every host that loaded a facet and rebuilds any contribution registries it touched; neither requires the plugin to undo anything by hand.

## Connection loss, errors, and security

Disconnect behavior, from the plugin author's perspective:

- **A presentation disconnects.** Its server aborts the client's active requests, closes its observed instance tasks and other session-routed resources, and the selected session's `onClientDetach` fires. Session-owned work continues per application policy. A spawned question dialog remains session-owned; the disconnected presentation loses its proxy and any in-flight `submitAnswer()` call fails.
- **A session worker disconnects or crashes.** Its server fails routed in-flight calls with `session_unavailable`, closes that worker's observed instance tasks, and updates the managed record's status. Attached presentations see `attachment.status === "degraded"` while the server connection stays healthy, so the picker still works and the user can attach elsewhere.
- **A process loses its server connection.** A presentation loses both namespaces. A session worker loses server services and all attached presentations at once; unattended-session policy decides whether it exits.
- Reconnect and reattach always hydrate from a fresh authoritative snapshot; prior remote references are invalid unless the exposure has explicitly session-stable identity. **Never blindly replay a mutation after an uncertain disconnect** — a replayed `select()` is harmless, a replayed `prompt()` is not. Reconnect, hydrate, and reconcile, or design the operation around a stable operation ID with explicit lookup semantics.

Errors cross the wire as a JSON envelope `{ code, message, data? }` with stable codes. Expected service errors use stable codes or result values; unexpected exceptions become an internal error with safe metadata — no stacks or sensitive causes by default. Cancellation, disconnect, unknown service/method, invalid arguments/results, stale references, `not_attached`, `not_authorized`, `unknown_session`, and `session_unavailable` need distinct codes.

Security rules every providing host (session and server alike) must enforce:

- service IDs are allowlisted by trusted manifests; `provide()` and `spawn()` expose only implementation functions and branded remote-state/event members, instance generations are host-owned, and local services are never discoverable remotely;
- business arguments, results, state, and events are validated as JSON; protocol envelopes cannot be forged as ordinary values;
- clients cannot choose context position, server typed values, telemetry parents, or cancellation targets other than their own request IDs;
- credentials, prompts, completions, tool arguments/results, and filesystem contents are not exposed unless an explicit contract permits them; state snapshots contain only client-safe data;
- remote methods authorize server-side even when the TypeScript client surface hides them.

## The coding agent as a plugin manifest

The coding agent is one manifest of built-in and third-party plugins; each app host loads its facets through the same kernel in deterministic order. Server facets cover the directory/management services, authentication and client authorization, and worker spawn/stop policy and health. Session facets cover session creation/restoration and the scoped Harness facade; providers, model selection, and authentication; tools, wrappers, and permissions; prompt/steer/abort/compaction services; transcript persistence and event projection; filesystem and subprocess effects; temporary service instances for deferred interactions; unattended-session policy; and server service consumption where a feature needs server-wide data. TUI facets cover the chat screen, transcript rendering, editor, commands, keybindings, pickers, renderers, screens/slots/dialogs, and themes; a web host carries analogous browser facets. Shared contracts are service tokens with JSON-safe DTOs, latest-value state and semantic event types, presentation-local screen/slot tokens, stable renderer discriminators, and portable structured errors.

The generic kernel knows none of these domain concepts; each app host knows only its own.

## Open decisions

Before this becomes normative:

- the exact minimal kernel contract (scope shape, phase ordering, failure policy), the built-in manifest, and the concrete server/session/TUI host context surfaces;
- the logical-manifest format, per-host entry-point resolution, and cross-process version pinning;
- whether directory state is projected per client (workspace-scoped snapshots) or one presentation-safe value plus method authorization;
- multiple selected sessions per presentation connection (a multi-pane web UI) — deferred; it changes the session-namespace API;
- authentication of presentations and session workers, and protocol version negotiation;
- the exact lazy `RemoteService` member-discovery and provider-kind-validation API, and the context-position and JSON-safe optional-argument policy from `rpc.md`;
- whether `RemoteState` is generic RPC infrastructure or host infrastructure; snapshot granularity; exact hydration/delivery-context semantics;
- state/event flow control and per-client buffering at the server; reference lifetime and garbage collection;
- the stable error envelope and expected-error registration; activation/disposal ordering, optional dependencies, and shared-proxy lifetime;
- the exact singleton/keyed mode validation, spawn/observe APIs, instance-key and generation rules, instance hydration protocol, and answer authorization; general memo-name ownership remains with the invocation-memo design;
- package boundaries between the generic kernel, agent plugin contracts, generic protocol machinery, and coding-agent host integration.

## Testing strategy

The handoff should include a reusable two-transport test matrix (loopback plus a real framed transport) covering:

- **Composition:** hosts start from one plugin manifest, not hard-coded features; per-host entry-point resolution with no session modules reachable in a presentation bundle; provide/demand-resolve round trip; mixed singleton/keyed use rejected; shared proxy/replica across concurrent consumers; instance snapshot plus spawn/close/re-spawn reconciliation; local services unreachable remotely; duplicate/missing service failures; activation only after registration; reverse-order disposal.
- **Connections:** `Connect` performs one abortable attempt and the host owns retries; peer identity comes from the accepting server's handshake; session and presentation hosts connect to that server, and `server.local` runs the same host boundaries without sockets.
- **RPC and context:** JSON call and `void` result; invalid argument/result and unknown service/member rejection; client span → `rpc.client` → `rpc.server` → service span; per-call cancellation isolation; disconnect aborts active calls; no callback, context, signal, telemetry object, or secret in wire JSON.
- **State and events:** a cold replica has `.value === undefined` and does not invoke subscribers before hydration; snapshot plus concurrent update has no gap; instance discovery and member-state hydration do not miss a spawn, update, or close; hydrated subscriptions immediately receive the current borrowed value; update ordering without defensive cloning; reconnect replaces stale state; provider switching clears readiness; subscribe/unsubscribe and disconnect cleanup; deliveries carry reconstructed source contexts; first snapshot callbacks run under the hydration context.
- **Registries:** ordered provider contributions rebuild deterministically; tool wrappers compose once and rebuild correctly after removal.
- **Presentation:** typed selections return values rather than labels; modal leases do not interleave multi-step dialogs; closing a queued instance removes it before display; closing an active instance aborts and dismisses only that dialog; non-cancellation observer failures reach host failure policy.
- **Routing:** attach authorizes at the server and rejects cross-workspace targets; attach/switch closes previous routed requests and instance tasks, then hydrates the selected session; a routed singleton or instance call reconstructs `Context` at the session worker, with cancellation and trace carriers traversing the server; stale instance generations are rejected; per-client keying prevents request-ID collisions; the server routes services whose contracts it does not load; session-worker failure leaves server services healthy and updates directory status; presentation disconnect cleanup reaches the session; summaries contain no `ownerId` or `cwd`.
- **Boundaries:** scoped agent and fleet capabilities cannot reach host ownership or whole-registry mutation; raw Harness/Session/SessionRepo capabilities unreachable from any client connection; job `wait` cancellation distinct from `job.cancel()`; stale/closed reference rejection; concurrent question invocations spawn distinct services visible in simultaneous TUI and web clients, survive having no connected presentation while the worker is live, disappear on worker loss, reappear under new generations when safe replay finds no answer memo, accept only one durable answer each, reject the tool wait rather than hang when the memo write fails, return committed answers without respawning on replay, clean up with durable tool-result staging, and close in every presentation; invocation cancellation writes no durable cancellation state.

## Collaborative diff review: a durable shared sidebar

A diff review starts in a presentation rather than in a tool invocation. A user asks to review the current working-tree diff; the session snapshots it and opens one shared review. Every attached TUI and web presentation renders the same patch and comments, and any authorized user may add a comment or submit the whole review as one prompt.

This uses two service modes:

```text
DiffReviewManager                         singleton service
  createReview()
    → persist immutable patch
    → spawn DiffReviews[reviewId]

DiffReviews[reviewId]                    keyed service
  document                               immutable patch state
  activity                               durable comments + status state
  addComment()                           commit, then publish
  submit()                               freeze, enqueue one prompt, close
```

The keyed instance is the live, reactive projection. A plugin-owned record is the durable authority. Pending comments are not weakly persisted: each acknowledged comment survives a worker restart, but the record is deleted after its prompt is durably accepted.

### Shared remote contract

```ts
interface DiffCommentInput {
	commentId: string; // stable across an uncertain retry
	path: string;
	side: "old" | "new";
	line: number;
	body: string;
}

interface DiffComment extends DiffCommentInput {
	author: { userId: string; displayName: string };
	createdAt: string;
}

interface DiffReviewDocument {
	reviewId: string;
	patch: string;
}

interface DiffReviewActivity {
	revision: number;
	comments: DiffComment[];
	status: "open" | "submitting";
}

interface DiffReviewManagerService {
	createReview(context: Context): Promise<void>;
}

interface DiffReviewService {
	readonly document: RemoteState<DiffReviewDocument>;
	readonly activity: RemoteState<DiffReviewActivity>;
	addComment(input: DiffCommentInput, context: Context): Promise<void>;
	submit(context: Context): Promise<void>;
}

const DiffReviewManager = defineRemoteService<DiffReviewManagerService>("diff-review-manager");
const DiffReviews = defineRemoteService<DiffReviewService>("diff-review");
```

The client never supplies a patch, author, or review ID. The session computes a bounded immutable patch, creates the ID, and derives each author from the authenticated identity in `Context`. `commentId` is only an idempotency key; it grants no authority.

### Narrow local durability capabilities

Unlike a question, this interaction has no invocation memo. The session facet therefore depends on local services backed by session storage and the durable prompt lane:

```ts
type DiffReviewRecord =
	| {
			reviewId: string;
			patch: string;
			revision: number;
			comments: DiffComment[];
			status: "open";
			submission: null;
	  }
	| {
			reviewId: string;
			patch: string;
			revision: number;
			comments: DiffComment[];
			status: "submission_pending";
			submission: { submissionId: string; prompt: string };
	  };

type OpenDiffReviewRecord = Extract<DiffReviewRecord, { status: "open" }>;
type SubmittingDiffReviewRecord = Extract<DiffReviewRecord, { status: "submission_pending" }>;

interface DiffSourceService {
	snapshotWorkingTree(context: Context): Promise<string>;
}

interface DiffReviewRecordsService {
	listPending(context: Context): Promise<DiffReviewRecord[]>;
	create(patch: string, context: Context): Promise<OpenDiffReviewRecord>;
	addComment(reviewId: string, input: DiffCommentInput, context: Context): Promise<OpenDiffReviewRecord>;
	freezeForSubmission(reviewId: string, context: Context): Promise<SubmittingDiffReviewRecord>;
	complete(reviewId: string, submissionId: string, context: Context): Promise<void>;
}

interface PromptQueueService {
	enqueueOnce(submissionId: string, prompt: string, context: Context): Promise<void>;
}

const DiffSource = defineLocalService<DiffSourceService>("diff-source");
const DiffReviewRecords = defineLocalService<DiffReviewRecordsService>("diff-review-records");
const PromptQueue = defineLocalService<PromptQueueService>("prompt-queue");
```

`DiffReviewRecords` serializes mutations per review. `addComment()` validates the anchor against the stored patch, stamps the authenticated author, deduplicates `commentId`, commits, and then returns the new revision. `freezeForSubmission()` atomically excludes later comments and stores a stable submission ID plus a prompt containing the immutable patch and that exact comment snapshot. If submission was already frozen, it returns the same record. `PromptQueue.enqueueOnce()` returns only after that logical prompt is durably accepted; retrying its submission ID cannot enqueue a second prompt.

### Why record mutations need a critical region

`DiffReviewRecords` builds on the session facet's `SessionTree` (`values.md`): typed durable values in a plugin-owned namespace. Each storage call is atomic, but an application read-modify-write cycle spans multiple calls and therefore multiple awaits. Concurrent service calls can interleave between them.

Concrete failure without serialization — two users press submit at the same time:

```text
submit A: getValue(record)          → status "open"
submit B: getValue(record)          → status "open"
submit A: setValue(frozen, subm-A)
submit B: setValue(frozen, subm-B)  → overwrites A's freeze
→ enqueueOnce(subm-A) and enqueueOnce(subm-B) both run: two prompts for one review
```

Each `setValue()` was atomic; the *cycle* was not. The same window exists in `addComment()` between checking the status and replacing the record.

In the one-authoritative-worker model, the simplest fix is a per-review **critical region**: a FIFO, non-reentrant async mutex whose `run(signal, fn)` admits one pending function at a time. Every operation that reads and mutates an existing review — including `addComment()`, `freezeForSubmission()`, and `complete()` — uses the same region for that review ID:

```ts
async freezeForSubmission(reviewId, context) {
	return regionFor(reviewId).run(context.abortSignal, async () => {
		const stored = await tree.getValue(reviewRecord(reviewId), context);
		if (stored === undefined) throw new RemoteServiceError("review_not_found", `Unknown review: ${reviewId}`);

		const current = stored.value;
		if (current.status === "submission_pending") return current; // idempotent retry

		const submissionId = newSubmissionId();
		const frozen: SubmittingDiffReviewRecord = {
			...current,
			revision: current.revision + 1,
			status: "submission_pending",
			submission: {
				submissionId,
				prompt: renderReviewPrompt(current.patch, current.comments),
			},
		};
		await tree.setValue(reviewRecord(reviewId), frozen, context);
		return frozen;
	});
}
```

`revision` is application-owned and monotonic per review. The region makes `current.revision + 1` unambiguous; the session-global storage `seq` remains storage ordering metadata and is not projected into the record. `publish()` may therefore compare returned record revisions directly.

A caller aborted while queued is removed from the FIFO and rejects without invoking `fn`. Once admitted, the region releases in `finally`; cancellation and storage failure may reject the operation, while each individual storage transition remains atomic. Stateful validation stays inside the region, but user interaction and unrelated I/O stay outside it. A repository method must not call another method that acquires the same non-reentrant region, and region entries may be discarded after a completed review has no owner or waiters.

The requirement is one linearizable read-modify-write path per review, not specifically a mutex. A storage compare-and-swap operation or a repository capability that serializes mutations could replace the process-local region. Durable settlement idempotency (`memoOnce()`, `enqueueOnce()`) solves crash and retry behavior after the record transition; it does not replace serialization of the transition itself.

### Session facet

```ts
function toDiffReviewActivity(record: DiffReviewRecord): DiffReviewActivity {
	return {
		revision: record.revision,
		comments: record.comments,
		status: record.status === "open" ? "open" : "submitting",
	};
}

export function diffReviewSessionFacet(bindings: CodingAgentSessionPluginContext) {
	const diffs = bindings.use(DiffSource);
	const records = bindings.use(DiffReviewRecords);
	const prompts = bindings.use(PromptQueue);

	function exposeReview(initial: DiffReviewRecord) {
		const document = bindings.remoteState({ reviewId: initial.reviewId, patch: initial.patch });
		const activity = bindings.remoteState(toDiffReviewActivity(initial));

		function publish(next: DiffReviewRecord, context: Context) {
			if (next.revision > activity.value.revision) activity.set(toDiffReviewActivity(next), context);
		}

		async function finish(record: SubmittingDiffReviewRecord, context: Context) {
			await prompts.enqueueOnce(record.submission.submissionId, record.submission.prompt, context);
			await records.complete(record.reviewId, record.submission.submissionId, context);
			close();
		}

		const close = bindings.spawn(DiffReviews, initial.reviewId, {
			document,
			activity,
			async addComment(input, context) {
				publish(await records.addComment(initial.reviewId, input, context), context);
			},
			async submit(context) {
				const frozen = await records.freezeForSubmission(initial.reviewId, context);
				publish(frozen, context);
				await finish(frozen, context);
			},
		});

		return { finish };
	}

	bindings.provide(DiffReviewManager, {
		async createReview(context) {
			const patch = await diffs.snapshotWorkingTree(context);
			const record = await records.create(patch, context);
			exposeReview(record);
		},
	});

	bindings.onActivate(async () => {
		for (const record of await records.listPending(BACKGROUND_CONTEXT)) {
			const review = exposeReview(record);
			if (record.status === "submission_pending") await review.finish(record, BACKGROUND_CONTEXT);
		}
	});
}
```

Every mutation commits before `publish()`. Concurrent comment and submit calls are ordered by the record repository: a comment committed first is in the frozen prompt; a comment arriving after the freeze receives `review_closed`. `complete()` deletes only the matching frozen record, and `close()` is idempotent.

The startup scan reconstructs every open keyed instance from durable records. A `submission_pending` record resumes delivery through `enqueueOnce()` and then closes. Thus a crash before prompt acceptance retries the prompt, while a crash after acceptance but before cleanup observes the same submission ID and only completes cleanup.

### TUI and web facets

The plugin owns its TUI and browser widgets. Both implement this local presentation interface; it is not an RPC contract:

```ts
type DiffReviewAction =
	| { type: "add_comment"; input: DiffCommentInput; context: Context }
	| { type: "submit"; context: Context };

interface DiffReviewPanel {
	render(activity: DiffReviewActivity): void;
	nextAction(signal: AbortSignal): Promise<DiffReviewAction | undefined>;
	close(): void;
}

function observeDiffReviews(
	scope: PluginLifecycleScope,
	session: SessionServices,
	openPanel: (document: DiffReviewDocument) => DiffReviewPanel,
) {
	scope.own(
		session.observe(DiffReviews, async (review, context) => {
			const document = review.service.document.value;
			if (document === undefined) throw new Error("Diff review was observed before hydration");
			const panel = openPanel(document);
			const unsubscribe = review.service.activity.subscribe((activity) => panel.render(activity));

			try {
				while (true) {
					const action = await panel.nextAction(context.abortSignal);
					if (action === undefined) return;
					if (action.type === "add_comment") {
						await review.service.addComment(action.input, action.context);
					} else {
						await review.service.submit(action.context);
					}
				}
			} finally {
				unsubscribe();
				panel.close();
			}
		}),
	);
}

// tui.ts
export function diffReviewTuiFacet(bindings: CodingAgentTuiPluginContext) {
	const manager = bindings.session.use(DiffReviewManager);
	bindings.commands.register("diff.review", (context) => manager.createReview(context));
	observeDiffReviews(bindings, bindings.session, (document) => createTuiDiffReviewPanel(bindings.slots, document));
}

// web.ts
export function diffReviewWebFacet(bindings: CodingAgentWebPluginContext) {
	observeDiffReviews(bindings, bindings.session, (document) => createWebDiffReviewPanel(bindings.views, document));
	// The web plugin's "Review diff" button calls bindings.session.use(DiffReviewManager).createReview(context).
}
```

`observe()` begins only after both state members hydrate. The panel receives the immutable document once, and subscribing to `activity` immediately renders current comments without retransmitting the patch on every edit. A late client sees the same pending review. Activity updates continue while `nextAction()` waits. Each sidebar action carries a fresh presentation-created `Context`; the longer-lived observation context controls only panel lifetime. When submission closes the keyed instance, every panel's observation context aborts and its `finally` block disposes the subscription and widget.

The submitted prompt contains the immutable patch and all frozen comments in one request. Abbreviated:

```text
Review this patch and address all comments:

<stored immutable patch>

- src/parser.ts, new line 42 — Armin: Preserve the original error cause.
- src/ui.ts, new line 18 — Jane: Keep this state visible after reconnect.
```

Comment authors give the sidebar its basic multiplayer presence. A current-viewer roster or cursors would be separate live state and would not be written to the review record.

This is a shared review, not a generic room primitive. Keyed services provide discovery and reactive lifetime; the record repository provides temporary durability; the prompt queue provides idempotent handoff into the session.

## Deferred: delta-based replicated state

> **Deferred:** `DeltaState` is not part of the initial plugin or RPC contract. Add it only after a concrete feature demonstrates that full-value `RemoteState` updates are too expensive and the same pattern appears in more than one feature.

A real replication gap remains. Some authoritative values are large, change frequently, and must support late joiners. `RemoteState` hydrates and reconnects correctly but sends a complete value on every update. `RemoteEvents` can send small deltas but has no snapshot, replay, or automatic gap recovery.

A canvas is one possible example: joining requires the complete document, while dragging a shape should send only that operation. With today's primitives, the plugin can expose `getSnapshot()` plus revisioned `RemoteEvents` and implement the join protocol itself:

```text
subscribe and buffer deltas
→ fetch and install a snapshot
→ discard buffered revisions covered by the snapshot
→ apply consecutive later deltas
→ on a gap or reconnect, discard the replica and start over
```

That feature-local protocol is the preferred initial solution. It keeps a hypothetical optimization out of the generic host and reveals whether flow control, authoritative replacement, or other requirements actually matter.

### Possible future primitive

If repeated implementations justify extraction, a future `DeltaState` could provide `RemoteState` hydration while using deltas for steady-state transport:

```ts
interface CanvasShape {
	shapeId: string;
	kind: "rect" | "ellipse" | "path";
	x: number;
	y: number;
	data: JsonValue;
}

type CanvasOp = { type: "upsert"; shape: CanvasShape } | { type: "delete"; shapeId: string };

interface CanvasDocument {
	shapes: Record<string, CanvasShape>;
}

interface CanvasDelta {
	author: string;
	ops: CanvasOp[];
}

const CanvasDocumentState = defineDeltaState<CanvasDocument, CanvasDelta>(
	"canvas-document",
	applyCanvasDelta,
);

interface DeltaState<S, D> {
	/** `undefined` until the first authoritative snapshot arrives. */
	readonly value: S | undefined;
	subscribe(
		listener: (value: S, change: { type: "snapshot" } | { type: "delta"; delta: D }, context: Context) => void,
	): () => void;
}

interface MutableDeltaState<S, D> extends DeltaState<S, D> {
	readonly value: S;
	apply(delta: D, context: Context): void;
	replace(value: S, context: Context): void;
}
```

The shared reducer is pure and deterministic. `apply()` synchronously reduces the provider's value and publishes one delta; `replace()` publishes a new authoritative snapshot. Business snapshots and deltas contain no transport revision. The host stamps revisions within the provider binding, buffers updates racing hydration, applies only consecutive frames, and requests a fresh snapshot after a gap or reconnect.

Supporting this requires an explicit new RPC member kind. The providing object carries the `DeltaState` definition ID; the provider announces that ID in member metadata; and the consuming host resolves the same imported definition before applying deltas locally. Until `rpc.md` specifies that registration and hydration protocol, `bindings.deltaState()` does not exist.

`DeltaState` would solve only live replication. It would not provide durable storage, mutation serialization, multi-writer merging, offline editing, or automatic mutation replay. A durable canvas would still serialize its own mutations, persist an admitted delta before publishing it, and coordinate log compaction with appends. Durable log cursors remain application/storage metadata and are independent of the host's transport revision.
