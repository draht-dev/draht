import type { Context } from "../../harness/context.ts";
import {
	type MutableRemoteEvents,
	type RemoteEventListener,
	type RemoteEvents,
	type RemoteEventType,
	ServiceSliceNotImplemented,
} from "./types.ts";

export const REMOTE_EVENTS_INTERNALS = Symbol("pi.remoteEvents.internals");

export interface RemoteEventsInternals {
	readonly deliveryImplemented: false;
}

export interface RemoteEventsSource<T = unknown> extends MutableRemoteEvents<T> {
	readonly [REMOTE_EVENTS_INTERNALS]: RemoteEventsInternals;
}

class UnimplementedRemoteEvents<T> implements RemoteEventsSource<T> {
	readonly [REMOTE_EVENTS_INTERNALS] = { deliveryImplemented: false } as const;

	subscribe(_listener: RemoteEventListener<T>): () => void {
		throw new ServiceSliceNotImplemented("RemoteEvents.subscribe");
	}

	on<TType extends RemoteEventType<T>>(
		_type: TType,
		_listener: RemoteEventListener<Extract<T, { readonly type: TType }>>,
	): () => void {
		throw new ServiceSliceNotImplemented("RemoteEvents.on");
	}

	emit(_event: T, _context: Context): void {
		throw new ServiceSliceNotImplemented("RemoteEvents.emit");
	}
}

/** Declare an event member now while making its unimplemented delivery explicit. */
export function remoteEvents<T>(): MutableRemoteEvents<T> {
	return new UnimplementedRemoteEvents<T>();
}

export function getRemoteEventsInternals(value: unknown): RemoteEventsInternals | undefined {
	if (typeof value !== "object" || value === null || !(REMOTE_EVENTS_INTERNALS in value)) return undefined;
	const candidate = value as { readonly [REMOTE_EVENTS_INTERNALS]?: unknown };
	const internals = candidate[REMOTE_EVENTS_INTERNALS];
	if (typeof internals !== "object" || internals === null) return undefined;
	return internals as RemoteEventsInternals;
}

export type { RemoteEvents };
