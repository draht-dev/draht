import { BACKGROUND_CONTEXT } from "../context/index.ts";
import type { Context, JsonValue, MutableReplicatedState, ReplicatedState } from "../types.ts";
import { registerReplicatedStateInternals } from "./state-internals.ts";

export class MutableReplicatedStateImpl<T> implements MutableReplicatedState<T> {
	readonly #listeners = new Set<(value: T, context: Context) => void>();
	readonly #sourceListeners = new Set<(value: T, sequence: number, context: Context) => void>();
	#value: T;
	#sequence = 0;

	constructor(initial: T) {
		this.#value = initial;
		const thisSource = this;
		registerReplicatedStateInternals(this, {
			get sequence() {
				return thisSource.#sequence;
			},
			get value() {
				return thisSource.#value;
			},
			subscribe: (listener) => {
				const sourceListener = (value: T, sequence: number, context: Context): void => {
					listener(value, sequence, context);
				};
				thisSource.#sourceListeners.add(sourceListener);
				return () => thisSource.#sourceListeners.delete(sourceListener);
			},
		});
	}

	get value(): T {
		return this.#value;
	}

	set(value: T, context: Context): void {
		this.#value = value;
		this.#sequence += 1;
		for (const listener of this.#sourceListeners) listener(value, this.#sequence, context);
		for (const listener of this.#listeners) listener(value, context);
	}

	subscribe(listener: (value: T, context: Context) => void): () => void {
		this.#listeners.add(listener);
		listener(this.value, serviceDeliveryContext());
		return () => this.#listeners.delete(listener);
	}
}

/** A cold read-only state used by service consumers until a complete snapshot arrives. */
export class ReplicatedStateReplica<T extends JsonValue = JsonValue> implements ReplicatedState<T> {
	readonly #listeners = new Set<(value: T, context: Context) => void>();
	readonly #reportError: (error: Error) => void;
	#value: T | undefined;
	#sequence: number | undefined;

	constructor(reportError: (error: Error) => void) {
		this.#reportError = reportError;
	}

	get value(): T | undefined {
		return this.#value;
	}

	subscribe(listener: (value: T, context: Context) => void): () => void {
		this.#listeners.add(listener);
		if (this.#value !== undefined) this.#deliver(listener, this.#value, serviceDeliveryContext());
		return () => this.#listeners.delete(listener);
	}

	hydrate(sequence: number, value: T, context: Context): void {
		this.#sequence = sequence;
		this.#value = value;
		this.#deliverAll(context);
	}

	update(sequence: number, value: T, context: Context): void {
		if (this.#sequence === undefined) throw new Error("Replicated state received an update before hydration");
		if (sequence <= this.#sequence) return;
		if (sequence !== this.#sequence + 1) throw new Error("Replicated state update sequence has a gap");
		this.#sequence = sequence;
		this.#value = value;
		this.#deliverAll(context);
	}

	clear(): void {
		this.#value = undefined;
		this.#sequence = undefined;
	}

	#deliverAll(context: Context): void {
		if (this.#value === undefined) return;
		for (const listener of this.#listeners) this.#deliver(listener, this.#value, context);
	}

	#deliver(listener: (value: T, context: Context) => void, value: T, context: Context): void {
		try {
			listener(value, context);
		} catch (error) {
			this.#reportError(toError(error));
		}
	}
}

/** @internal Context for synthetic service deliveries without a caller. */
export function serviceDeliveryContext(): Context {
	// TODO: Add delivery-scoped cancellation or metadata if deliveries gain an owned lifecycle.
	return BACKGROUND_CONTEXT;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
