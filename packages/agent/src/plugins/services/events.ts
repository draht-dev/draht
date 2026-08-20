import type { Context } from "../../harness/context.ts";
import {
	isJsonValue,
	type MutableRemoteEvents,
	type RemoteEventListener,
	type RemoteEvents,
	type RemoteEventType,
} from "./types.ts";

export const REMOTE_EVENTS_INTERNALS = Symbol("pi.remoteEvents.internals");

export interface RemoteEventsInternals<T = unknown> {
	subscribe(listener: RemoteEventListener<T>): () => void;
}

export interface RemoteEventsSource<T = unknown> extends MutableRemoteEvents<T> {
	readonly [REMOTE_EVENTS_INTERNALS]: RemoteEventsInternals<T>;
}

class MutableRemoteEventsImpl<T> implements RemoteEventsSource<T> {
	readonly #listeners = new Set<RemoteEventListener<T>>();
	readonly #sourceListeners = new Set<RemoteEventListener<T>>();

	subscribe(listener: RemoteEventListener<T>): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	on<TType extends RemoteEventType<T>>(
		type: TType,
		listener: RemoteEventListener<Extract<T, { readonly type: TType }>>,
	): () => void {
		return this.subscribe((event, context) => {
			if (hasEventType(event, type)) listener(event, context);
		});
	}

	emit(event: T, context: Context): void {
		if (!isJsonValue(event)) throw new TypeError("Remote event value must be strict JSON");
		for (const listener of this.#sourceListeners) listener(event, context);
		for (const listener of this.#listeners) listener(event, context);
	}

	get [REMOTE_EVENTS_INTERNALS](): RemoteEventsInternals<T> {
		return {
			subscribe: (listener) => {
				this.#sourceListeners.add(listener);
				return () => this.#sourceListeners.delete(listener);
			},
		};
	}
}

/** Create one provider-owned non-durable semantic event source. */
export function remoteEvents<T>(): MutableRemoteEvents<T> {
	return new MutableRemoteEventsImpl<T>();
}

export function getRemoteEventsInternals(value: unknown): RemoteEventsInternals | undefined {
	if (typeof value !== "object" || value === null || !(REMOTE_EVENTS_INTERNALS in value)) return undefined;
	const candidate = value as { readonly [REMOTE_EVENTS_INTERNALS]?: unknown };
	const internals = candidate[REMOTE_EVENTS_INTERNALS];
	if (typeof internals !== "object" || internals === null || !("subscribe" in internals)) return undefined;
	return typeof internals.subscribe === "function" ? (internals as RemoteEventsInternals) : undefined;
}

function hasEventType<T, TType extends string>(event: T, type: TType): event is Extract<T, { readonly type: TType }> {
	return typeof event === "object" && event !== null && "type" in event && event.type === type;
}

export type { RemoteEvents };
