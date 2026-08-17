# Session and Client Plugins

> **Status:** Tentative design input, not a normative contract or implementation handoff. The examples use illustrative APIs that do not exist yet. Reconcile this design with `rpc.md`, `telemetry.md`, and the final harness contract before adding it to `harness.md` or creating a work package.

This document assumes you already understand `AgentHarness`, `AgentLane`, `Session`, `SessionTree`, invocation `Context`, telemetry, and the generic RPC design at a conceptual level. Read `rpc.md` for wire frames, remote references, subscriptions, and trace carriers, and `telemetry.md` for context propagation and cancellation semantics. This document does not reteach those mechanisms. What it teaches is the plugin architecture built on top of them.

## Why plugins

The new coding agent is not a monolithic application with an extension API bolted on. It is two minimal kernels plus an ordered list of plugins:

- The **session kernel** owns the durable session, the concrete `AgentHarness`/`Session`, plugin lifecycle, service hosting, RPC execution, and connection lifecycle.
- The **client kernel** owns the transport connection, snapshot hydration, replicated state cells, typed service proxies, pending-call cancellation, and client plugin lifecycle.

Both kernels own *mechanisms only*. Everything a user would recognize as "the coding agent" — providers, model selection, authentication, chat, core tools, permissions, renderers, the model picker — is a plugin. Built-ins use exactly the same plugin APIs as packaged third-party extensions. There is no privileged built-in feature path, no hard-coded model picker in the client kernel, and no provider policy in the session kernel.

The process model:

```text
┌──────────────── client process ────────────────┐
│ minimal client kernel                          │
│ client plugins: commands, views, renderers     │
│ typed service proxies + replicated snapshots   │
└──────────────────────┬─────────────────────────┘
                       │ one multiplexed connection
                       │ RPC, cancellation, state, events, interactions
┌──────────────────────▼─────────────────────────┐
│ session process                                │
│ minimal session kernel                         │
│ session plugins: providers, tools, policy      │
│ Harness, Session, credentials, services        │
└────────────────────────────────────────────────┘
```

One process owns one session, and session authority never migrates into clients. All traffic between the halves flows over one multiplexed connection; plugins do not open private sockets. A loopback application that runs both halves in one process preserves the same boundary, cancellation behavior, and serialization rules, so plugin behavior is independent of deployment topology. A client disconnect does not imply that the session exits; the application decides whether an unattended session stays alive, exits, or times out.

Plugin authors write ordinary typed service implementations. They never implement request IDs, sockets, serialization, cancellation messages, trace carriers, remote-reference registries, or reconnect buffering — the generic RPC layer owns all of that.

The prototype in `packages/coding-agent/test/fixtures/plugin-app/` demonstrates this two-sided author model end to end. The shared RPC design in `rpc.md` should replace its ad hoc RPC infrastructure without replacing the plugin composition model.

Out of scope for this design: arbitrary object remoting, serialized functions/classes/`Map`/`Set`, remote hook or tool execution, offline client writes or conflict resolution, automatic mutation replay after reconnect, a universal cross-process command/action registry, and a universal remote `AgentHarness` or serialized UI tree available to every plugin.

## A plugin has two halves

A plugin can contribute behavior to the session process, to the client process, or both:

```ts
interface Plugin<SessionPluginContext, ClientPluginContext> {
	readonly id: string;
	session?(context: SessionPluginContext): void | Promise<void>;
	client?(context: ClientPluginContext): void | Promise<void>;
}
```

One-sided plugins are normal. A plugin that rewrites the model catalogue from `models.json` has only a `session` half and no UI. A theme or keybinding plugin has only a `client` half and no session behavior. A chat plugin has both: the session half owns agent authority and projects semantic state; the client half owns prompt input and transcript rendering.

A two-sided plugin separates its shared contract from process-specific code so browser/client bundles never import Node-only session dependencies:

```text
my-plugin/
  contract.ts       JSON DTOs, service interfaces, service tokens
  session.ts        session half: providers, storage, credentials
  client.ts         client half: commands, views, actions
  index.ts          optional composition helper
```

Small plugins may export both halves from one module as long as the dependency graph remains valid in both environments. Session and client halves are packaged together and expected to use compatible shared contracts; protocol version negotiation remains an open deployment concern.

## Services connect the halves

The halves communicate through **services**. A service token is a typed identity plus trusted exposure metadata for the generic RPC layer:

```ts
function defineRemoteService<T>(id: string, exposure?: ServiceExposure<T>): RemoteService<T>;
```

The exact exposure-descriptor API belongs to `rpc.md`; these examples use `state`, `events`, and `results` only to illustrate the required capabilities.

The rest of this document uses one running example: the model service that powers the coding agent's model picker and thinking-level control.

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

### Session half

```ts
export const providersBuiltin = definePlugin({
	id: "@pi/providers-builtin",

	session(pluginContext: SessionPluginContext) {
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
				const levels: ThinkingLevel[] = ["off", "low", "high"];
				const current = state.value.configuration;
				const next = levels[(levels.indexOf(current.thinkingLevel) + 1) % levels.length] ?? "off";
				state.set({ ...state.value, configuration: { ...current, thinkingLevel: next } }, context);
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

### Client half

```ts
export const modelSelection = definePlugin({
	id: "@pi/model-selection",

	async client(pluginContext: ClientPluginContext) {
		const models = await pluginContext.use(Models);

		pluginContext.actions.register("models.select", (actionContext, model: ModelRef) =>
			models.select(model, actionContext),
		);
		pluginContext.actions.register("models.refresh", (actionContext) => models.refresh(actionContext));

		models.state.subscribe((next) => renderModelSelector(next));
	},
});
```

The client half has no provider credentials, no registry, and no refresh logic. It calls a typed proxy and renders replicated state.

### Service semantics

A service has **one owner and many consumers**. `providersBuiltin` provides `Models`; the model picker and the thinking-level control both consume it:

```ts
export const thinkingControl = definePlugin({
	id: "@pi/thinking-control",
	async client(pluginContext: ClientPluginContext) {
		const models = await pluginContext.use(Models);
		pluginContext.actions.register("thinking.cycle", (context) => models.cycleThinking(context));
	},
});
```

The two sides consume services differently, and the difference matters:

- **Session `use()` is local and synchronous.** It returns the actual implementation object in the same process. No serialization, no proxy.
- **Client `use()` is asynchronous and demand-driven.** It subscribes to the service on first demand and resolves a typed proxy. Concurrent consumers of one token share one proxy, one state replica, and one remote subscription.

Tentative lifecycle contexts:

```ts
interface SessionPluginContext {
	provide<T>(service: RemoteService<T> | LocalService<T>, implementation: T): void;
	use<T>(service: RemoteService<T> | LocalService<T>): T;
	remoteState<T extends JsonValue>(initial: T): MutableRemoteState<T>;
	onActivate(callback: () => void | Promise<void>): void;
	onClientConnect(callback: (clientId: string) => void): void;
	onClientDisconnect(callback: (clientId: string) => void): void;
	onClose(callback: () => void | Promise<void>): void;
}

interface ClientPluginContext {
	use<T>(service: RemoteService<T>): Promise<T>;
	readonly connection: RemoteState<ConnectionState>;
	readonly actions: ActionRegistry;
}
```

Registration and activation are separate phases, in deterministic manifest order:

1. session plugins register services and lifecycle callbacks;
2. all registrations become visible;
3. `onActivate` callbacks start background work (the provider rebuild above);
4. the authoritative state snapshot is exposed to clients.

This prevents one plugin from starting effects while another is still constructing a dependency. Duplicate service IDs reject during registration. Missing services and dependency cycles are trusted application-assembly errors; this design does not need a dependency-injection framework.

## What each side actually holds

This is the most important boundary in the design, so it is worth stating bluntly.

**Session plugins run beside the real thing.** They execute in the process that owns the concrete `AgentHarness`, `AgentLane`, `Session`, and `SessionTree`, and they receive direct, process-local, scoped capabilities backed by those instances — not RPC proxies. Calls preserve the real method signatures, `Context` propagation, `Result` types, and object identity. They do not serialize arguments, create remote references, or start `rpc.client`/`rpc.server` spans. A session plugin never RPCs back into its own process.

```ts
interface AgentPluginScope {
	readonly main: AgentLanePluginView;
	lane(name: string, context: Context): Promise<AgentLanePluginView | undefined>;
	readonly sessionTree: SessionTree;
	readonly hooks: ScopedHooks;
	readonly events: ScopedEvents;
}

interface CodingAgentSessionPluginContext extends SessionPluginContext {
	readonly agent: AgentPluginScope;
	readonly tools: ToolContributionRegistry;
	readonly interactions: SessionInteractions;
}

interface CodingAgentClientPluginContext extends ClientPluginContext {
	readonly interactions: ClientInteractions;
	readonly toolRenderers: ToolRendererContributions;
	readonly ui: ClientUi;
}
```

"Local" and "unrestricted" are separate decisions. The scope narrows authority for lifecycle and composition — hooks and event subscriptions registered through it are automatically owned by the plugin and disposed with it — but the `sessionTree` may be the actual local derived object. The host keeps the unrestricted concrete instances and reserves:

- `AgentHarness.close()` and `Session.close()`;
- raw `Session.mutate()` and `SessionMutator`, unless a narrowly trusted durability plugin explicitly owns them;
- `idGenerator` and backend/storage objects;
- whole-registry setters such as `setTools()`;
- unscoped hook/event registration that cannot be disposed with the plugin;
- transport exposure and remote-reference registration.

This is a composition and lifecycle boundary, not a security sandbox: session plugins are trusted code in the authoritative process. The application manifest may explicitly grant a plugin broader local capabilities when its responsibility requires them, but built-ins receive no implicit bypass and broad access is not the default contract.

**Client plugins hold none of this.** A client plugin never receives the raw `AgentHarness`, `Session`, `SessionTree`, tool registry, hooks, or credentials — not even as proxies. It receives only what its paired session plugin deliberately exposes: semantic service proxies, replicated state, and semantic events/interactions.

```text
concrete Harness / Session / SessionTree
→ direct local scoped capability in session plugin
→ plugin-defined semantic service
→ generic RPC
→ typed proxy in paired client plugin
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

Its session half implements that contract with direct local lane capabilities:

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

Its client half receives only the semantic proxy:

```ts
async client(pluginContext: ClientPluginContext) {
	const chat = await pluginContext.use(Chat);
	pluginContext.actions.register("chat.send", (context, message: AgentMessage[]) =>
		chat.prompt({ message }, context),
	);
}
```

A review plugin similarly exposes review operations. Neither reveals the Harness object that implements them, and there is no universal remote Harness available to arbitrary plugins.

`rpc.md` may still define generic Harness proxies for other trusted integrations (an IDE bridge, an orchestrator). Those are deliberate, separate exposures — not the coding-agent plugin boundary.

## Local services and narrow remote façades

Not every dependency should be remotely reachable. A **local service** is a session-process-only token:

```ts
const Providers = defineLocalService<ProviderRegistry>("providers");
```

A local service may hold functions, native objects, credentials, filesystem handles, or other non-JSON state. Client `use()` cannot resolve it because it has no remote exposure, and local services are never discoverable remotely.

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

The session-side auth plugin uses `Credentials` directly. The client sees provider IDs and `configured` booleans — never secrets, filesystem paths, or credential-store methods.

A settings service shows both consumption modes of one remote service. A session-side provider plugin restores the default model at activation with local synchronous `use()`; a client-side theme plugin writes through the async proxy:

```ts
// session half of a provider plugin
const settings = pluginContext.use(Settings);
pluginContext.onActivate(async () => {
	const model = await settings.get("defaultModel", BACKGROUND_CONTEXT);
	if (model !== null) restoreDefaultModel(model);
});

// client half of a theme plugin
const settings = await pluginContext.use(Settings);
pluginContext.actions.register("theme.select", (context, theme: string) =>
	settings.set("theme", theme, context),
);
```

If some settings must not be remotely writable, split them: a local full service plus a narrower remote preferences façade. Do not rely on client convention.

## Replicated state: `RemoteState`

`ModelsService.state` above is a `RemoteState<ModelsState>`. This is **authoritative latest-value replication**, nothing more: it is not event history, durable storage, a CRDT, or a multi-writer synchronization mechanism.

```ts
interface RemoteState<T> {
	readonly value: T;
	subscribe(listener: (value: T) => void): () => void;
}

interface MutableRemoteState<T> extends RemoteState<T> {
	set(value: T, context: Context): void;
}
```

Required behavior:

1. The session owns the one authoritative value; there are no client-side writes.
2. The initial connection snapshot includes all exposed state values atomically, and updates emitted while the snapshot installs are buffered — so a client observes snapshot-then-updates with no gap. (The wire mechanics live in `rpc.md`.)
3. After readiness, client `.value` is synchronously readable and `subscribe()` immediately reports the current value, then future updates.
4. Values are detached with structured JSON semantics, so one listener cannot mutate another's state.
5. Reconnect replaces client state from a fresh authoritative snapshot; disconnect retains the last value as stale display data alongside a disconnected connection state.
6. `set(value, context)` carries source trace metadata; background updates use an intentional background or lifecycle context, never a retained old caller context.

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

A remotely exposed event source is a projection of session-side events, not a remotely invoked callback. A Git plugin exposes repository state plus a change stream:

```ts
interface GitService {
	readonly status: RemoteState<GitStatus>;
	readonly events: RemoteEvents<GitEvent>;   // { type: "status_changed" | "head_changed" }
	refresh(context: Context): Promise<void>;
}
const Git = defineRemoteService<GitService>("git", { state: ["status"], events: ["events"] });
```

Server-side, `events` is an ordinary host-local event source; the exposure adapter subscribes once per remote subscription and forwards frames. Client-side, `events` is a local façade whose listeners run in the client process — callback functions never cross the wire:

```ts
git.status.subscribe((status) => renderGitStatus(status));
git.events.on("status_changed", (_event, context) => {
	void context.telemetryContext.startSpan({ name: "ui.git.status_changed" }, () => refreshView());
});
```

Each event carries source trace metadata from the session-side context that caused it, so client-side handling stays correlated with the originating operation. The adapter owns subscribe/unsubscribe frames, sequencing, buffering, flow control, and disconnect cleanup (`rpc.md`). Critical resumable streams need stable event IDs and a replay policy; passive UI invalidation can instead re-hydrate from a fresh state snapshot after reconnect.

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

## Reverse interactions: a complete question tool

Some session-side work must ask a connected client for a decision. The existing `examples/extensions/question.ts` demonstrates the user experience: the model calls a `question` tool, the user selects an option or types a custom answer, and the tool returns that answer to the model with a compact custom rendering.

In the split plugin architecture, tool execution remains session-side and the dialog remains client-side. The bridge is a typed semantic interaction, not a serialized callback or component.

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

`defineInteraction()` is a typed token much like a service token. The session interaction broker routes one request to an eligible client handler and returns its response:

```ts
interface SessionInteractions {
	request<Request extends JsonValue, Response extends JsonValue>(
		interaction: Interaction<Request, Response>,
		request: Request,
		context: Context,
	): Promise<Response>;
}

interface ClientInteractions {
	handle<Request extends JsonValue, Response extends JsonValue>(
		interaction: Interaction<Request, Response>,
		handler: (request: Request, context: Context) => Promise<Response>,
	): () => void;
}
```

The broker owns request IDs, eligible-client selection, cancellation, disconnect handling, and response validation. The definition contains no TUI concepts.

### Session half: contribute the tool

The session half contributes an ordinary model-callable tool. The illustrative tool contribution API adapts this execution function to the final `AgentHarnessTool` contract:

```ts
export const questionSession = definePlugin({
	id: "@pi/question-session",

	session(pluginContext: CodingAgentSessionPluginContext) {
		pluginContext.tools.add((draft) => {
			draft.set("question", {
				label: "Question",
				description: "Ask the user a question and let them select or enter an answer.",
				executionMode: "sequential",
				parameters: Type.Object({
					question: Type.String(),
					options: Type.Array(
						Type.Object({
							label: Type.String(),
							description: Type.Union([Type.String(), Type.Null()]),
						}),
					),
				}),

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
	},
});

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

The session half knows that an answer is required for tool execution, but knows nothing about terminal keys, dialogs, overlays, or rendering. It receives only the semantic `QuestionResponse`.

### Client half: contribute UI and rendering

The client half registers the handler that presents the question. This compact version uses the client's local select and input dialogs; a TUI plugin may substitute the inline editor component from `examples/extensions/question.ts` without changing the shared contract or session half.

```ts
export const questionClient = definePlugin({
	id: "@pi/question-client",

	client(pluginContext: CodingAgentClientPluginContext) {
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
				const labels = args.options.map((option: QuestionOption, index: number) =>
					`${index + 1}. ${option.label}`,
				);
				return new Text(
					theme.fg("toolTitle", theme.bold("question ")) +
						theme.fg("muted", args.question) +
						`\n${theme.fg("dim", `  Options: ${labels.join(", ")}`)}`,
					0,
					0,
				);
			},

			renderResult(result, theme) {
				if (result.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
				const prefix = result.wasCustom ? "(wrote) " : "";
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", prefix) +
						theme.fg("accent", result.answer),
					0,
					0,
				);
			},
		});
	},
});
```

The interaction flow is now concrete:

```text
model calls question tool
→ session plugin starts QuestionInteraction
→ broker selects a connected client with the question handler
→ client plugin presents local select/input UI
→ client returns selected/custom/cancelled JSON
→ session plugin builds the durable tool result
→ client plugin renders that result locally
```

No UI component or callback crosses the process boundary. A web client can register a web dialog for the same token; an IDE client can use a native quick-pick; a headless client may decline it.

The same mechanism covers other reverse interactions:

- a dangerous Bash hook requests `ConfirmInteraction`; disconnect, timeout, no eligible client, or malformed response denies the tool **fail closed**;
- an OAuth plugin sends an authorization URL and asks for a returned code through an OAuth-specific interaction;
- editor and question plugins exchange semantic text, selections, or cancellation rather than component trees.

Secrets need an explicitly sensitive interaction contract. Secret responses must never enter replicated state, logs, events, or telemetry attributes.

## Lifecycle and disposal

Every plugin-owned resource — service registrations, contributions, state subscriptions, watchers, timers, in-flight RPCs, subprocesses, screens, overlays — is owned by the plugin's scope and disposed when that scope closes. Session-owned resources dispose in reverse ownership order. The scoped capabilities in `AgentPluginScope` enforce this automatically for hooks and event subscriptions; `onClose` handles the rest (aborting a plugin's session-lifetime `AbortController`, stopping watchers, closing subprocesses).

Removing a plugin therefore has two effects: its scope disposes, and any contribution registries it touched rebuild without it. Neither requires the plugin to undo anything by hand.

## Connection loss, errors, and security

Connection behavior, from the plugin author's perspective:

- A client disconnect aborts that client's active RPC requests and removes its subscriptions. The session stays alive per application policy.
- The client keeps its last replicated state as stale display data and observes the disconnected connection state; plugins should disable actions that require an authoritative session while disconnected.
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

Security rules the session application must enforce:

- remote service IDs and members are allowlisted by trusted manifests or exposure descriptors; local services are never discoverable remotely;
- business arguments, results, state, and events are validated as JSON-compatible, and protocol envelopes cannot be forged as ordinary values;
- clients cannot choose context position, server typed values, telemetry parents, or cancellation targets other than their own request IDs;
- credentials, provider headers, prompts, completions, tool arguments/results, and filesystem contents are not exposed unless an explicit contract permits them; state snapshots contain only client-safe data;
- remote methods perform authorization server-side even when the TypeScript client surface hides them.

## The coding agent as a plugin manifest

Putting it together: the coding agent is a manifest of built-in and third-party plugins loaded by the two kernels, in deterministic order.

Expected session-side plugins:

- durable session creation/restoration and the scoped façade over the real Harness;
- provider contributions, model catalogues, model selection authority, and authentication;
- tool contributions, wrappers, permissions, and execution support;
- prompt, steer, follow-up, abort, compaction, and navigation services;
- transcript/custom-entry persistence and semantic event projection;
- filesystem, subprocess, terminal, and watcher effects;
- permission, question, editor, secret, and OAuth interaction requests;
- session lifecycle and unattended-session policy.

Expected client-side plugins:

- chat screen, transcript rendering, editor, and prompt input;
- slash commands, autocomplete, and keybindings;
- model picker and thinking-level controls;
- tool, message, and custom-entry renderers;
- screens, typed slots, dialogs, overlays, and interaction presentation;
- themes, focus, notifications, animation, and terminal/web/IDE-specific components.

Shared contracts:

- service tokens and JSON-safe DTOs;
- RPC method signatures, latest-value state, and semantic event types;
- semantic interaction request/response types;
- screen/slot tokens used only for client-local composition;
- stable renderer discriminators and portable structured errors.

The generic kernels know none of these domain concepts.

## Open decisions

Before this becomes normative:

- the exact minimal session/client kernels and the built-in plugin manifest;
- the coding-agent scoped Harness façade exposed to session plugins;
- contribution APIs for providers, tools, renderers, screens, and typed slots, and the boundary between a generic replay-registry utility and coding-agent draft semantics;
- the exact `RemoteService`/exposure-descriptor API and whether method manifests are explicit, generated, or discovered from trusted implementations;
- the context-position and JSON-safe optional-argument policy from `rpc.md`;
- whether `RemoteState` is generic RPC infrastructure or session-plugin infrastructure, and snapshot granularity (all services per connection versus independently subscribable groups);
- state/event flow control and replay policy; object-reference scope and garbage collection;
- the stable error envelope and expected-error registration;
- plugin activation/disposal ordering, optional dependencies, and demand-subscription/shared-proxy lifetime;
- reverse-interaction routing and eligible-client policy;
- plugin/service protocol version negotiation and client authorization;
- package boundaries between agent plugin contracts, generic protocol machinery, and coding-agent UI integration.

## Testing strategy

The handoff should include a reusable two-transport test matrix (loopback plus a real framed transport) covering:

- **Composition:** the coding-agent host starts from a plugin manifest, not hard-coded features; provide/demand-resolve round trip; shared proxy/replica across concurrent consumers; local services unreachable client-side; duplicate/missing service failures; activation only after registration; reverse-order disposal.
- **RPC and context:** JSON call and `void` result; invalid argument/result and unknown service/member rejection; client span → `rpc.client` → `rpc.server` → service span; per-call cancellation isolation; disconnect aborts active calls; no callback, context, signal, telemetry object, or secret in wire JSON.
- **State and events:** snapshot plus concurrent update with no gap; update ordering and detached values; reconnect replaces stale state; subscribe/unsubscribe and disconnect cleanup; event source telemetry reaching the client listener.
- **Registries:** ordered provider contributions rebuild deterministically; tool wrappers compose once and rebuild correctly after removal.
- **Boundaries:** scoped agent capabilities cannot reach host ownership or whole-registry mutation; raw Harness/Session capabilities unreachable from clients; job `wait` cancellation distinct from `job.cancel()`; stale/closed reference rejection; reverse-interaction success, timeout, disconnect, and fail-closed permission behavior; invocation cancellation writes no durable cancellation state.
