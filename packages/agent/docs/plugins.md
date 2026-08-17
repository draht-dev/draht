# Coding-Agent Application Hosts and Plugin Facets

> **Status:** Tentative design input, not a normative contract or implementation handoff. The examples use illustrative APIs that do not exist yet. Reconcile this design with `rpc.md`, `telemetry.md`, and the final harness contract before adding it to `harness.md` or creating a work package.

This document assumes you already understand `AgentHarness`, `AgentLane`, `Session`, `SessionTree`, `SessionRepo`, invocation `Context`, and telemetry. Read `rpc.md` for wire frames, remote references, subscriptions, and trace carriers, and `telemetry.md` for context propagation and cancellation semantics.

## Bird's-eye view

The new coding agent is assembled from an ordered plugin manifest, not a monolith with an extension API bolted on. Three layers:

1. The **plugin kernel** owns generic lifecycle mechanics: ordered setup, activation, scoped resource ownership, failure rollback, and reverse-order disposal. It knows nothing about Harness, tools, TUI components, RPC services, connections, or coding-agent policy.
2. An **application host** owns one concrete runtime and constructs the plugin context for that runtime. The **session host** runs in a session process and owns session authority — the real Harness. A **presentation host** (TUI today, web later) owns a user interface. A **coordinator host** runs in a coordinator process and owns fleet authority: session records (`SessionRepo`), session process management, and all routing between presentations and sessions.
3. A **plugin package** implements one feature as one or more host-specific **facets** — setup functions, one per host kind. Each facet receives only the context for its host.

Coordinators form a strict **management tree**. Every other process connects to exactly one coordinator:

```text
                 C0 (root coordinator)
                 ├─ TUI A          presentation client of C0
                 ├─ S0             session process managed by C0
                 ├─ C1 (child coordinator)
                 │   ├─ TUI B      presentation client of C1
                 │   └─ S1         session managed by C1
                 └─ C2 (child coordinator)
                     └─ S2         session managed by C2
```

Connection rules: a session connects only to the coordinator that manages it; a presentation connects to one coordinator; a child coordinator connects to its parent while accepting its own presentations, sessions, and children; the root has no parent. There is **no direct presentation→session connection** — all session traffic passes through coordinators.

A coordinator exposes **every session in the subtree it manages**. TUI A, connected to C0, can list and attach to S0, S1, and S2. TUI B, connected to C1, sees only C1's subtree — S1. Visibility never expands upward: connecting to a child never reveals the parent's or a sibling's sessions. Each coordinator needs only one routing map, `sessionId → local session connection or child coordinator connection`. A child reports a snapshot of its managed session records plus change events to its parent, and forwards any request its parent sends for a session it manages; the parent merges local and child records.

**Host** and **client** are roles per connection, not fixed process kinds. A coordinator is host to its presentations, sessions, and children, and client of its parent. The session↔coordinator connection carries calls in both directions: the session serves its exposed services and also consumes coordinator services. "Client" below always names the connection role, never a kind of plugin.

## Why this shape

- **Authority stays where it belongs.** Provider credentials and tool execution exist only in the session process; session records and process control only in coordinators. Nothing reaches a presentation except through a deliberate contract.
- **One feature stays coherent.** The question plugin's tool, dialog, and renderer ship in one package around one JSON contract, yet each facet is host-native code.
- **A new surface is presentation-only work.** A web facet for the question dialog or the session picker registers against existing tokens; session and coordinator code do not change.
- **Visibility scales with the tree.** Connect a management UI to the root to see everything; connect a workstation TUI to a leaf coordinator to see only its sessions.
- **No privileged built-ins.** Built-ins and third-party plugins receive identical contexts, so shipping the product continuously exercises the extension API.
- **Testable in pieces.** A facet tests against its host context, a contract against loopback, and a forwarded TUI → coordinator → session path against a real transport — independently.

## One feature, several host facets

A coding-agent plugin is a feature bundle that may provide a facet for any host:

```ts
interface CodingAgentPlugin {
	readonly id: string;
	readonly coordinator?: PluginFacet<CodingAgentCoordinatorPluginContext>;
	readonly session?: PluginFacet<CodingAgentSessionPluginContext>;
	readonly tui?: PluginFacet<CodingAgentTuiPluginContext>;
	readonly web?: PluginFacet<CodingAgentWebPluginContext>;
}

type PluginFacet<Context> = (context: Context) => void | Promise<void>;
```

`PluginFacet` is the only plugin-facing shape the generic kernel needs; the facet names and context types belong to the coding-agent application. Facets are optional: a `models.json` plugin has only a session facet, a terminal theme only a TUI facet, the session directory a coordinator facet plus a TUI facet. Examples use an illustrative `definePlugin()` helper returning a `CodingAgentPlugin` — the loaded, in-process shape.

A package keeps shared wire contracts separate from host dependencies:

```text
question-plugin/
  contract.ts       JSON DTOs and semantic service/interaction tokens
  session.ts        tool contribution; imports agent/session code
  tui.ts            terminal dialog and renderer; imports TUI code
  web.ts            optional browser dialog and renderer
  index.ts          loopback bundle; production hosts resolve per-host entry points
```

The browser build never imports `session.ts`; the session process never imports TUI or DOM code.

The question plugin is this document's end-to-end example:

```text
model calls the question tool                  (session facet)
→ session facet requests QuestionInteraction   (shared contract)
→ TUI facet presents a dialog, returns JSON    (TUI host context)
→ session facet returns the durable tool result
→ TUI facet renders it with its contributed renderer
```

The models service in the next sections illustrates services and replicated state; the [coordinator section](#the-coordinator-directory-management-and-forwarding) covers fleet services and forwarding; the [question section](#reverse-interactions-the-question-plugin) makes the full round trip concrete.

## What app startup does

Every host shares the **logical manifest** — plugin identity, order, and version, JSON-safe — never a JavaScript object. Each host resolves facet modules for those IDs from per-host entry points (for example, package export conditions `./coordinator`, `./session`, `./tui`, `./web`); a missing entry point means no facet for that host. Resolution, not convention, enforces the dependency boundary.

```ts
const manifest: PluginManifestEntry[] = [
	{ id: "@pi/session-core" },
	{ id: "@pi/providers-builtin" },
	{ id: "@pi/question" },
];

await coordinatorAppHost.start(manifest); // every coordinator process; resolves ./coordinator
await sessionAppHost.start(manifest);     // every session process; resolves ./session
await tuiAppHost.start(manifest);         // every TUI process; resolves ./tui
```

A loopback single-process app may instead load one `CodingAgentPlugin` bundle with several facets; each facet still receives only its own host context.

For each selected facet, the host asks the kernel to create a lifecycle scope, builds its host-specific context around that scope, and invokes the facet. The scope is the kernel's entire per-facet contract:

```ts
interface PluginLifecycleScope {
	onActivate(callback: () => void | Promise<void>): void;
	onDispose(callback: () => void | Promise<void>): void;
	own(disposal: () => void | Promise<void>): void;
}
```

Host contexts extend this scope. Host infrastructure calls `own()` whenever a facet registers a service, contribution, or subscription, so removal never depends on the facet undoing anything by hand. Nothing else in this document — services, tools, dialogs, interactions — is kernel API.

Startup runs in deterministic manifest order and two phases: facets register services, contributions, and callbacks, and all registrations become visible; then `onActivate` callbacks start background work and the host exposes its authoritative state snapshot to its connections. This prevents one facet from starting effects while another is still constructing a dependency. Duplicate service IDs reject during registration; missing services and cycles are trusted application-assembly errors — no dependency-injection framework. If setup or activation fails, the kernel disposes already-created scopes in reverse order; normal shutdown does the same.

The prototype in `packages/coding-agent/test/fixtures/plugin-app/` demonstrates the composition model with an ad hoc RPC implementation; the shared RPC design in `rpc.md` should replace that transport without replacing the host/facet architecture.

One process owns one session, and session authority never migrates. Each process has exactly one multiplexed connection to its coordinator; plugins never open private sockets. Plugin authors never implement request IDs, sockets, trace carriers, cancellation frames, remote-reference registries, or reconnect buffering.

Out of scope: arbitrary object remoting, serialized functions/classes/`Map`/`Set`, remote hook or tool execution, offline presentation writes or automatic mutation replay, a universal remote `AgentHarness` or serialized UI tree, and re-exposing forwarded frames, proxies, or references as plugin-visible objects.

## Services connect host facets

Facets communicate across processes through **services**. A service token is a typed identity plus trusted exposure metadata for the generic RPC layer:

```ts
function defineRemoteService<T>(id: string, exposure?: ServiceExposure<T>): RemoteService<T>;
```

The exact exposure-descriptor API belongs to `rpc.md`; examples use `state`, `events`, and `results` only to illustrate the required capabilities.

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

export const Models = defineRemoteService<ModelsService>("models", { state: ["state"] });
```

Everything in a contract is strict JSON: arguments, results, replicated state, events. That is why state uses `null`, never `undefined`. `Context` is control-plane data in a declared position; the proxy strips it and it is never serialized.

### Session facet

```ts
export const providersBuiltin = definePlugin({
	id: "@pi/providers-builtin",

	session(pluginContext: CodingAgentSessionPluginContext) {
		const providers = new ProviderRegistry(); // process-local, non-JSON
		const state = pluginContext.remoteState<ModelsState>(initialModelsState());

		pluginContext.provide(Models, {
			state,

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

			// cycleThinking is analogous: read configuration, state.set(next, context)
		});

		pluginContext.onActivate(() => providers.rebuild());
	},
});
```

### TUI facet

```ts
export const modelSelection = definePlugin({
	id: "@pi/model-selection",

	async tui(pluginContext: CodingAgentTuiPluginContext) {
		const models = await pluginContext.session.use(Models);
		pluginContext.commands.register("models.select", (ctx, model: ModelRef) => models.select(model, ctx));
		models.state.subscribe((next) => renderModelSelector(next));
	},
});
```

The TUI facet has no credentials, registry, or refresh logic: it calls a **typed proxy** — a generated object with the contract's method signatures whose calls become RPC — and renders replicated state. A web facet would do the same through the web host context.

### Service semantics

A service has **one owner and many consumers**: `providersBuiltin` provides `Models`; the model picker and the thinking-level control (one command bound to `ctrl+t`) both consume it.

`use()` has two modes:

- **Local:** in the process that provides the service, `use()` is synchronous and returns the actual implementation object. No serialization, no proxy.
- **Remote:** across a connection, `use()` is asynchronous and demand-driven: it subscribes to the service on first demand and resolves a typed proxy. Concurrent consumers of one token in one process share one proxy, one state replica, and one remote subscription.

Presentation facets consume remotely through two explicit namespaces — `coordinator.use()` and `session.use()`, defined below. Session facets consume their own process's services locally and coordinator services remotely through `coordinator.use()`. `provide()`, `use()`, and `remoteState()` are host infrastructure layered over the kernel scope, not kernel API.

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
	remoteState<T extends JsonValue>(initial: T): MutableRemoteState<T>;
	remoteEvents<T extends JsonValue>(): MutableRemoteEvents<T>;

	readonly coordinator: CoordinatorServices; // remote access to the managing coordinator

	// contribution registries (session-host owned)
	readonly providers: ProviderContributionRegistry;
	readonly tools: ToolContributionRegistry;

	// reverse interactions and attached-client lifecycle
	readonly interactions: SessionInteractions;
	onClientAttach(callback: (clientId: string) => void): void;
	onClientDetach(callback: (clientId: string) => void): void;
}
```

"Local" and "unrestricted" are separate decisions. The scope narrows authority for lifecycle and composition — hooks and event subscriptions registered through it are automatically owned by the plugin and disposed with it — but `sessionTree` may be the actual local derived object. The host keeps the unrestricted concrete instances and reserves: `AgentHarness.close()` and `Session.close()`; raw `Session.mutate()` and `SessionMutator` (unless a narrowly trusted durability plugin explicitly owns them); `idGenerator` and backend/storage objects; whole-registry setters such as `setTools()`; unscoped hook/event registration; transport exposure and remote-reference registration. This is a composition and lifecycle boundary, not a security sandbox: session facets are trusted code in the authoritative process. The manifest may explicitly grant broader local capability, but built-ins receive no implicit bypass.

**Presentation facets hold none of this.** A TUI or web facet never receives the raw Harness, Session, tree, tool registry, hooks, or credentials — not even as proxies. It receives only what a session or coordinator facet deliberately exposes: semantic service proxies, replicated state, and semantic events/interactions.

```ts
interface CoordinatorServices {
	use<T>(service: RemoteService<T>): Promise<T>; // terminates at the connected coordinator
	readonly connection: RemoteState<ConnectionState>;
}

type AttachmentState = { status: "detached" } | { status: "attaching" | "attached" | "degraded"; sessionId: string };

interface SessionServices {
	use<T>(service: RemoteService<T>): Promise<T>; // forwarded to the one selected session
	readonly attachment: RemoteState<AttachmentState>;
}

interface CodingAgentTuiPluginContext extends PluginLifecycleScope {
	readonly coordinator: CoordinatorServices; // two explicit remote namespaces
	readonly session: SessionServices;
	readonly interactions: PresentationInteractions;

	// terminal-specific facilities and contribution registries
	readonly ui: TuiFacilities; // select/input dialogs, overlays, focus
	readonly commands: CommandContributions;
	readonly keybindings: KeybindingContributions;
	readonly toolRenderers: ToolRendererContributions;
	readonly slots: SlotContributions;
}
```

The two namespaces are the topology made visible: `coordinator.use(SessionDirectory)` resolves a service the connected coordinator provides itself; `session.use(Models)` resolves a service of the one **selected session** — the session this presentation is currently attached to. A presentation has at most one selected session. `session.use()` resolves its shared proxy immediately; while detached, calls fail with `not_attached` and no state is present. The two namespaces fail independently: the coordinator connection can be healthy while the selected session is unreachable (`attachment.status === "degraded"`).

A future `CodingAgentWebPluginContext` carries the same two namespaces plus browser registries — routes, views, DOM dialogs. The coordinator context is defined in the [coordinator section](#the-coordinator-directory-management-and-forwarding). Contexts resemble each other by convention; no kernel-owned base type forces the shape.

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
const Accounts = defineRemoteService<AccountsService>("accounts", { state: ["state"] });
```

The auth plugin's session facet uses `Credentials` directly; presentations see provider IDs and `configured` booleans — never secrets. If some settings must not be remotely writable, split them the same way; do not rely on presentation-side convention.

## Replicated state: `RemoteState`

`ModelsService.state` is a `RemoteState<ModelsState>`: **authoritative latest-value replication** — not event history, durable storage, a CRDT, or a multi-writer mechanism.

```ts
interface RemoteState<T> {
	readonly value: T;
	subscribe(listener: (value: T, context: Context) => void): () => void;
}

interface MutableRemoteState<T> extends RemoteState<T> {
	set(value: T, context: Context): void;
}
```

Required behavior:

1. The providing host owns the one authoritative value; there are no remote writes.
2. **Hydration** — installing a complete snapshot of all exposed state values atomically before updates flow — happens when a consumer first subscribes; updates emitted meanwhile are buffered, so a client observes snapshot-then-updates with no gap.
3. After hydration, client `.value` is synchronously readable and `subscribe()` immediately reports the current value, then future updates. The immediate callback runs under a fresh **hydration context** parented to the subscription, because the write that produced the value may be long settled.
4. Values are detached with structured JSON semantics; one listener cannot mutate another's state.
5. Reconnect or reattach replaces client state from a fresh authoritative snapshot; disconnect retains the last value as stale display data alongside the connection/attachment state.
6. `set(value, context)` carries source trace metadata; each delivery invokes listeners with a reconstructed delivery `Context`. Background updates use an intentional background or lifecycle context, never a retained caller context.

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
const Git = defineRemoteService<GitService>("git", { state: ["status"], events: ["events"] });
```

Server-side, the exposure adapter subscribes to the host-local source once per remote subscription and forwards frames. Client-side, `events` is a local facade whose listeners run in the client process — callbacks never cross the wire; `on(type, listener)` filters by discriminator, `subscribe(listener)` observes everything. Each event carries source trace metadata from the providing host's context, so client-side handling stays correlated with the originating operation. The adapter owns subscribe/unsubscribe frames, sequencing, buffering, flow control, and disconnect cleanup (`rpc.md`). Critical resumable streams need stable event IDs and a replay policy; passive UI invalidation can re-hydrate from a fresh snapshot after reconnect.

## Service-owned jobs

Long-running work should return a capability rather than one method that blocks indefinitely:

```ts
interface IndexJob {
	readonly progress: RemoteState<IndexProgress>;
	wait(context: Context): Promise<IndexProgress>; // aborting this context cancels only this wait
	cancel(context: Context): Promise<void>;        // cancels the job itself, for everyone
}
```

An `IndexService.start(root, context)` returning an `IndexJob` validates the root, creates its own `AbortController` and a detached telemetry root, and returns the job. The job crosses the wire as a **remote object reference** (`rpc.md`) — an opaque ID the client proxy holds. It makes the cancellation domains concrete: `wait()` abort is invocation cancellation; `cancel()` is service-owned. The exposure registry must release completed references under an explicit lifetime policy.

## The coordinator: directory, management, and forwarding

The coordinator host does two jobs. It **owns fleet services** — listing, creating, deleting, attaching to sessions — implemented by coordinator facets against scoped local authority. And it **forwards session traffic** between attached presentations and session processes — pure host infrastructure that no plugin code touches.

### Coordinator host context

```ts
interface FleetPluginScope {
	readonly records: SessionRecordsView;      // scoped SessionRepo view: locally managed sessions
	readonly processes: SessionProcessesView;  // scoped process management: locally managed sessions
	readonly managed: ManagedSessionsView;     // merged records: local + all child coordinators
	readonly attachments: AttachmentsView;     // bind/unbind a client's selected session
}

interface CodingAgentCoordinatorPluginContext extends PluginLifecycleScope {
	readonly fleet: FleetPluginScope;
	// plus the same provide/use/remoteState/remoteEvents as the session host context
}
```

The reserved list mirrors the session host: the raw `SessionRepo`, storage handles, unrestricted process-kill authority, the routing map, and forwarding machinery stay with the coordinator application. `fleet.managed` is the host-maintained merge of locally managed records and every child coordinator's reported records — the host consumes each child's snapshot and change events over that child's connection and keeps the merge current:

```ts
interface ManagedSessionRecord {
	sessionId: string;
	title: string;
	workspaceId: string;
	ownerId: string;
	cwd: string; // ownerId and cwd never leave the coordinator
	status: "starting" | "active" | "idle" | "closed" | "unreachable";
	updatedAt: string;
}

type ManagedSessionChange = { type: "created" | "changed" | "deleted"; record: ManagedSessionRecord };

interface ManagedSessionsView {
	snapshot(): ManagedSessionRecord[];
	onChanged(listener: (change: ManagedSessionChange, context: Context) => void): () => void;
	create(options: { title: string; workspaceId: string }, context: Context): Promise<ManagedSessionRecord>;
	remove(sessionId: string, context: Context): Promise<void>; // local stop+remove, or forwarded to the managing child
}
```

### Shared contract

The directory is read; management mutates and selects. Both are presentation-safe: `ownerId` and `cwd` are stripped from summaries — **redaction**, removing fields a surface must not see.

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

export const SessionDirectory = defineRemoteService<SessionDirectoryService>("session-directory", {
	state: ["state"],
	events: ["events"],
});

export interface SessionManagementService {
	create(options: { title: string }, context: Context): Promise<SessionRecordSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}

export const SessionManagement = defineRemoteService<SessionManagementService>("session-management");
```

### Coordinator facet

```ts
// coordinator.ts
export function sessionDirectoryCoordinatorFacet(pluginContext: CodingAgentCoordinatorPluginContext) {
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
			const client = requireClientIdentity(context); // typed value installed by transport policy
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
		async detach(context) { await attachments.unbind(requireClientIdentity(context).clientId, context); },
	});
}

function authorizeTarget(client: ClientIdentity, records: ManagedSessionRecord[], sessionId: string) {
	const record = records.find((r) => r.sessionId === sessionId);
	if (record === undefined || record.workspaceId !== client.workspaceId) {
		throw new RemoteServiceError("not_authorized", `Not accessible: ${sessionId}`);
	}
}

function toSummary({ sessionId, title, workspaceId, status, updatedAt }: ManagedSessionRecord): SessionRecordSummary {
	return { sessionId, title, workspaceId, status, updatedAt }; // ownerId and cwd stop here
}
```

Every call is authorized against the client identity that transport policy installed server-locally — never against arguments. **Authorization repeats at every coordinator that owns or forwards a target:** when C0 forwards a `remove` or an attachment to C1, C1 re-checks that the target is a session it manages and that the stamped client identity is allowed. Coordinator↔coordinator links are mutually authenticated, so a child can trust its parent's identity stamping — and still refuses targets outside its own subtree.

### TUI facet: the picker

```ts
// tui.ts
export async function sessionPickerTuiFacet(pluginContext: CodingAgentTuiPluginContext) {
	const directory = await pluginContext.coordinator.use(SessionDirectory);
	const management = await pluginContext.coordinator.use(SessionManagement);

	pluginContext.commands.register("sessions.switch", async (context) => {
		const entries = directory.state.value.sessions;
		const picked = await pluginContext.ui.select(
			"Sessions",
			entries.map((entry) => pickerLabel(entry, pluginContext.session.attachment.value)),
			{ signal: context.abortSignal },
		);
		if (picked === undefined) return;
		await management.attach(entries[choiceIndex(entries, picked)].sessionId, context);
	});

	directory.state.subscribe((next) => renderSessionList(next));
}
```

The TUI facet never sees the tree. It consumes `SessionDirectory` exactly the way it consumes `Models`; a web facet consumes the same tokens with browser UI. There is no session facet in this plugin: sessions play no part in listing or selecting sessions.

### Trace 1: merged directory

```text
TUI A (at C0) coordinator.use(SessionDirectory)   — terminates at C0
C0 state = merge of local records (s0) + child-reported records (s1 via C1, s2 via C2)
C1's record for s1 changes → managed-record event C1 → C0
→ C0 re-merges, bumps its own revision, sets state → replicated to TUI A
```

Each coordinator owns its merged state and its own revision counter; child revisions never propagate. TUI B, connected to C1, receives C1's directory — s1 only. A client at a child never sees parent or sibling records.

### Attaching and switching

`attach(sessionId)` selects the session for this presentation connection:

1. the connected coordinator authorizes the client for the target;
2. it closes the client's previous routed session state along the forwarding path: in-flight forwarded requests are cancelled, forwarded subscriptions closed, forwarded references invalidated;
3. it binds the session namespace to the new session — directly if locally managed, otherwise via the managing child (each hop authorizes);
4. the session hydrates the client with a complete fresh snapshot; `session.attachment` becomes `attached`.

Session-namespace proxies are stable across switches: `session.use(Models)` resolved once keeps working against the new session. Frames belonging to closed subscriptions or requests are dropped.

### Trace 2: forwarded session call

```text
TUI A (at C0, selected session s1 managed by C1): rpc.client chat.prompt
C0: authorize client for s1; map s1 → child C1; forward frame stamped with client identity
C1: verify s1 is locally managed; map s1 → session connection S1; forward
S1: rpc.server chat.prompt — fresh local Context, validated JSON args → lane.prompt(...)
response returns S1 → C1 → C0 → TUI A; state and events flow the same path in reverse
```

Cancellation follows the path: aborting the TUI request sends a cancel frame TUI → C0 → C1 → S1, aborting the session-side request controller. Trace carriers are forwarded untouched — `Context` is reconstructed only at the session, never at a coordinator hop.

### Forwarding is host infrastructure

Coordinators forward session-namespace traffic **contract-agnostically**: they parse only protocol envelopes — frame kind, request/subscription/reference IDs, service ID, target session — never business payloads or plugin schemas. Validation happens at the endpoints, exactly as on a direct connection, so a coordinator routes any plugin's session service without loading that plugin. Two consequences:

- The coordinator stamps each forwarded frame with the client identity it authenticated. The session keys its per-client registries — requests, subscriptions, references — by that identity, so IDs from different presentations cannot collide and one client cannot use another's references.
- No plugin code participates in forwarding, and session services are never re-exposed as ordinary coordinator-owned proxies. A coordinator facet that wants fleet behavior implements a coordinator-owned semantic service (like the directory); it does not tunnel session contracts.

## Reverse interactions: the question plugin

Some session-side work must ask a connected presentation for a decision. The existing `examples/extensions/question.ts` shows the experience: the model calls a `question` tool, the user selects an option or types an answer, and the tool returns that answer with a compact rendering. Tool execution stays in the session; the dialog stays in a presentation. The bridge is a typed **semantic interaction** — a request/response contract in JSON, never a serialized callback or component.

### Shared contract

```ts
interface QuestionRequest {
	question: string;
	options: Array<{ label: string; description: string | null }>;
}

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

const QuestionInteraction = defineInteraction<QuestionRequest, QuestionResponse>("question");
```

`defineInteraction()` is a typed token like a service token. The session-side **broker** routes one request to an eligible attached presentation and returns its response:

```ts
interface SessionInteractions {
	request<Req extends JsonValue, Res extends JsonValue>(
		interaction: Interaction<Req, Res>, request: Req, context: Context,
	): Promise<Res>;
}

interface PresentationInteractions {
	handle<Req extends JsonValue, Res extends JsonValue>(
		interaction: Interaction<Req, Res>, handler: (request: Req, context: Context) => Promise<Res>,
	): () => void;
}
```

The broker owns request IDs, eligible-client selection, cancellation, disconnect handling, and response validation. Handler registrations reach the session over the coordinator forwarding path when a presentation attaches, and interaction requests and responses travel that same path in reverse (S1 → C1 → C0 → TUI A and back). The contract contains no TUI concepts.

### Session facet: contribute the tool

```ts
// session.ts
export function questionSessionFacet(pluginContext: CodingAgentSessionPluginContext) {
	pluginContext.tools.add((draft) => {
		draft.set("question", {
			label: "Question",
			description: "Ask the user a question and let them select or enter an answer.",
			executionMode: "sequential",
			parameters: QuestionParamsSchema, // typebox schema matching QuestionRequest

			async execute(params: QuestionRequest, context: Context) {
				if (params.options.length === 0) return questionResult(params, null, false, "No options provided");
				const response = await pluginContext.interactions.request(QuestionInteraction, params, context);
				if (response.outcome === "cancelled") return questionResult(params, null, false, "User cancelled the question");
				if (response.outcome === "custom") return questionResult(params, response.answer, true, `User wrote: ${response.answer}`);
				const selected = params.options[response.index];
				if (selected === undefined) throw new Error("Question response selected an invalid option");
				return questionResult(params, selected.label, false, `User selected: ${response.index + 1}. ${selected.label}`);
			},
		});
	});
}

function questionResult(request: QuestionRequest, answer: string | null, wasCustom: boolean, text: string) {
	return {
		content: [{ type: "text", text }],
		details: { question: request.question, options: request.options.map((o) => o.label), answer, wasCustom },
	} satisfies AgentToolResult<QuestionDetails>;
}
```

The session facet knows an answer is required; it knows nothing about terminal keys, dialogs, or rendering. It receives only the semantic `QuestionResponse`.

### TUI facet: dialog and renderer

```ts
// tui.ts
export function questionTuiFacet(pluginContext: CodingAgentTuiPluginContext) {
	pluginContext.interactions.handle(QuestionInteraction, async (request, context) => {
		const choices = [
			...request.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
			"Type something…",
		];
		const choice = await pluginContext.ui.select(request.question, choices, { signal: context.abortSignal });
		if (choice === undefined) return { outcome: "cancelled" };

		const index = choices.indexOf(choice);
		if (index < request.options.length) return { outcome: "selected", index };

		const answer = await pluginContext.ui.input("Your answer", "Type something…", { signal: context.abortSignal });
		return answer?.trim() ? { outcome: "custom", answer: answer.trim() } : { outcome: "cancelled" };
	});

	pluginContext.toolRenderers.add<QuestionDetails>("question", {
		renderCall(args, theme) {
			const options = args.options.map((o, i) => `${i + 1}. ${o.label}`).join(", ");
			const title = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			return new Text(`${title}\n${theme.fg("dim", `  Options: ${options}`)}`, 0, 0);
		},
		renderResult(result, theme) {
			if (result.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const prefix = result.wasCustom ? "(wrote) " : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", prefix) + theme.fg("accent", result.answer), 0, 0);
		},
	});
}
```

### Bundle and future facets

`index.ts` assembles the loopback bundle: `definePlugin({ id: "@pi/question", session: questionSessionFacet, tui: questionTuiFacet })`. A future web facet registers a modal against the same token without touching session code; an IDE host can use a native quick-pick; a headless host may decline. The same mechanism covers other reverse interactions: a dangerous Bash hook requests `ConfirmInteraction` — disconnect, timeout, no eligible client, or malformed response denies the tool **fail closed**; an OAuth plugin sends an authorization URL and asks for a returned code; editor plugins exchange semantic text and selections, never component trees. Secrets need an explicitly sensitive interaction contract; secret responses must never enter replicated state, logs, events, or telemetry attributes.

## Lifecycle and disposal

Every facet-owned resource — service registrations, contributions, state subscriptions, watchers, timers, in-flight RPCs, subprocesses, overlays — is owned by the facet's kernel scope and disposed when that scope closes, in reverse manifest order. Scoped capabilities enforce this automatically for hooks and event subscriptions; `onDispose` handles the rest. Removing a plugin disposes its scope in every host that loaded a facet and rebuilds any contribution registries it touched; neither requires the plugin to undo anything by hand.

## Connection loss, errors, and security

Disconnect behavior, from the plugin author's perspective:

- **A presentation disconnects.** Its coordinator aborts the client's active requests (including forwarded ones, along the path), closes its subscriptions and forwarded references, and the selected session's `onClientDetach` fires. Session-owned work continues per application policy; interactions awaiting that client fail.
- **A session process disconnects or crashes.** Its coordinator fails forwarded in-flight calls with `session_unavailable` and updates the managed record's status, which propagates up the tree into every merged directory. Attached presentations see `attachment.status === "degraded"` and keep stale session-namespace state — while their coordinator namespace stays healthy, so the picker still works and the user can attach elsewhere.
- **A child coordinator disconnects from its parent.** The parent marks that child's records `unreachable` and tears down attachments forwarded through it. The child's own subtree keeps working for clients connected at or below it.
- **A process loses its coordinator.** A presentation loses both namespaces: stale state plus a disconnected `coordinator.connection`. A session loses coordinator services and all attached clients at once; unattended-session policy decides whether it exits.
- Reconnect and reattach always hydrate from a fresh authoritative snapshot; prior remote references are invalid unless the exposure has explicitly session-stable identity. **Never blindly replay a mutation after an uncertain disconnect** — a replayed `select()` is harmless, a replayed `prompt()` is not. Reconnect, hydrate, and reconcile, or design the operation around a stable operation ID with explicit lookup semantics.

Errors cross the wire as a JSON envelope `{ code, message, data? }` with stable codes. Expected service errors use stable codes or result values; unexpected exceptions become an internal error with safe metadata — no stacks or sensitive causes by default. Cancellation, disconnect, unknown service/method, invalid arguments/results, stale references, `not_attached`, `not_authorized`, `unknown_session`, and `session_unavailable` need distinct codes.

Security rules every providing host (session and coordinator alike) must enforce:

- remote service IDs and members are allowlisted by trusted manifests or exposure descriptors; local services are never discoverable remotely;
- business arguments, results, state, and events are validated as JSON; protocol envelopes cannot be forged as ordinary values;
- clients cannot choose context position, server typed values, telemetry parents, or cancellation targets other than their own request IDs;
- credentials, prompts, completions, tool arguments/results, and filesystem contents are not exposed unless an explicit contract permits them; state snapshots contain only client-safe data;
- remote methods authorize server-side even when the TypeScript client surface hides them, and **every coordinator that owns or forwards a target re-authorizes it**.

## The coding agent as a plugin manifest

The coding agent is one manifest of built-in and third-party plugins; each app host loads its facets through the same kernel in deterministic order. Coordinator facets cover the directory/management services, fleet authentication and client authorization, and process spawn/stop policy and health. Session facets cover session creation/restoration and the scoped Harness facade; providers, model selection, and authentication; tools, wrappers, and permissions; prompt/steer/abort/compaction services; transcript persistence and event projection; filesystem and subprocess effects; interaction requests; unattended-session policy; and coordinator service consumption where a feature needs fleet data. TUI facets cover the chat screen, transcript rendering, editor, commands, keybindings, pickers, renderers, screens/slots/dialogs, and themes; a web host carries analogous browser facets. Shared contracts are service and interaction tokens with JSON-safe DTOs, latest-value state and semantic event types, presentation-local screen/slot tokens, stable renderer discriminators, and portable structured errors.

The generic kernel knows none of these domain concepts; each app host knows only its own.

## Open decisions

Before this becomes normative:

- the exact minimal kernel contract (scope shape, phase ordering, failure policy), the built-in manifest, and the concrete coordinator/session/TUI host context surfaces;
- the logical-manifest format, per-host entry-point resolution, and cross-process version pinning;
- whether directory state is projected per client (workspace-scoped snapshots) or one presentation-safe value plus method authorization;
- the standalone/loopback story: an in-process coordinator host versus an absent coordinator, and how `coordinator.use()` degrades;
- multiple selected sessions per presentation connection (a multi-pane web UI) — deferred; it changes the session-namespace API;
- authentication of presentations, sessions, and child coordinators, and protocol version negotiation;
- the exact `RemoteService`/exposure-descriptor API, and the context-position and JSON-safe optional-argument policy from `rpc.md`;
- whether `RemoteState` is generic RPC infrastructure or host infrastructure; snapshot granularity; exact hydration/delivery-context semantics;
- state/event flow control and per-client buffering at forwarding coordinators; reference lifetime and garbage collection;
- the stable error envelope and expected-error registration; activation/disposal ordering, optional dependencies, and shared-proxy lifetime;
- reverse-interaction routing and eligible-client policy when several presentations are attached;
- package boundaries between the generic kernel, agent plugin contracts, generic protocol machinery, and coding-agent host integration.

## Testing strategy

The handoff should include a reusable two-transport test matrix (loopback plus a real framed transport) covering:

- **Composition:** hosts start from one plugin manifest, not hard-coded features; per-host entry-point resolution with no session modules reachable in a presentation bundle; provide/demand-resolve round trip; shared proxy/replica across concurrent consumers; local services unreachable remotely; duplicate/missing service failures; activation only after registration; reverse-order disposal.
- **RPC and context:** JSON call and `void` result; invalid argument/result and unknown service/member rejection; client span → `rpc.client` → `rpc.server` → service span; per-call cancellation isolation; disconnect aborts active calls; no callback, context, signal, telemetry object, or secret in wire JSON.
- **State and events:** snapshot plus concurrent update with no gap; update ordering and detached values; reconnect replaces stale state; subscribe/unsubscribe and disconnect cleanup; deliveries carry reconstructed source contexts; immediate snapshot callbacks run under the hydration context.
- **Registries:** ordered provider contributions rebuild deterministically; tool wrappers compose once and rebuild correctly after removal.
- **Forwarding:** a parent's directory merges local and child records and updates on child record events; a client at a child sees no parent or sibling records; attach authorizes at the connected coordinator and again at the managing child, rejecting cross-workspace targets; attach/switch closes previous forwarded requests/subscriptions/references and hydrates a complete fresh snapshot; a forwarded call across two coordinators reconstructs `Context` only at the session, with cancel frames and trace carriers traversing the path; per-client keying prevents ID collisions and cross-client reference use; coordinators forward services whose contracts they do not load; session crash leaves the coordinator namespace healthy, retains stale session state, and updates directory status; child coordinator disconnect marks records unreachable and tears down forwarded attachments while the child's subtree keeps serving; presentation disconnect cleanup reaches the session; summaries contain no `ownerId` or `cwd`.
- **Boundaries:** scoped agent and fleet capabilities cannot reach host ownership or whole-registry mutation; raw Harness/Session/SessionRepo capabilities unreachable from any client connection; job `wait` cancellation distinct from `job.cancel()`; stale/closed reference rejection; reverse-interaction success, timeout, disconnect, and fail-closed permission behavior; invocation cancellation writes no durable cancellation state.
