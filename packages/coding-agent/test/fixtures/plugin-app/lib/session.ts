import { type AppPlugin, type MutableReplicatedState, rpcOptions, type Service } from "./api.ts";
import type { ServerWireMessage, SessionRequest, StateSnapshot } from "./protocol.ts";

class SessionRemoteState<T> implements MutableReplicatedState<T> {
	private readonly listeners = new Set<(value: T) => void>();
	private current: T;

	constructor(initial: T) {
		this.current = structuredClone(initial);
	}

	get value(): T {
		return this.current;
	}

	set(value: T): void {
		this.current = structuredClone(value);
		for (const listener of this.listeners) listener(this.current);
	}

	subscribe(listener: (value: T) => void): () => void {
		this.listeners.add(listener);
		listener(this.current);
		return () => this.listeners.delete(listener);
	}
}

class ClientHub {
	private readonly connections = new Map<string, (message: ServerWireMessage) => void>();

	connect(clientId: string, snapshot: () => StateSnapshot, send: (message: ServerWireMessage) => void): () => void {
		const pending: ServerWireMessage[] = [];
		let ready = false;
		const connection = (message: ServerWireMessage) => {
			if (ready) send(message);
			else pending.push(message);
		};
		this.connections.set(clientId, connection);
		send({ type: "snapshot", states: structuredClone(snapshot()) });
		ready = true;
		for (const message of pending) send(message);
		return () => {
			if (this.connections.get(clientId) === connection) this.connections.delete(clientId);
		};
	}

	broadcast(message: ServerWireMessage): void {
		for (const send of this.connections.values()) send(structuredClone(message));
	}
}

export interface SessionContext {
	onActivate(callback: () => void | Promise<void>): void;
	onClientConnect(callback: (clientId: string) => void): void;
	onClientDisconnect(callback: (clientId: string) => void): void;
	onClose(callback: () => void): void;
	provide<T>(service: Service<T>, implementation: T): void;
	remoteState<T>(initial: T): MutableReplicatedState<T>;
	use<T>(service: Service<T>): T;
}

export interface SessionDriver {
	readonly trace: readonly string[];
	connect(clientId: string, send: (message: ServerWireMessage) => void): () => void;
	request(clientId: string, request: SessionRequest, signal: AbortSignal): Promise<unknown>;
	use<T>(service: Service<T>): T;
}

export class SessionRuntime<ClientContext> {
	readonly driver: SessionDriver;
	private readonly activateCallbacks: Array<() => void | Promise<void>> = [];
	private readonly clientConnectCallbacks: Array<(clientId: string) => void> = [];
	private readonly clientDisconnectCallbacks: Array<(clientId: string) => void> = [];
	private readonly closeCallbacks: Array<() => void> = [];
	private readonly hub = new ClientHub();
	private readonly plugins: readonly AppPlugin<SessionContext, ClientContext>[];
	private readonly services = new Map<string, object>();
	private readonly trace: string[] = [];

	constructor(plugins: readonly AppPlugin<SessionContext, ClientContext>[]) {
		this.plugins = plugins;
		this.driver = {
			trace: this.trace,
			connect: (clientId, send) => {
				const disconnect = this.hub.connect(clientId, () => this.snapshot(), send);
				for (const callback of this.clientConnectCallbacks) callback(clientId);
				let connected = true;
				return () => {
					if (!connected) return;
					connected = false;
					disconnect();
					for (const callback of this.clientDisconnectCallbacks) callback(clientId);
				};
			},
			request: async (clientId, request, signal) => {
				const service = this.services.get(request.service) as Record<string, unknown> | undefined;
				const method = service?.[request.method];
				if (typeof method !== "function") throw new Error(`Unknown RPC: ${request.service}.${request.method}`);
				this.trace.push(`rpc:${request.service}.${request.method}`);
				const args = request.rpcOptions ? [...request.args, rpcOptions({ clientId, signal })] : request.args;
				return Reflect.apply(method, service, args);
			},
			use: (service) => this.use(service),
		};
	}

	async start(): Promise<void> {
		const context: SessionContext = {
			onActivate: (callback) => this.activateCallbacks.push(callback),
			onClientConnect: (callback) => this.clientConnectCallbacks.push(callback),
			onClientDisconnect: (callback) => this.clientDisconnectCallbacks.push(callback),
			onClose: (callback) => this.closeCallbacks.push(callback),
			provide: (service, implementation) => this.provide(service, implementation),
			remoteState: (initial) => new SessionRemoteState(initial),
			use: (service) => this.use(service),
		};
		for (const plugin of this.plugins) await plugin.session?.(context);
		for (const activate of this.activateCallbacks) await activate();
	}

	close(): void {
		for (const close of this.closeCallbacks.splice(0).reverse()) close();
	}

	private provide<T>(service: Service<T>, implementation: T): void {
		if (this.services.has(service.id)) throw new Error(`Service already provided: ${service.id}`);
		this.services.set(service.id, implementation as object);
		for (const [property, value] of Object.entries(implementation as object)) {
			if (!(value instanceof SessionRemoteState)) continue;
			value.subscribe((next) => {
				this.hub.broadcast({
					type: "state_update",
					service: service.id,
					property,
					value: structuredClone(next),
				});
			});
		}
	}

	private use<T>(service: Service<T>): T {
		const implementation = this.services.get(service.id);
		if (!implementation) throw new Error(`Service not provided: ${service.id}`);
		return implementation as T;
	}

	private snapshot(): StateSnapshot {
		const snapshot: StateSnapshot = {};
		for (const [serviceId, implementation] of this.services) {
			const states: Record<string, unknown> = {};
			for (const [property, value] of Object.entries(implementation)) {
				if (value instanceof SessionRemoteState) states[property] = structuredClone(value.value);
			}
			if (Object.keys(states).length > 0) snapshot[serviceId] = states;
		}
		return snapshot;
	}
}
