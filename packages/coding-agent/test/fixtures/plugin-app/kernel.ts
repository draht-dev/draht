/**
 * Shared tokens and two-sided plugin shape.
 * Remote state values and ordinary remote method arguments/results must be JSON-serializable.
 * RpcOptions are recognized by the proxy and sent through the transport control plane.
 */

export interface Service<T> {
	readonly id: string;
	readonly _type?: T;
}

export function defineService<T>(id: string): Service<T> {
	return { id };
}

const rpcOptionsMarker = Symbol("rpc-options");

export interface RpcOptions {
	readonly signal?: AbortSignal;
	readonly [rpcOptionsMarker]: true;
}

export function rpcOptions(options: { signal?: AbortSignal } = {}): RpcOptions {
	return { ...options, [rpcOptionsMarker]: true };
}

export function isRpcOptions(value: unknown): value is RpcOptions {
	return typeof value === "object" && value !== null && rpcOptionsMarker in value;
}

export interface RemoteState<T> {
	readonly value: T;
	subscribe(listener: (value: T) => void): () => void;
}

export interface MutableRemoteState<T> extends RemoteState<T> {
	set(value: T): void;
}

export interface AppPlugin<SessionContext, ClientContext> {
	id: string;
	session?(context: SessionContext): void | Promise<void>;
	client?(context: ClientContext): void | Promise<void>;
}

export function definePlugin<SessionContext, ClientContext>(
	plugin: AppPlugin<SessionContext, ClientContext>,
): AppPlugin<SessionContext, ClientContext> {
	return plugin;
}
