import { BACKGROUND_CONTEXT, type Context, withCancel } from "../../harness/context.ts";
import { isJsonValue, type MutableReplicatedState, type ReplicatedState } from "./types.ts";

export const REMOTE_STATE_INTERNALS = Symbol("pi.remoteState.internals");

export interface RemoteStateInternals<T = unknown> {
	readonly sequence: number;
	readonly value: T;
	subscribe(listener: (value: T, sequence: number, context: Context) => void): () => void;
}

export interface RemoteStateSource<T = unknown> extends MutableReplicatedState<T> {
	readonly [REMOTE_STATE_INTERNALS]: RemoteStateInternals<T>;
}

class MutableRemoteStateImpl<T> implements RemoteStateSource<T> {
	readonly #listeners = new Set<(value: T, context: Context) => void>();
	readonly #sourceListeners = new Set<(value: T, sequence: number, context: Context) => void>();
	#value: T;
	#sequence = 0;

	constructor(initial: T) {
		assertStateValue(initial);
		this.#value = initial;
	}

	get value(): T {
		return this.#value;
	}

	set(value: T, context: Context): void {
		assertStateValue(value);
		this.#value = value;
		this.#sequence += 1;
		for (const listener of this.#sourceListeners) listener(value, this.#sequence, context);
		for (const listener of this.#listeners) listener(value, context);
	}

	subscribe(listener: (value: T, context: Context) => void): () => void {
		this.#listeners.add(listener);
		listener(this.value, freshDeliveryContext());
		return () => this.#listeners.delete(listener);
	}

	get [REMOTE_STATE_INTERNALS](): RemoteStateInternals<T> {
		const source = this;
		return {
			get sequence() {
				return source.#sequence;
			},
			get value() {
				return source.value;
			},
			subscribe: (listener) => {
				this.#sourceListeners.add(listener);
				return () => this.#sourceListeners.delete(listener);
			},
		};
	}
}

export function remoteState<T>(initial: T): MutableReplicatedState<T> {
	return new MutableRemoteStateImpl(initial);
}

export function getRemoteStateInternals(value: unknown): RemoteStateInternals | undefined {
	if (typeof value !== "object" || value === null || !(REMOTE_STATE_INTERNALS in value)) return undefined;
	const candidate = value as { readonly [REMOTE_STATE_INTERNALS]?: unknown };
	const internals = candidate[REMOTE_STATE_INTERNALS];
	if (typeof internals !== "object" || internals === null) return undefined;
	return internals as RemoteStateInternals;
}

export function freshDeliveryContext(): Context {
	return withCancel(BACKGROUND_CONTEXT).context;
}

function assertStateValue(value: unknown): void {
	if (!isJsonValue(value)) throw new TypeError("Remote service value must be strict JSON");
}

export type { ReplicatedState };
