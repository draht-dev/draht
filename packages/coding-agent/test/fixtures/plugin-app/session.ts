import { type AppKeybinding, KEYBINDINGS } from "../../../src/core/keybindings.ts";
import type { AppDefinition, AppInstance, AppPlugin } from "./kernel.ts";
import type {
	ClientSnapshot,
	CodingAgentEvent,
	CodingAgentSnapshot,
	LaneConfiguration,
	ModelSpec,
	ProviderSnapshot,
	ServerWireMessage,
	SessionRequest,
	WireView,
} from "./protocol.ts";

type Contribution<D> = (draft: D, owner: string) => void;

class ReplayRegistry<D, S> {
	private readonly build: (draft: D) => S;
	private readonly contributions: Array<{ owner: string; run: Contribution<D> }> = [];
	private readonly createDraft: () => D;
	private state: S;

	constructor(createDraft: () => D, build: (draft: D) => S) {
		this.build = build;
		this.createDraft = createDraft;
		this.state = build(createDraft());
	}

	add(owner: string, run: Contribution<D>): void {
		this.contributions.push({ owner, run });
	}

	rebuild(): S {
		const draft = this.createDraft();
		for (const { owner, run } of this.contributions) run(draft, owner);
		this.state = this.build(draft);
		return this.state;
	}

	current(): S {
		return this.state;
	}
}

export interface InvocationContext {
	originatorClientId: string;
	signal: AbortSignal;
}

interface ActionDefinition {
	description: string;
	handler(context: InvocationContext): Promise<void>;
}

interface CommandDefinition {
	argumentHint?: string;
	description: string;
	handler(args: string, context: InvocationContext): Promise<void>;
}

type ViewMessageHandler = (message: unknown, fromClientId: string) => void | Promise<void>;

interface ViewRecord extends WireView {
	closed: boolean;
	handler: ViewMessageHandler | undefined;
	resolveDone(): void;
	to: readonly string[];
}

class ClientHub {
	private readonly connections = new Map<string, (message: ServerWireMessage) => void>();

	connect(clientId: string, snapshot: () => ClientSnapshot, send: (message: ServerWireMessage) => void): () => void {
		const pending: ServerWireMessage[] = [];
		let ready = false;
		const connection = (message: ServerWireMessage) => {
			if (ready) send(message);
			else pending.push(message);
		};
		this.connections.set(clientId, connection);
		send({ type: "snapshot", snapshot: structuredClone(snapshot()) });
		ready = true;
		for (const message of pending) send(message);
		return () => {
			if (this.connections.get(clientId) === connection) this.connections.delete(clientId);
		};
	}

	broadcast(message: ServerWireMessage): void {
		for (const send of this.connections.values()) send(structuredClone(message));
	}

	send(clientIds: readonly string[], message: ServerWireMessage): void {
		for (const clientId of clientIds) this.connections.get(clientId)?.(structuredClone(message));
	}
}

interface ViewController {
	close(id: string): void;
	setHandler(id: string, handler: ViewMessageHandler): void;
	update(id: string, state: unknown): void;
}

export class ViewHandle<S> {
	readonly done: Promise<void>;
	readonly id: string;
	private readonly controller: ViewController;

	constructor(id: string, done: Promise<void>, controller: ViewController) {
		this.controller = controller;
		this.done = done;
		this.id = id;
	}

	set state(state: S) {
		this.controller.update(this.id, state);
	}

	on(handler: ViewMessageHandler): void {
		this.controller.setHandler(this.id, handler);
	}

	close(): void {
		this.controller.close(this.id);
	}
}

class ViewService implements ViewController {
	private readonly hub: ClientHub;
	private readonly records = new Map<string, ViewRecord>();
	private nextId = 1;
	openedCount = 0;

	constructor(hub: ClientHub) {
		this.hub = hub;
	}

	open<S>(component: string, state: S, to: readonly string[]): ViewHandle<S> {
		const id = `view-${this.nextId++}`;
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const record: ViewRecord = {
			closed: false,
			component,
			handler: undefined,
			id,
			resolveDone,
			state: structuredClone(state),
			to: [...to],
		};
		this.records.set(id, record);
		this.openedCount++;
		this.hub.send(record.to, { type: "view_updated", view: this.toWire(record) });
		return new ViewHandle(id, done, this);
	}

	forClient(clientId: string): WireView[] {
		return [...this.records.values()]
			.filter((record) => !record.closed && record.to.includes(clientId))
			.map((record) => this.toWire(record));
	}

	async send(id: string, clientId: string, message: unknown): Promise<void> {
		const record = this.records.get(id);
		if (!record || record.closed || !record.to.includes(clientId)) return;
		await record.handler?.(structuredClone(message), clientId);
	}

	update(id: string, state: unknown): void {
		const record = this.records.get(id);
		if (!record || record.closed) return;
		record.state = structuredClone(state);
		this.hub.send(record.to, { type: "view_updated", view: this.toWire(record) });
	}

	setHandler(id: string, handler: ViewMessageHandler): void {
		const record = this.records.get(id);
		if (record && !record.closed) record.handler = handler;
	}

	close(id: string): void {
		const record = this.records.get(id);
		if (!record || record.closed) return;
		record.closed = true;
		this.hub.send(record.to, { type: "view_closed", viewId: id });
		record.resolveDone();
	}

	closeAll(): void {
		for (const id of this.records.keys()) this.close(id);
	}

	private toWire(record: ViewRecord): WireView {
		return { id: record.id, component: record.component, state: structuredClone(record.state) };
	}
}

interface ProviderEntry {
	configured: boolean;
	models: ModelSpec[];
	refreshers: Array<{ id: string; refresh(signal: AbortSignal): Promise<void> }>;
}

class ProviderDraftState {
	readonly entries = new Map<string, ProviderEntry>();

	entry(id: string): ProviderEntry {
		let entry = this.entries.get(id);
		if (!entry) {
			entry = { configured: false, models: [], refreshers: [] };
			this.entries.set(id, entry);
		}
		return entry;
	}
}

export class ProviderDraft {
	private readonly owner: string;
	private readonly state: ProviderDraftState;

	constructor(owner: string, state: ProviderDraftState) {
		this.owner = owner;
		this.state = state;
	}

	native(id: string, models: readonly ModelSpec[]): void {
		this.state.entry(id).models = models.map((model) => ({ ...model, provider: id }));
	}

	models(id: string, transform: (models: readonly ModelSpec[]) => readonly ModelSpec[]): void {
		const entry = this.state.entry(id);
		entry.models = transform(entry.models.map((model) => ({ ...model }))).map((model) => ({
			...model,
			provider: id,
		}));
	}

	configured(id: string): void {
		this.state.entry(id).configured = true;
	}

	refresh(id: string, localId: string, refresh: (signal: AbortSignal) => Promise<void>): void {
		this.state.entry(id).refreshers.push({ id: `${this.owner}:${localId}`, refresh });
	}
}

interface ProviderState {
	availableModels: readonly ModelSpec[];
	models: readonly ModelSpec[];
	refreshers: ReadonlyArray<{ id: string; refresh(signal: AbortSignal): Promise<void> }>;
}

export class ProviderRegistry {
	private readonly listeners = new Set<(snapshot: ProviderSnapshot) => void>();
	private readonly registry = new ReplayRegistry(
		() => new ProviderDraftState(),
		(draft): ProviderState => {
			const models: ModelSpec[] = [];
			const availableModels: ModelSpec[] = [];
			const refreshers: Array<{ id: string; refresh(signal: AbortSignal): Promise<void> }> = [];
			for (const entry of draft.entries.values()) {
				models.push(...entry.models.map((model) => ({ ...model })));
				if (entry.configured) availableModels.push(...entry.models.map((model) => ({ ...model })));
				refreshers.push(...entry.refreshers);
			}
			const byId = (left: ModelSpec, right: ModelSpec) =>
				`${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`);
			return { availableModels: availableModels.sort(byId), models: models.sort(byId), refreshers };
		},
	);
	private revision = 0;
	private serialized = "";

	add(owner: string, contribution: (draft: ProviderDraft) => void): void {
		this.registry.add(owner, (draft) => contribution(new ProviderDraft(owner, draft)));
	}

	rebuild(): ProviderSnapshot {
		const state = this.registry.rebuild();
		const serialized = JSON.stringify({ availableModels: state.availableModels, models: state.models });
		if (serialized !== this.serialized) {
			this.serialized = serialized;
			this.revision++;
			for (const listener of this.listeners) listener(this.snapshot());
		}
		return this.snapshot();
	}

	snapshot(): ProviderSnapshot {
		const state = this.registry.current();
		return {
			revision: this.revision,
			availableModels: state.availableModels.map((model) => ({ ...model })),
			models: state.models.map((model) => ({ ...model })),
		};
	}

	onRebuild(listener: (snapshot: ProviderSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async refresh(signal: AbortSignal): Promise<{ aborted: boolean; errors: ReadonlyMap<string, string> }> {
		signal.throwIfAborted();
		const errors = new Map<string, string>();
		await Promise.all(
			this.registry.current().refreshers.map(async ({ id, refresh }) => {
				try {
					await refresh(signal);
				} catch (error) {
					if (!signal.aborted) errors.set(id, error instanceof Error ? error.message : String(error));
				}
			}),
		);
		if (!signal.aborted) this.rebuild();
		return { aborted: signal.aborted, errors };
	}
}

export interface CodingAgentApi {
	actions: { add(contribution: (draft: Map<string, ActionDefinition>) => void): void };
	commands: { add(contribution: (draft: Map<string, CommandDefinition>) => void): void };
	providers: {
		add(contribution: (draft: ProviderDraft) => void): void;
		onRebuild(listener: (snapshot: ProviderSnapshot) => void): () => void;
		refresh(signal: AbortSignal): Promise<{ aborted: boolean; errors: ReadonlyMap<string, string> }>;
		snapshot(): ProviderSnapshot;
	};
	session: {
		configure(configuration: LaneConfiguration): Promise<void>;
		getConfiguration(): LaneConfiguration;
	};
	settings: { set(key: string, value: unknown): Promise<void> };
	view<S>(component: string, state: S, options: { to: readonly string[] }): ViewHandle<S>;
}

export interface SessionDriver {
	readonly openedViewCount: number;
	readonly trace: readonly string[];
	connect(clientId: string, send: (message: ServerWireMessage) => void): () => void;
	getConfiguration(): LaneConfiguration;
	invokeAction(clientId: string, id: AppKeybinding): Promise<void>;
	providers: ProviderRegistry;
	request(clientId: string, request: SessionRequest): Promise<void>;
	settings: ReadonlyMap<string, unknown>;
	submit(clientId: string, input: string): Promise<void>;
}

export type CodingAgentPlugin = AppPlugin<CodingAgentApi>;
export type CodingAgentApp = AppDefinition<CodingAgentApi, SessionDriver>;

export function createSessionInstance(): AppInstance<CodingAgentApi, SessionDriver> {
	const actions = new ReplayRegistry<Map<string, ActionDefinition>, ReadonlyMap<string, ActionDefinition>>(
		() => new Map(),
		(draft) => new Map(draft),
	);
	const commands = new ReplayRegistry<Map<string, CommandDefinition>, ReadonlyMap<string, CommandDefinition>>(
		() => new Map(),
		(draft) => new Map(draft),
	);
	const providers = new ProviderRegistry();
	const settings = new Map<string, unknown>();
	const trace: string[] = [];
	const activeInvocations = new Set<AbortController>();
	const hub = new ClientHub();
	const views = new ViewService(hub);
	let configuration: LaneConfiguration = { model: undefined, thinkingLevel: "high" };

	const appSnapshot = (): CodingAgentSnapshot => ({
		actions: [...actions.current()]
			.filter((entry): entry is [AppKeybinding, ActionDefinition] => Object.hasOwn(KEYBINDINGS, entry[0]))
			.map(([id, action]) => ({ id, description: action.description })),
		commands: [...commands.current()].map(([name, command]) => ({
			name,
			description: command.description,
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
		})),
		configuration: structuredClone(configuration),
		providers: providers.snapshot(),
	});
	providers.onRebuild((snapshot) =>
		hub.broadcast({ type: "event", event: { type: "providers_changed", providers: snapshot } }),
	);

	const invoke = async (clientId: string, run: (context: InvocationContext) => Promise<void>): Promise<void> => {
		const controller = new AbortController();
		activeInvocations.add(controller);
		try {
			await run({ originatorClientId: clientId, signal: controller.signal });
		} finally {
			activeInvocations.delete(controller);
		}
	};

	const submit = async (clientId: string, input: string): Promise<void> => {
		if (!input.startsWith("/")) throw new Error("Only slash commands are supported by this test app");
		const separator = input.indexOf(" ");
		const name = input.slice(1, separator < 0 ? undefined : separator);
		const args = separator < 0 ? "" : input.slice(separator + 1).trim();
		const command = commands.current().get(name);
		if (!command) throw new Error(`Unknown command: ${name}`);
		trace.push(`command:${name}`);
		await invoke(clientId, (context) => command.handler(args, context));
	};

	const driver: SessionDriver = {
		get openedViewCount() {
			return views.openedCount;
		},
		trace,
		connect: (clientId, send) =>
			hub.connect(clientId, () => ({ app: appSnapshot(), views: views.forClient(clientId) }), send),
		getConfiguration: () => structuredClone(configuration),
		invokeAction: async (clientId, id) => {
			const action = actions.current().get(id);
			if (!action) throw new Error(`Unknown action: ${id}`);
			trace.push(`action:${id}`);
			await invoke(clientId, action.handler);
		},
		providers,
		request: async (clientId, request) => {
			if (request.type === "submit") await submit(clientId, request.input);
			else if (request.type === "invoke_action") await driver.invokeAction(clientId, request.id);
			else await views.send(request.viewId, clientId, request.message);
		},
		settings,
		submit,
	};

	return {
		driver,
		activate() {
			actions.rebuild();
			commands.rebuild();
			providers.rebuild();
		},
		api(owner) {
			return {
				actions: { add: (contribution) => actions.add(owner, (draft) => contribution(draft)) },
				commands: { add: (contribution) => commands.add(owner, (draft) => contribution(draft)) },
				providers: {
					add: (contribution) => providers.add(owner, contribution),
					onRebuild: (listener) => providers.onRebuild(listener),
					refresh: (signal) => providers.refresh(signal),
					snapshot: () => providers.snapshot(),
				},
				session: {
					configure: async (next) => {
						const previous = structuredClone(configuration);
						configuration = structuredClone(next);
						trace.push(`config:${next.model?.provider}/${next.model?.modelId}`);
						const event: CodingAgentEvent = { type: "config_update", previous, value: structuredClone(next) };
						hub.broadcast({ type: "event", event });
					},
					getConfiguration: () => structuredClone(configuration),
				},
				settings: {
					set: async (key, value) => {
						settings.set(key, structuredClone(value));
						trace.push(`setting:${key}`);
					},
				},
				view: (component, state, options) => {
					trace.push(`view:open:${component}`);
					return views.open(component, state, options.to);
				},
			};
		},
		close() {
			for (const controller of activeInvocations) controller.abort();
			views.closeAll();
		},
	};
}
