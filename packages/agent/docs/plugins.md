# Coding-Agent Application Hosts and Plugin Facets

> **Status:** Tentative design input, not a normative contract or implementation handoff. The examples use illustrative APIs that do not exist yet. Reconcile this design with `rpc.md`, `telemetry.md`, and the final harness contract before adding it to `harness.md` or creating a work package.

This document assumes you already understand `AgentHarness`, `AgentLane`, `Session`, `SessionTree`, `SessionRepo`, invocation `Context`, telemetry, and the generic RPC design at a conceptual level. Read `rpc.md` for wire frames, remote references, subscriptions, and trace carriers, and `telemetry.md` for context propagation and cancellation semantics.

## Bird's-eye view

The new coding agent is not a monolithic application with an extension API bolted on. It is assembled from an ordered plugin manifest. The architecture has three distinct layers:

1. The **plugin kernel** owns generic lifecycle mechanics: ordered setup, activation, scoped resource ownership, failure rollback, and reverse-order disposal. It knows nothing about Harness, tools, TUI components, browsers, RPC services, or coding-agent policy.
2. An **application host** owns one concrete runtime and constructs the plugin context for that runtime. The session host exposes session authority and session contribution registries. The TUI host exposes terminal UI facilities and TUI contribution registries. A future web host exposes browser facilities and web contribution registries. A **coordinator** (server) host manages session processes and exposes fleet authority: session records (`SessionRepo`) and process management.
3. A **plugin package** implements one feature as one or more host-specific **facets**. Each facet receives only the context for its host.

```text
                         ordered coding-agent manifest
                    ┌──────────────┼──────────────┐
                    │              │              │
             session facets     TUI facets    future web facets
                    │              │              │
          ┌─────────▼────────┐ ┌───▼──────────┐ ┌─▼────────────┐
          │ session app host │ │ TUI app host │ │ web app host │
          │ + plugin kernel  │ │ + kernel     │ │ + kernel     │
          ├─ host context ───┤ ├─ context ────┤ ├─ context ────┤
          │ scoped Harness   │ │ RPC services │ │ RPC services │
          │ Session/Tree     │ │ TUI/dialogs  │ │ DOM/routes   │
          │ tools/providers  │ │ renderers    │ │ web views    │
          └─────────┬────────┘ └──────┬───────┘ └──────┬───────┘
                    │                 │                │
                    └──────── semantic RPC/state/events/interactions ────────┘
```

The plugin kernel is reusable machinery. It does not define a universal `PluginContext`. Each app host deliberately defines the authority and extension points its facets receive.

A deployment adds one more host of the same shape upstream of the session process. The coordinator is not the session process; it manages session processes:

```text
TUI / web app hosts ──▶ session app host ──▶ coordinator app host
  RPC clients of the     service host for       service host for
  session process        presentations;         session processes;
                         RPC client of the      owns SessionRepo and
                         coordinator            process management
```

Everything a user recognizes as "the coding agent" — providers, model selection, authentication, chat, core tools, permissions, transcript rendering, and the model picker — comes from these facets. Built-ins and packaged third-party extensions use the same host APIs. There is no privileged built-in path hidden in a kernel.

One terminology rule: **host** and **client** are roles per connection, not fixed process kinds. Every presentation host process (TUI, web, IDE) is an RPC client of the session host; the session process is simultaneously the service host for its presentations and an RPC client of the coordinator. "Client" below always names the connection role — the peer of a disconnect, a subscription, a replicated snapshot. It never names a kind of plugin; plugins have host facets.

## Why this shape

Concretely, for the examples in this document:

- **Authority stays where it belongs.** Provider credentials and tool execution exist only in the session process; `SessionRepo` and process control only in the coordinator. Nothing reaches a presentation except through a deliberate contract.
- **One feature stays coherent.** The question plugin's tool, dialog, and renderer ship in one package around one JSON contract, yet each facet is host-native code with host-native capabilities.
- **A new surface is presentation-only work.** A web facet for the question dialog or the session picker registers against existing tokens; session and coordinator code do not change.
- **Topology composes.** Because host and client are per-connection roles, the session process serves downstream presentations while consuming upstream coordinator services with the same machinery; further tiers need no new concepts.
- **No privileged built-ins.** Built-ins and third-party plugins receive identical contexts, so shipping the product continuously exercises the extension API.
- **Testable in pieces.** A facet tests against its host context, a contract against loopback, and a full TUI → session → coordinator chain against a real transport — independently.

## One feature, several host facets

A coding-agent plugin is a feature bundle. It may provide a facet for any host:

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

A facet is a setup function over its host's context type; `PluginFacet` is the only plugin-facing shape the generic kernel needs. Names such as `coordinator`, `session`, `tui`, and `web`, and the context types behind them, belong to the coding-agent application. Examples below use an illustrative `definePlugin()` helper that returns a `CodingAgentPlugin` — the loaded, in-process shape. Across processes, only the logical manifest (plugin identity, order, version) is shared; each host loads its own facet module, as startup shows.

Facets are optional. A `models.json` plugin may have only a session facet. A terminal theme may have only a TUI facet. A fleet feature such as the session directory adds a coordinator facet. Chat normally has a session facet that owns prompt authority, a TUI facet that contributes the terminal transcript and editor, and eventually a web facet that contributes browser-native presentation. "Two halves" is useful shorthand for session plus one presentation, but it is not the architecture's limit.

A package keeps shared wire contracts separate from host dependencies:

```text
question-plugin/
  contract.ts       JSON DTOs and semantic service/interaction tokens
  session.ts        tool contribution; imports agent/session code
  tui.ts            terminal dialog and renderer; imports TUI code
  web.ts            optional browser dialog and renderer
  index.ts          loopback bundle; production hosts resolve per-host entry points
```

The browser build never imports `session.ts`; the session process never imports TUI or DOM code. Small compatible facets may share a module, but the host-specific dependency boundary must remain valid.

The question plugin is this document's end-to-end example. Its complete trace:

```text
model calls the question tool                  (session facet)
→ session facet requests QuestionInteraction   (shared contract)
→ TUI facet presents a terminal dialog         (TUI host context)
→ TUI facet returns a JSON response            (shared contract)
→ session facet returns the durable tool result
→ TUI facet renders that result with its contributed renderer
```

The models service in the next sections illustrates the service and replicated-state machinery this flow does not need; the question sections then make the full round trip concrete.

## What app startup does

Each runtime instantiates the same generic lifecycle kernel through a different app host. What every host shares is the **logical manifest** — plugin identity, order, and version, JSON-safe — never a JavaScript object. Each host resolves facet **modules** for those IDs from per-host entry points, so a host never imports code it cannot run:

```ts
// logical manifest: shared identity and order (JSON-safe, same in every process)
const manifest: PluginManifestEntry[] = [
	{ id: "@pi/session-core" },
	{ id: "@pi/providers-builtin" },
	{ id: "@pi/chat" },
	{ id: "@pi/question" },
	{ id: "@pi/session-directory" },
];

await coordinatorAppHost.start(manifest); // resolves each plugin's ./coordinator entry point
await sessionAppHost.start(manifest);     // resolves each plugin's ./session entry point
await tuiAppHost.start(manifest);         // resolves each plugin's ./tui entry point
```

A plugin package declares per-host entry points (for example, package export conditions `./coordinator`, `./session`, `./tui`, `./web`); a missing entry point means no facet for that host. The web bundle therefore contains only `contract.ts` and `web.ts` — "browser builds never import `session.ts`" is enforced by resolution, not convention. A loopback single-process app may instead load one `CodingAgentPlugin` bundle with several facets; each facet still receives only its own host context. The coordinator host runs once and starts session processes on demand; each session process runs its own session host.

For each selected facet, an app host asks the kernel to create a lifecycle scope, builds its host-specific context around that scope, and invokes the facet. The scope is the kernel's entire per-facet contract:

```ts
interface PluginLifecycleScope {
	onActivate(callback: () => void | Promise<void>): void;
	onDispose(callback: () => void | Promise<void>): void;
	own(disposal: () => void | Promise<void>): void;
}
```

Host contexts extend this scope. Host infrastructure calls `own()` whenever a facet registers a service, contribution, or subscription, so removal never depends on the facet undoing anything by hand. Nothing else in this document — services, tools, dialogs, interactions — is kernel API.

Once all facets have registered their services and contributions, the kernel runs activation callbacks. If setup or activation fails, the kernel disposes already-created scopes in reverse order. Normal shutdown does the same.

The result is a clean ownership chain:

```text
process/runtime
└─ app host
   └─ generic plugin kernel
      └─ plugin facet scope
         ├─ service registrations
         ├─ contributions and subscriptions
         ├─ in-flight work and child controllers
         └─ activation/disposal callbacks
```

The prototype in `packages/coding-agent/test/fixtures/plugin-app/` demonstrates the composition model with an ad hoc RPC implementation. The shared RPC design in `rpc.md` should replace that transport without replacing the host/facet architecture.

One process owns one session, and session authority never migrates into presentation hosts. The coordinator owns no session content: it owns session records and process management. Session-to-presentation traffic uses one multiplexed connection, and session-to-coordinator traffic uses one multiplexed upstream connection; plugins do not open private sockets. A loopback app preserves the same semantic boundary and serialization rules. Plugin authors do not implement request IDs, sockets, trace carriers, cancellation frames, remote-reference registries, or reconnect buffering.

Out of scope: arbitrary object remoting, serialized functions/classes/`Map`/`Set`, remote hook or tool execution, offline presentation writes or conflict resolution, automatic mutation replay after reconnect, a universal cross-process action registry, a universal remote `AgentHarness` or serialized UI tree, and blind re-exposure of upstream proxies, references, or subscription frames onto downstream connections.

## Services connect host facets

Facets communicate across hosts through **services**. A service token is a typed identity plus trusted exposure metadata for the generic RPC layer:

```ts
function defineRemoteService<T>(id: string, exposure?: ServiceExposure<T>): RemoteService<T>;
```

The exact exposure-descriptor API belongs to `rpc.md`; these examples use `state`, `events`, and `results` only to illustrate the required capabilities.

The next sections use the models service — the authority behind the model picker and thinking-level control — because it exercises methods, replicated state, and multiple consumers. The question plugin returns as the end-to-end trace in [Reverse interactions](#reverse-interactions-the-question-plugin-end-to-end).

### Shared contract

```ts
export type ThinkingLevel = "off" | "low" | "high";

export interface ModelRef {
	provider: string;
	modelId: string;
}

export interface ModelSpec extends ModelRef {
	name: string;
	reasoning: boolean;
}

export interface ModelsState {
	catalog: { revision: number; availableModels: ModelSpec[] };
	configuration: { model: ModelRef | null; thinkingLevel: ThinkingLevel };
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

Everything in the contract is strict JSON: arguments, results, replicated state, and events. That is why the contract uses `null` rather than `undefined` inside state. `Context` is control-plane data in a declared position; it is stripped by the proxy and never serialized.

### Session facet

```ts
export const providersBuiltin = definePlugin({
	id: "@pi/providers-builtin",

	session(pluginContext: CodingAgentSessionPluginContext) {
		const providers = new ProviderRegistry(); // process-local, non-JSON
		const state = pluginContext.remoteState<ModelsState>({
			catalog: { revision: 0, availableModels: [] },
			configuration: { model: null, thinkingLevel: "high" },
			refresh: { status: "idle" },
		});

		pluginContext.provide(Models, {
			state,

			async select(model, context) {
				context.abortSignal?.throwIfAborted();
				const spec = state.value.catalog.availableModels.find(
					(m) => m.provider === model.provider && m.modelId === model.modelId,
				);
				if (spec === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
				state.set(
					{
						...state.value,
						configuration: {
							model,
							thinkingLevel: spec.reasoning ? state.value.configuration.thinkingLevel : "off",
						},
					},
					context,
				);
			},

			async cycleThinking(context) {
				const configuration = cycleThinkingLevel(state.value.configuration); // off → low → high → off
				state.set({ ...state.value, configuration }, context);
			},

			async refresh(context) {
				state.set({ ...state.value, refresh: { status: "refreshing" } }, context);
				const errors = await providers.refresh(context.abortSignal);
				state.set(
					{
						...state.value,
						catalog: providers.snapshot(),
						refresh:
							errors.size === 0
								? { status: "done" }
								: { status: "warning", errors: Object.fromEntries(errors) },
					},
					context,
				);
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

	async tui(pluginContext: CodingAgentTuiPluginContext) {
		const models = await pluginContext.use(Models);

		pluginContext.commands.register("models.select", (commandContext, model: ModelRef) =>
			models.select(model, commandContext),
		);
		pluginContext.commands.register("models.refresh", (commandContext) => models.refresh(commandContext));

		models.state.subscribe((next) => renderModelSelector(next));
	},
});
```

The TUI facet has no provider credentials, no registry, and no refresh logic. It calls a typed proxy and renders replicated state. A future web facet would do exactly the same through the web host context.

### Service semantics

A service has **one owner and many consumers**. `providersBuiltin` provides `Models`; the model picker and the thinking-level control both consume it:

```ts
export const thinkingControl = definePlugin({
	id: "@pi/thinking-control",
	async tui(pluginContext: CodingAgentTuiPluginContext) {
		const models = await pluginContext.use(Models);
		pluginContext.commands.register("thinking.cycle", (context) => models.cycleThinking(context));
		pluginContext.keybindings.bind("ctrl+t", "thinking.cycle");
	},
});
```

`use()` has two modes, and the difference matters:

- **Local:** in the process that provides the service, `use()` is synchronous and returns the actual implementation object. No serialization, no proxy.
- **Remote:** across a connection, `use()` is asynchronous and demand-driven. It subscribes to the service on first demand and resolves a typed proxy. Concurrent consumers of one token in one process share one proxy, one state replica, and one remote subscription.

Presentation hosts consume session services remotely. The session host consumes coordinator services remotely through `upstream.use()` — the same semantics over its one upstream connection (see the [session directory](#chained-hosts-the-session-directory-end-to-end)). A process may provide services on one connection and consume them on another.

`provide()`, `use()`, and `remoteState()` are host infrastructure layered over the kernel scope, not kernel API. The complete host contexts appear in the next section.

Registration and activation are separate kernel phases, in deterministic manifest order:

1. facets run and register services, contributions, and lifecycle callbacks;
2. all registrations become visible;
3. `onActivate` callbacks start background work (the provider rebuild above);
4. the host exposes its authoritative state snapshot to its connections.

This prevents one facet from starting effects while another is still constructing a dependency. Duplicate service IDs reject during registration. Missing services and dependency cycles are trusted application-assembly errors; this design does not need a dependency-injection framework.

## What each host context grants

This is the most important boundary in the design, so it is worth stating bluntly.

**Session facets run beside the real thing.** They execute in the process that owns the concrete `AgentHarness`, `AgentLane`, `Session`, and `SessionTree`, and they receive direct, process-local, scoped capabilities backed by those instances — not RPC proxies. Calls preserve the real method signatures, `Context` propagation, `Result` types, and object identity. They do not serialize arguments, create remote references, or start `rpc.client`/`rpc.server` spans. A session facet never RPCs back into its own process.

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
	// scoped local session authority
	readonly agent: AgentPluginScope;

	// service/state infrastructure (session-host owned)
	provide<T>(service: RemoteService<T> | LocalService<T>, implementation: T): void;
	use<T>(service: RemoteService<T> | LocalService<T>): T;
	remoteState<T extends JsonValue>(initial: T): MutableRemoteState<T>;
	remoteEvents<T extends JsonValue>(): MutableRemoteEvents<T>;

	// upstream access to the coordinator (session host is the client here)
	readonly upstream: SessionUpstream;

	// contribution registries (session-host owned)
	readonly providers: ProviderContributionRegistry;
	readonly tools: ToolContributionRegistry;

	// reverse interactions and connection lifecycle
	readonly interactions: SessionInteractions;
	onClientConnect(callback: (clientId: string) => void): void;
	onClientDisconnect(callback: (clientId: string) => void): void;
}

interface CodingAgentTuiPluginContext extends PluginLifecycleScope {
	// remote semantic access (presentation-host infrastructure)
	use<T>(service: RemoteService<T>): Promise<T>;
	readonly connection: RemoteState<ConnectionState>;
	readonly interactions: PresentationInteractions;

	// terminal-specific facilities and contribution registries
	readonly ui: TuiFacilities; // select/input dialogs, overlays, focus
	readonly commands: CommandContributions;
	readonly keybindings: KeybindingContributions;
	readonly toolRenderers: ToolRendererContributions;
	readonly slots: SlotContributions;
}
```

A future `CodingAgentWebPluginContext` carries the same remote semantic access plus browser-specific registries — routes, views, DOM dialogs. The coordinator host context is defined with the [session directory example](#chained-hosts-the-session-directory-end-to-end). Contexts resemble each other by convention; no kernel-owned base type forces the shape.

"Local" and "unrestricted" are separate decisions. The scope narrows authority for lifecycle and composition — hooks and event subscriptions registered through it are automatically owned by the plugin and disposed with it — but the `sessionTree` may be the actual local derived object. The host keeps the unrestricted concrete instances and reserves:

- `AgentHarness.close()` and `Session.close()`;
- raw `Session.mutate()` and `SessionMutator`, unless a narrowly trusted durability plugin explicitly owns them;
- `idGenerator` and backend/storage objects;
- whole-registry setters such as `setTools()`;
- unscoped hook/event registration that cannot be disposed with the plugin;
- transport exposure and remote-reference registration.

This is a composition and lifecycle boundary, not a security sandbox: session facets are trusted code in the authoritative process. The application manifest may explicitly grant a plugin broader local capabilities when its responsibility requires them, but built-ins receive no implicit bypass and broad access is not the default contract.

**Presentation facets hold none of this.** A TUI or web facet never receives the raw `AgentHarness`, `Session`, `SessionTree`, tool registry, hooks, or credentials — not even as proxies. It receives only what a session facet deliberately exposes: semantic service proxies, replicated state, and semantic events/interactions.

```text
concrete Harness / Session / SessionTree
→ direct local scoped capability in a session facet
→ plugin-defined semantic service
→ generic RPC
→ typed proxy in a presentation facet
```

Concretely, a chat plugin exposes a narrow shared contract:

```ts
interface PromptResponse {
	accepted: boolean;
	operationId: string | null;
	error: { code: string; message: string } | null;
}

interface ChatService {
	prompt(request: { message: AgentMessage[] }, context: Context): Promise<PromptResponse>;
	requestAbort(operationId: string, context: Context): Promise<void>;
}

const Chat = defineRemoteService<ChatService>("chat");
```

Its session facet implements that contract with direct local lane capabilities:

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

Its TUI facet consumes `Chat` exactly as the model picker consumes `Models`: a typed proxy, a command registration, nothing else. A review plugin similarly exposes review operations. Neither reveals the Harness object that implements them, and there is no universal remote Harness available to arbitrary plugins.

`rpc.md` may still define generic Harness proxies for other trusted integrations (an IDE bridge, an orchestrator). Those are deliberate, separate exposures — not the coding-agent plugin boundary.

## Local services and narrow remote façades

Not every dependency should be remotely reachable. A **local service** is a token confined to its providing process:

```ts
const Providers = defineLocalService<ProviderRegistry>("providers");
```

A local service may hold functions, native objects, credentials, filesystem handles, or other non-JSON state. Presentation-host `use()` cannot resolve it because it has no remote exposure, and local services are never discoverable remotely.

The pattern for sensitive state is a local full service plus a narrow remote façade. Credentials are the canonical example:

```ts
interface CredentialStore {
	get(provider: string): Promise<string | undefined>;
	set(provider: string, credential: string): Promise<void>;
}
const Credentials = defineLocalService<CredentialStore>("credentials");

interface AccountsService {
	readonly state: RemoteState<{ providers: Array<{ provider: string; configured: boolean }> }>;
	remove(provider: string, context: Context): Promise<void>;
}
const Accounts = defineRemoteService<AccountsService>("accounts", { state: ["state"] });
```

The auth plugin's session facet uses `Credentials` directly. Presentation hosts see provider IDs and `configured` booleans — never secrets, filesystem paths, or credential-store methods.

A settings service shows both `use()` modes on one token: a provider plugin's session facet reads `defaultModel` at activation through synchronous local `use()` under `BACKGROUND_CONTEXT`; a theme plugin's TUI facet writes through the async proxy with its command context. If some settings must not be remotely writable, split them: a local full service plus a narrower remote preferences façade. Do not rely on presentation-side convention.

## Replicated state: `RemoteState`

`ModelsService.state` above is a `RemoteState<ModelsState>`. This is **authoritative latest-value replication**, nothing more: it is not event history, durable storage, a CRDT, or a multi-writer synchronization mechanism.

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
2. The initial connection snapshot includes all exposed state values atomically, and updates emitted while the snapshot installs are buffered — so a client observes snapshot-then-updates with no gap. (The wire mechanics live in `rpc.md`.)
3. After readiness, client `.value` is synchronously readable and `subscribe()` immediately reports the current value, then future updates. The immediate callback runs under a defined **hydration context** — fresh, parented to the subscription/hydration operation — because the write that produced the value may be long settled.
4. Values are detached with structured JSON semantics, so one listener cannot mutate another's state.
5. Reconnect replaces client state from a fresh authoritative snapshot; disconnect retains the last value as stale display data alongside a disconnected connection state.
6. `set(value, context)` carries source trace metadata, and each subsequent delivery invokes listeners with a reconstructed delivery `Context` carrying it — the same reconstruction event delivery uses. Background updates use an intentional background or lifecycle context, never a retained old caller context.

The running example combines catalogue, selected configuration, and refresh status into one `ModelsState` for brevity. Production may split them into coarse independent cells so a refresh replaces the catalogue without retransmitting unrelated configuration, while the picker rerenders from whichever cell changed. Prefer several coarse cells over a universal patch language. Large, infrequently changing catalogues may use compressed replacement. High-frequency data such as transcript or token streaming should use semantic deltas followed by a final authoritative replacement, not repeated whole-transcript snapshots. Production transport should add epoch/revision metadata, gap recovery, unchanged-value suppression, and demand-driven per-service subscription; those are protocol concerns, not plugin-author concerns.

## Contribution registries: many contributors, one result

Services fit one owner and many consumers. Providers and tools invert that: **many plugins contribute to one host-owned result**. Handing every plugin a mutable global registry would make composition order-dependent and removal impossible. Instead, a contribution registry replays ordered contributions over a fresh draft:

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
});

sessionContext.tools.add((draft) => {
	draft.wrap("bash", (next) => async (invocation) => {
		await authorize(invocation);
		return next(invocation);
	});
});
```

Ordered wrappers compose deterministically — `telemetry(permission(sandbox(coreBash)))` — and if the permission plugin disappears, rebuilding yields `telemetry(sandbox(coreBash))`. No wrapper is double-applied, and no plugin has to know how to unwrap another.

Only the host finalizes the draft and applies the complete registry to the Harness. Plugins never call whole-registry setters such as `AgentHarness.setTools()`. Contributions configure rebuilt behavior; hooks intercept live operations — they are separate mechanisms. A generic replay-fold utility may be shared, but provider/tool draft semantics, duplicate policy, validation, and rebuild triggers remain coding-agent policy.

## Context, cancellation, and telemetry for plugin authors

`rpc.md` and `telemetry.md` own the mechanisms: trace carriers, request frames, cancel messages, server context reconstruction. What a plugin author needs to know:

- Every remote method receives a `Context` in its declared position. The proxy strips it from the JSON arguments and uses it to parent `rpc.client`, inject the trace carrier, and map `context.abortSignal` to request cancellation.
- The server never deserializes the client's context. It constructs a fresh one: a request-local abort signal, a telemetry parent extracted from the trace carrier, and server-created typed values such as the authenticated client ID. Clients cannot smuggle context values across; a presence service reads `context.value(CLIENT_ID)` that transport policy installed server-side.
- No receiver-level defaults: shared service objects never retain a caller's context.

The model refresh shows the whole author-visible surface. Client side:

```ts
const controller = new AbortController();
await uiTelemetry.startSpan({ name: "ui.models.refresh" }, async (span) => {
	const context = withAbortSignal(controller.signal, withTelemetryContext(span, BACKGROUND_CONTEXT));
	await models.refresh(context);
});
```

Session side, the implementation may open its own span and derive the context for lower work:

```ts
async refresh(context) {
	return context.telemetryContext.startSpan({ name: "plugin.models.refresh" }, async (span) => {
		const refreshContext = withTelemetryContext(span, context);
		// ... provider refresh under refreshContext ...
	});
}
```

The resulting distributed trace:

```text
ui.models.refresh
└─ rpc.client models.refresh
   └─ rpc.server models.refresh
      └─ plugin.models.refresh
```

Calling `controller.abort()` cancels only that one request: the server's reconstructed `context.abortSignal` aborts, and no other caller is affected.

Three cancellation domains must never blur:

1. **Invocation cancellation** aborts one remote call or wait — the `controller.abort()` above.
2. **Service-owned cancellation** is an explicit method such as `job.cancel()` that stops a service-owned task.
3. **Durable Harness cancellation** — `requestAbort()`/`abort()` — writes durable `cancel_requested` and drives durable settlement.

A transport disconnect performs only the first for active requests and closes that client's subscriptions. It must not silently cancel service-owned work or write durable cancellation. Work intended to outlive its initiating request must deliberately detach into a service-owned task with its own controller and telemetry root, which brings us to jobs and events.

## Events

A remotely exposed event source is a projection of host-local events, not a remotely invoked callback. A Git plugin exposes repository state plus a change stream:

```ts
interface GitService {
	readonly status: RemoteState<GitStatus>;
	readonly events: RemoteEvents<GitEvent>;   // { type: "status_changed" | "head_changed" }
	refresh(context: Context): Promise<void>;
}
const Git = defineRemoteService<GitService>("git", { state: ["status"], events: ["events"] });
```

Server-side, `events` is an ordinary host-local event source; the exposure adapter subscribes once per remote subscription and forwards frames. `on(type, listener)` filters by discriminator; `subscribe(listener)` observes every event. Client-side, `events` is a local façade whose listeners run in the client process — callback functions never cross the wire:

```ts
git.status.subscribe((status) => renderGitStatus(status));
git.events.on("status_changed", (_event, context) => {
	void context.telemetryContext.startSpan({ name: "ui.git.status_changed" }, () => refreshView());
});
```

Each event carries source trace metadata from the providing host's context that caused it, so client-side handling stays correlated with the originating operation. The adapter owns subscribe/unsubscribe frames, sequencing, buffering, flow control, and disconnect cleanup (`rpc.md`). Critical resumable streams need stable event IDs and a replay policy; passive UI invalidation can instead re-hydrate from a fresh state snapshot after reconnect.

## Service-owned jobs

Long-running work should return a capability rather than one method that blocks indefinitely. A background indexing service:

```ts
interface IndexJob {
	readonly progress: RemoteState<IndexProgress>;
	wait(context: Context): Promise<IndexProgress>;
	cancel(context: Context): Promise<void>;
}

interface IndexService {
	start(root: string, context: Context): Promise<IndexJob>;
}
const Index = defineRemoteService<IndexService>("index", {
	results: { start: remote(IndexJobExposure) },
});
```

Session-side, `start()` validates the root, creates its own `AbortController` and a detached telemetry root for the task, and returns the job. The returned job crosses the wire as a remote object reference (`rpc.md`).

The job makes the cancellation domains concrete: aborting one client's `wait(context)` cancels only that client's wait; calling `job.cancel()` cancels the job itself, for everyone. This mirrors the invocation-versus-service-owned distinction above. The exposure registry must release completed job references under an explicit lifetime policy.

## Chained hosts: the session directory end-to-end

Host and client are connection roles, and one process routinely plays both. The session process is the service host for its attached presentations and an RPC client of the coordinator — the separate server process that manages session processes and owns the `SessionRepo`. The session-directory plugin makes the chain concrete: a session picker in the TUI, backed by fleet state that only the coordinator has.

```text
session-directory-plugin/
  contract.ts       upstream and downstream DTOs and service tokens
  coordinator.ts    scoped SessionRepo/process-manager authority
  session.ts        upstream consumer + narrowed downstream facade
  tui.ts            session picker
  index.ts          feature bundle
```

### Shared contract: two deliberately different surfaces

The upstream directory is the coordinator's full contract. The downstream picker is the facade the session host offers its presentations — narrower on purpose:

```ts
// upstream: provided by the coordinator host, consumed by session hosts
export interface SessionRecordSummary {
	sessionId: string;
	title: string;
	workspaceId: string;
	ownerId: string;
	cwd: string;
	status: "starting" | "active" | "idle" | "closed";
	updatedAt: string;
}

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionRecordSummary[];
}

export type SessionDirectoryEvent =
	| { type: "created"; session: SessionRecordSummary }
	| { type: "changed"; session: SessionRecordSummary }
	| { type: "deleted"; sessionId: string };

export interface SessionDirectoryService {
	readonly state: RemoteState<SessionDirectoryState>;
	readonly events: RemoteEvents<SessionDirectoryEvent>;
	create(options: { title: string; workspaceId: string }, context: Context): Promise<SessionRecordSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
}

export const SessionDirectory = defineRemoteService<SessionDirectoryService>("session-directory", {
	state: ["state"],
	events: ["events"],
});

// downstream: provided by the session host, consumed by presentations
export interface SessionPickerEntry {
	sessionId: string;
	title: string;
	status: SessionRecordSummary["status"];
	updatedAt: string;
	isCurrent: boolean;
}

export interface SessionPickerState {
	revision: number;
	sessions: SessionPickerEntry[];
}

export type SessionPickerEvent =
	| { type: "created"; session: SessionPickerEntry }
	| { type: "changed"; session: SessionPickerEntry }
	| { type: "deleted"; sessionId: string };

export interface SessionPickerService {
	readonly state: RemoteState<SessionPickerState>;
	readonly events: RemoteEvents<SessionPickerEvent>;
	create(options: { title: string }, context: Context): Promise<SessionPickerEntry>;
	remove(sessionId: string, context: Context): Promise<void>;
}

export const SessionPicker = defineRemoteService<SessionPickerService>("session-picker", {
	state: ["state"],
	events: ["events"],
});
```

`ownerId`, `cwd`, and `workspaceId` exist only in the upstream contract. They may cross from coordinator to session host; they never reach a presentation host.

### Coordinator facet: own the authoritative directory

The coordinator host follows the same pattern as the session host — the kernel stays domain-blind, and the host context grants scoped local fleet authority plus the familiar service/state infrastructure:

```ts
interface CodingAgentCoordinatorPluginContext extends PluginLifecycleScope {
	// scoped local fleet authority
	readonly fleet: FleetPluginScope; // scoped SessionRepo and process-manager views

	// plus the same coordinator-host-owned provide/use/remoteState/remoteEvents
	// and connection callbacks as the session host context
}
```

The reserved list mirrors the session host: the raw `SessionRepo`, storage handles, and unrestricted process-kill authority stay with the coordinator application; `fleet` exposes narrowed, scope-owned views.

```ts
// coordinator.ts
export function sessionDirectoryCoordinatorFacet(pluginContext: CodingAgentCoordinatorPluginContext) {
	const records = pluginContext.fleet.records;     // scoped SessionRepo view
	const processes = pluginContext.fleet.processes; // scoped process-manager view

	const state = pluginContext.remoteState<SessionDirectoryState>({ revision: 0, sessions: [] });
	const events = pluginContext.remoteEvents<SessionDirectoryEvent>();

	function apply(sessions: SessionRecordSummary[], event: SessionDirectoryEvent, context: Context) {
		state.set({ revision: state.value.revision + 1, sessions }, context);
		events.emit(event, context);
	}

	pluginContext.provide(SessionDirectory, {
		state,
		events,
		async create(options, context) {
			// authorize against the calling session identity that coordinator
			// transport policy installed server-locally; never trust arguments
			const caller = requireSessionIdentity(context);
			if (options.workspaceId !== caller.workspaceId) {
				throw new RemoteServiceError("not_authorized", "Cannot create outside the caller's workspace");
			}
			const record = await records.create(options, context);
			await processes.start(record.sessionId, context);
			const session = toSummary(record);
			apply([...state.value.sessions, session], { type: "created", session }, context);
			return session;
		},
		async remove(sessionId, context) {
			const caller = requireSessionIdentity(context);
			const target = state.value.sessions.find((s) => s.sessionId === sessionId);
			if (target === undefined || target.workspaceId !== caller.workspaceId) {
				throw new RemoteServiceError("not_authorized", `Not removable: ${sessionId}`);
			}
			await processes.stop(sessionId, context);
			await records.remove(sessionId, context);
			apply(
				state.value.sessions.filter((s) => s.sessionId !== sessionId),
				{ type: "deleted", sessionId },
				context,
			);
		},
	});

	pluginContext.own(
		processes.onStatusChanged((record, context) => {
			const session = toSummary(record);
			apply(
				state.value.sessions.map((s) => (s.sessionId === session.sessionId ? session : s)),
				{ type: "changed", session },
				context,
			);
		}),
	);

	pluginContext.onActivate(async () => {
		const existing = await records.list(BACKGROUND_CONTEXT);
		state.set({ revision: 1, sessions: existing.map(toSummary) }, BACKGROUND_CONTEXT);
	});
}
```

Direct scoped capability, authoritative `RemoteState`, semantic events — the session-facet pattern one level up, plus one rule: **the coordinator authorizes every call against the session identity its transport policy installed in the server-local context** (`requireSessionIdentity(context)` reads a typed value, like `CLIENT_ID` earlier). Downstream projection in the session facade is redaction and defense in depth, never the sole authorization boundary; a compromised session process still cannot touch another workspace's sessions. Whether the coordinator additionally projects its replicated state per connection — so a session host only ever receives its own workspace's records — is an open protocol decision; methods are authorized either way.

### Session facet: upstream consumer, downstream facade

The session context's `upstream` grants remote `use()` over the session process's one connection to the coordinator:

```ts
interface SessionUpstream {
	use<T>(service: RemoteService<T>): Promise<T>;
	readonly connection: RemoteState<ConnectionState>;
}
```

`upstream.use()` hydrates the upstream state replica before resolving, like presentation-host `use()`. The facet then projects that replica into its own downstream service:

```ts
// session.ts
export async function sessionDirectorySessionFacet(pluginContext: CodingAgentSessionPluginContext) {
	const self = pluginContext.agent.identity; // sessionId + workspaceId
	const directory = await pluginContext.upstream.use(SessionDirectory);

	const state = pluginContext.remoteState<SessionPickerState>({ revision: 0, sessions: [] });
	const events = pluginContext.remoteEvents<SessionPickerEvent>();

	// Downstream state derives from upstream *state* deliveries. The immediate
	// hydration callback populates it; each later delivery re-projects under the
	// reconstructed context of the upstream set().
	pluginContext.own(
		directory.state.subscribe((next, context) => {
			state.set(project(next, self), context);
		}),
	);

	// Semantic events forward independently under their own event context. Never
	// read directory.state.value inside an event callback: state and event
	// streams are separately sequenced and can race.
	pluginContext.own(
		directory.events.subscribe((event, context) => {
			const projected = projectEvent(event, self);
			if (projected !== null) events.emit(projected, context);
		}),
	);

	pluginContext.provide(SessionPicker, {
		state,
		events,
		async create(options, context) {
			const created = await directory.create(
				{ title: options.title, workspaceId: self.workspaceId },
				context, // the session's reconstructed local context, not the TUI's
			);
			return toEntry(created, self);
		},
		async remove(sessionId, context) {
			if (!state.value.sessions.some((s) => s.sessionId === sessionId)) {
				throw new RemoteServiceError("unknown_session", `Not visible: ${sessionId}`);
			}
			await directory.remove(sessionId, context);
		},
	});
}

function project(upstream: SessionDirectoryState, self: SessionIdentity): SessionPickerState {
	return {
		revision: upstream.revision,
		sessions: upstream.sessions
			.filter((session) => session.workspaceId === self.workspaceId) // visibility (defense in depth)
			.map((session) => toEntry(session, self)),                     // redaction
	};
}

function toEntry(session: SessionRecordSummary, self: SessionIdentity): SessionPickerEntry {
	const { sessionId, title, status, updatedAt } = session; // ownerId and cwd stop here
	return { sessionId, title, status, updatedAt, isCurrent: sessionId === self.sessionId };
}
```

This is projection, not tunneling. Blindly forwarding the upstream proxy or replaying upstream frames onto presentation connections would be wrong on every axis:

- **Redaction and defense in depth.** The upstream snapshot contains other sessions' `ownerId` and `cwd`. The facade decides what its attached presentations may see and strips fields before anything reaches a presentation connection — while the coordinator stays the authorization boundary for mutations.
- **Reference and subscription isolation.** Upstream remote references and subscription IDs are scoped to the session↔coordinator connection and mean nothing on a presentation connection. The facade holds exactly one upstream subscription and fans out to any number of downstream subscriptions.
- **Independent disconnects.** The two connections fail separately. If the coordinator connection drops, presentation connections stay healthy: the facade keeps serving the last projected state as stale data, may surface upstream health in its own state, and fails downstream `create`/`remove` with a stable error code. If a presentation disconnects, the upstream subscription is untouched.
- **Hydration.** A presentation that connects late gets a complete downstream snapshot re-projected from the facade's current upstream replica, regardless of when the session host itself hydrated.
- **Contract stability.** The upstream contract can grow fields without breaking presentation code; the facade absorbs the change.

### TUI facet: the picker

```ts
// tui.ts
export async function sessionPickerTuiFacet(pluginContext: CodingAgentTuiPluginContext) {
	const picker = await pluginContext.use(SessionPicker);

	pluginContext.commands.register("sessions.list", async (context) => {
		const entries = picker.state.value.sessions;
		await pluginContext.ui.select(
			"Sessions",
			entries.map((e) => `${e.isCurrent ? "* " : "  "}${e.title} (${e.status})`),
			{ signal: context.abortSignal },
		);
	});

	picker.state.subscribe((next) => renderSessionList(next));
}
```

The TUI facet knows nothing about the coordinator. It consumes `SessionPicker` exactly the way it consumes `Models`; a web facet consumes the same token with browser UI.

### Trace and cancellation across two hops

```text
ui.sessions.create                               (TUI process)
└─ rpc.client session-picker.create              (TUI → session)
   └─ rpc.server session-picker.create           (session host: fresh local Context)
      └─ rpc.client session-directory.create     (session → coordinator)
         └─ rpc.server session-directory.create  (coordinator host: fresh local Context)
            └─ coordinator.sessions.create       (SessionRepo write + process start)
```

Each hop reconstructs a local `Context` — a request-scoped abort controller plus a telemetry parent extracted from the trace carrier — and no `Context` object ever crosses the wire. What chains the hops is that the session facade passes its reconstructed local context to the upstream proxy: aborting the TUI request cancels the TUI→session request, which aborts the session's local context, which cancels the session→coordinator request, which aborts the coordinator's local context. State updates and events flow back down the chain carrying source trace metadata at every hop.

## Reverse interactions: the question plugin end-to-end

Some session-side work must ask a connected presentation host for a decision. The existing `examples/extensions/question.ts` demonstrates the user experience: the model calls a `question` tool, the user selects an option or types a custom answer, and the tool returns that answer to the model with a compact custom rendering.

In the facet architecture, tool execution stays in the session host and the dialog stays in a presentation host. The bridge is a typed semantic interaction, not a serialized callback or component.

### Shared contract

The shared file contains only JSON-safe tool and interaction data:

```ts
interface QuestionOption {
	label: string;
	description: string | null;
}

interface QuestionRequest {
	question: string;
	options: QuestionOption[];
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

`defineInteraction()` is a typed token much like a service token. The session interaction broker routes one request to an eligible connected handler and returns its response:

```ts
interface SessionInteractions {
	request<Request extends JsonValue, Response extends JsonValue>(
		interaction: Interaction<Request, Response>,
		request: Request,
		context: Context,
	): Promise<Response>;
}

interface PresentationInteractions {
	handle<Request extends JsonValue, Response extends JsonValue>(
		interaction: Interaction<Request, Response>,
		handler: (request: Request, context: Context) => Promise<Response>,
	): () => void;
}
```

The broker owns request IDs, eligible-client selection, cancellation, disconnect handling, and response validation. The definition contains no TUI concepts.

### Session facet: contribute the tool

The session facet contributes an ordinary model-callable tool. The illustrative tool contribution API adapts this execution function to the final `AgentHarnessTool` contract:

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
				if (params.options.length === 0) {
					return questionResult(params, null, false, "No options provided");
				}

				const response = await pluginContext.interactions.request(
					QuestionInteraction,
					params,
					context,
				);

				if (response.outcome === "cancelled") {
					return questionResult(params, null, false, "User cancelled the question");
				}

				if (response.outcome === "custom") {
					return questionResult(params, response.answer, true, `User wrote: ${response.answer}`);
				}

				const selected = params.options[response.index];
				if (selected === undefined) throw new Error("Question response selected an invalid option");
				return questionResult(
					params,
					selected.label,
					false,
					`User selected: ${response.index + 1}. ${selected.label}`,
				);
			},
		});
	});
}

function questionResult(
	request: QuestionRequest,
	answer: string | null,
	wasCustom: boolean,
	text: string,
): AgentToolResult<QuestionDetails> {
	return {
		content: [{ type: "text", text }],
		details: {
			question: request.question,
			options: request.options.map((option) => option.label),
			answer,
			wasCustom,
		},
	};
}
```

The session facet knows that an answer is required for tool execution, but knows nothing about terminal keys, dialogs, overlays, or rendering. It receives only the semantic `QuestionResponse`.

### TUI facet: present the dialog, contribute the renderer

The TUI facet registers the handler that presents the question. This compact version uses the TUI host's select and input dialogs; a richer version may substitute the inline editor component from `examples/extensions/question.ts` without changing the shared contract or the session facet.

```ts
// tui.ts
export function questionTuiFacet(pluginContext: CodingAgentTuiPluginContext) {
	pluginContext.interactions.handle(QuestionInteraction, async (request, context) => {
		const choices = [
			...request.options.map((option, index) =>
				`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
			),
			"Type something…",
		];

		const choice = await pluginContext.ui.select(request.question, choices, {
			signal: context.abortSignal,
		});
		if (choice === undefined) return { outcome: "cancelled" };

		const selectedIndex = choices.indexOf(choice);
		if (selectedIndex < request.options.length) {
			return { outcome: "selected", index: selectedIndex };
		}

		const answer = await pluginContext.ui.input("Your answer", "Type something…", {
			signal: context.abortSignal,
		});
		return answer?.trim()
			? { outcome: "custom", answer: answer.trim() }
			: { outcome: "cancelled" };
	});

	pluginContext.toolRenderers.add<QuestionDetails>("question", {
		renderCall(args, theme) {
			const options = args.options.map((o: QuestionOption, i: number) => `${i + 1}. ${o.label}`).join(", ");
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

### Loopback bundle and future facets

`index.ts` assembles the loopback bundle for single-process embedding; multi-process hosts resolve the `./session` or `./tui` entry points directly and never load the other modules:

```ts
export const questionPlugin = definePlugin({
	id: "@pi/question",
	session: questionSessionFacet,
	tui: questionTuiFacet,
	// web: questionWebFacet, once a web host exists
});
```

The runtime flow matches the bird's-eye trace: the broker picks a connected presentation host with a question handler, validates the JSON response, and the session facet builds the durable tool result. No UI component or callback crosses the process boundary. A future web facet completes the example without touching session code:

```ts
// web.ts
export function questionWebFacet(pluginContext: CodingAgentWebPluginContext) {
	pluginContext.interactions.handle(QuestionInteraction, async (request, context) => {
		const response = await showQuestionModal(request, { signal: context.abortSignal });
		return response ?? { outcome: "cancelled" };
	});
	pluginContext.views.addToolView("question", QuestionToolView);
}
```

The contract, broker, and session facet are unchanged; only presentation differs per host. An IDE host can use a native quick-pick; a headless host may decline the interaction.

The same mechanism covers other reverse interactions:

- a dangerous Bash hook requests `ConfirmInteraction`; disconnect, timeout, no eligible client, or malformed response denies the tool **fail closed**;
- an OAuth plugin sends an authorization URL and asks for a returned code through an OAuth-specific interaction;
- editor and question plugins exchange semantic text, selections, or cancellation rather than component trees.

Secrets need an explicitly sensitive interaction contract. Secret responses must never enter replicated state, logs, events, or telemetry attributes.

## Lifecycle and disposal

Every facet-owned resource — service registrations, contributions, state subscriptions, watchers, timers, in-flight RPCs, subprocesses, screens, overlays — is owned by the facet's kernel scope in its host and disposed when that scope closes. Scopes dispose in reverse manifest order. The scoped capabilities in `AgentPluginScope` enforce this automatically for hooks and event subscriptions; `onDispose` handles the rest (aborting a facet's session-lifetime `AbortController`, stopping watchers, closing subprocesses).

Removing a plugin therefore has two effects in every host that loaded one of its facets: the facet's scope disposes, and any contribution registries it touched rebuild without it. Neither requires the plugin to undo anything by hand.

## Connection loss, errors, and security

Connection behavior, from the plugin author's perspective:

- A client disconnect aborts that client's active RPC requests and removes its subscriptions. The session stays alive per application policy.
- The client keeps its last replicated state as stale display data and observes the disconnected connection state; facets should disable commands that require an authoritative session while disconnected.
- A new connection hydrates from a fresh, complete authoritative snapshot. Remote object references from the old connection are invalid unless the exposure explicitly has session-stable identity and the client reacquires them.
- **Never blindly replay a mutation after an uncertain disconnect.** The session may have applied it before the response was lost — a replayed `select()` is harmless, a replayed `prompt()` is not. Reconnect, hydrate, and reconcile, or design the operation around a stable operation ID with explicit lookup semantics.

Errors cross the wire as a JSON envelope with stable codes:

```ts
interface RemoteError {
	code: string;
	message: string;
	data?: JsonValue;
}
```

Expected service errors use stable codes or result values; unexpected exceptions become an internal error with safe metadata. Stacks and sensitive causes are not sent by default. Cancellation, disconnect, unknown service/method, invalid arguments/results, and stale references need distinct codes.

Security rules every providing host's application (session and coordinator alike) must enforce:

- remote service IDs and members are allowlisted by trusted manifests or exposure descriptors; local services are never discoverable remotely;
- business arguments, results, state, and events are validated as JSON-compatible, and protocol envelopes cannot be forged as ordinary values;
- clients cannot choose context position, server typed values, telemetry parents, or cancellation targets other than their own request IDs;
- credentials, provider headers, prompts, completions, tool arguments/results, and filesystem contents are not exposed unless an explicit contract permits them; state snapshots contain only client-safe data;
- remote methods perform authorization server-side even when the TypeScript client surface hides them.

## The coding agent as a plugin manifest

Putting it together: the coding agent is one manifest of built-in and third-party plugins. Each app host loads its facets through the same kernel, in deterministic order.

Expected coordinator facets:

- session record (`SessionRepo`) and directory authority;
- session process spawn/attach/stop policy and health reporting;
- fleet-level authentication and client authorization.

Expected session facets:

- durable session creation/restoration and the scoped façade over the real Harness;
- provider contributions, model catalogues, model selection authority, and authentication;
- tool contributions, wrappers, permissions, and execution support;
- prompt, steer, follow-up, abort, compaction, and navigation services;
- transcript/custom-entry persistence and semantic event projection;
- filesystem, subprocess, terminal, and watcher effects;
- permission, question, editor, secret, and OAuth interaction requests;
- session lifecycle and unattended-session policy;
- upstream coordinator consumption and downstream facades such as the session picker.

Expected TUI facets:

- chat screen, transcript rendering, editor, and prompt input;
- slash commands, autocomplete, and keybindings;
- model picker and thinking-level controls;
- tool, message, and custom-entry renderers;
- screens, typed slots, dialogs, overlays, and interaction presentation;
- themes, focus, notifications, animation, and terminal-specific components.

A web host carries analogous browser facets: routes, views, DOM dialogs, and web renderers.

Shared contracts:

- service tokens and JSON-safe DTOs;
- RPC method signatures, latest-value state, and semantic event types;
- semantic interaction request/response types;
- screen/slot tokens used only for presentation-local composition;
- stable renderer discriminators and portable structured errors.

The generic kernel knows none of these domain concepts; each app host knows only its own.

## Open decisions

Before this becomes normative:

- the exact minimal kernel contract (scope shape, phase ordering, failure policy) and the built-in plugin manifest;
- the concrete coordinator, session, and TUI host context surfaces, and how much shape contexts share by convention;
- the logical-manifest format, per-host entry-point resolution (export conditions versus descriptor fields), and cross-process version pinning;
- whether the coordinator projects replicated state per connection (workspace-scoped snapshots) or relies on method authorization plus session-side redaction;
- upstream infrastructure: whether a standalone deployment runs a loopback in-process coordinator host or an absent `upstream`, and how facades must degrade in the latter case;
- staleness signaling and stable error codes for chained facades while the upstream connection is down;
- the coding-agent scoped Harness façade exposed to session plugins;
- contribution APIs for providers, tools, renderers, screens, and typed slots, and the boundary between a generic replay-registry utility and coding-agent draft semantics;
- the exact `RemoteService`/exposure-descriptor API and whether method manifests are explicit, generated, or discovered from trusted implementations;
- the context-position and JSON-safe optional-argument policy from `rpc.md`;
- whether `RemoteState` is generic RPC infrastructure or session-host infrastructure, and snapshot granularity (all services per connection versus independently subscribable groups), plus the exact hydration/delivery-context semantics for state subscriptions;
- state/event flow control and replay policy; object-reference scope and garbage collection;
- the stable error envelope and expected-error registration;
- plugin activation/disposal ordering, optional dependencies, and demand-subscription/shared-proxy lifetime;
- reverse-interaction routing and eligible-client policy;
- plugin/service protocol version negotiation and client authorization;
- package boundaries between the generic kernel, agent plugin contracts, generic protocol machinery, and coding-agent host integration.

## Testing strategy

The handoff should include a reusable two-transport test matrix (loopback plus a real framed transport) covering:

- **Composition:** the coding-agent hosts start from one plugin manifest, not hard-coded features; per-host entry-point resolution from one logical manifest, with no session modules reachable in a presentation bundle; provide/demand-resolve round trip; shared proxy/replica across concurrent consumers; local services unreachable from presentation hosts; duplicate/missing service failures; activation only after registration; reverse-order disposal.
- **RPC and context:** JSON call and `void` result; invalid argument/result and unknown service/member rejection; client span → `rpc.client` → `rpc.server` → service span; per-call cancellation isolation; disconnect aborts active calls; no callback, context, signal, telemetry object, or secret in wire JSON.
- **State and events:** snapshot plus concurrent update with no gap; update ordering and detached values; reconnect replaces stale state; subscribe/unsubscribe and disconnect cleanup; state and event deliveries carry reconstructed source contexts to client listeners; immediate snapshot callbacks run under the defined hydration context.
- **Registries:** ordered provider contributions rebuild deterministically; tool wrappers compose once and rebuild correctly after removal.
- **Chaining:** downstream snapshots and events contain no upstream-only fields; one upstream subscription fans out to N downstream subscriptions; upstream disconnect leaves presentation connections healthy, serves stale projected state, and fails downstream mutations with stable codes; downstream disconnect leaves the upstream subscription intact; downstream state derives from upstream state deliveries with no state/event race; the coordinator rejects cross-workspace calls even from a misbehaving session host; two-hop cancellation (TUI abort cancels the session→coordinator request) and two-hop trace parentage.
- **Boundaries:** scoped agent and fleet capabilities cannot reach host ownership or whole-registry mutation; raw Harness/Session/SessionRepo capabilities unreachable from downstream connections; job `wait` cancellation distinct from `job.cancel()`; stale/closed reference rejection; reverse-interaction success, timeout, disconnect, and fail-closed permission behavior; invocation cancellation writes no durable cancellation state.
