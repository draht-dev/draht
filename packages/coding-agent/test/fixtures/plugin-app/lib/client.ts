import { isRpcOptions, type ReplicatedState, type Service } from "./api.ts";
import type { ServerWireMessage, SessionRequest, StateSnapshot } from "./protocol.ts";

export interface ClientTransport {
	close(): void;
	request(request: SessionRequest, signal?: AbortSignal): Promise<unknown>;
	start(listener: (message: ServerWireMessage) => void, onDisconnect: (error?: Error) => void): void;
}

export type ConnectionState =
	| { status: "connecting" }
	| { status: "connected" }
	| { status: "disconnected"; reason: string };

class ClientReplicatedState<T> implements ReplicatedState<T> {
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

export class ClientStateStore {
	readonly connection = new ClientReplicatedState<ConnectionState>({ status: "connecting" });
	updates = 0;
	private readonly listeners = new Set<() => void>();
	private readonly states = new Map<string, ClientReplicatedState<unknown>>();

	apply(message: ServerWireMessage): void {
		if (message.type === "response") return;
		if (message.type === "snapshot") this.replace(message.states);
		else this.update(message.service, message.property, message.value);
		this.notify();
	}

	connected(): void {
		this.connection.set({ status: "connected" });
		this.notify();
	}

	disconnected(error?: Error): void {
		this.connection.set({ status: "disconnected", reason: error?.message ?? "Connection closed" });
		this.notify();
	}

	get<T>(service: string, property: string): ReplicatedState<T> {
		const state = this.states.get(`${service}.${property}`);
		if (!state) throw new Error(`Replicated state not provided: ${service}.${property}`);
		return state as ReplicatedState<T>;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		listener();
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private replace(snapshot: StateSnapshot): void {
		for (const [service, properties] of Object.entries(snapshot)) {
			for (const [property, value] of Object.entries(properties)) this.update(service, property, value, false);
		}
	}

	private update(service: string, property: string, value: unknown, count = true): void {
		const key = `${service}.${property}`;
		const current = this.states.get(key);
		if (current) current.set(value);
		else this.states.set(key, new ClientReplicatedState(value));
		if (count) this.updates++;
	}
}

export class SessionClient {
	readonly ready: Promise<void>;
	readonly store = new ClientStateStore();
	private readonly proxies = new Map<string, object>();
	private readonly rejectReady: (error: Error) => void;
	private readonly resolveReady: () => void;
	private readonly transport: ClientTransport;
	private receivedSnapshot = false;

	constructor(transport: ClientTransport) {
		this.transport = transport;
		let settleReady!: () => void;
		let failReady!: (error: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			settleReady = resolve;
			failReady = reject;
		});
		this.rejectReady = failReady;
		this.resolveReady = settleReady;
		transport.start(
			(message) => {
				this.store.apply(message);
				if (message.type === "snapshot" && !this.receivedSnapshot) {
					this.receivedSnapshot = true;
					this.store.connected();
					this.resolveReady();
				}
			},
			(error) => {
				this.store.disconnected(error);
				if (!this.receivedSnapshot) this.rejectReady(error ?? new Error("Session disconnected before snapshot"));
			},
		);
	}

	close(): void {
		this.transport.close();
	}

	use<T>(service: Service<T>): T {
		let proxy = this.proxies.get(service.id);
		if (!proxy) {
			proxy = new Proxy(
				{},
				{
					get: (_target, property) => {
						if (typeof property !== "string") return undefined;
						try {
							return this.store.get(service.id, property);
						} catch {
							return (...args: unknown[]) => {
								const options = args.at(-1);
								if (!isRpcOptions(options)) {
									return this.transport.request({ type: "rpc", service: service.id, method: property, args });
								}
								return this.transport.request(
									{
										type: "rpc",
										service: service.id,
										method: property,
										args: args.slice(0, -1),
										rpcOptions: true,
									},
									options.signal,
								);
							};
						}
					},
				},
			);
			this.proxies.set(service.id, proxy);
		}
		return proxy as T;
	}
}
