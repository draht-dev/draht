import type { Context } from "../context.ts";
import type { JsonValue } from "../json.ts";
import type { MutableReplicatedState, ReplicatedState } from "../state.ts";

const SERVICE_TYPE = Symbol("chord.service.type");

export type ServiceMode = "singleton" | "keyed";

type InvalidJsonPart<T> = [T] extends [JsonValue]
	? [JsonValue] extends [T]
		? never
		: InvalidJsonStructure<T>
	: InvalidJsonStructure<T>;

type InvalidJsonStructure<T> = T extends null | boolean | number | string
	? never
	: T extends readonly (infer TItem)[]
		? InvalidJsonPart<TItem>
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { [TKey in keyof T]-?: InvalidJsonPart<T[TKey]> }[keyof T]
				: T;

type InvalidRemoteMember<T> = T extends ReplicatedState<infer TValue>
	? InvalidJsonPart<TValue> extends never
		? never
		: "state value is not JSON"
	: T extends (...args: [...infer TArgs, Context]) => Promise<infer TResult>
		? InvalidJsonPart<TArgs[number]> extends never
			? TResult extends void
				? never
				: InvalidJsonPart<TResult> extends never
					? never
					: "method result is not JSON or void"
			: "method argument is not JSON"
		: "member is not a remote method or ReplicatedState";

type InvalidRemoteMemberNames<T> = {
	[TKey in keyof T]-?: InvalidRemoteMember<T[TKey]> extends never ? never : TKey;
}[keyof T];

export type RemoteServiceContract<T> = InvalidRemoteMemberNames<T> extends never ? T : never;

/** Stable identity for one shared TypeScript service contract. */
export interface Service<T> {
	// TODO: check if this should be part of Chord.
	readonly id: string;
	/** Process-local services accept unrestricted object contracts and are never published remotely. */
	readonly local: boolean;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

export function defineService<T>(id: string, options: { readonly local: true }): Service<T>;
export function defineService<T>(
	id: string,
	...options: [RemoteServiceContract<T>] extends [never]
		? readonly [options: never]
		: readonly [options?: { readonly local?: false }]
): Service<T>;
export function defineService(id: string, options?: { readonly local?: boolean }): Service<unknown> {
	if (id.length === 0) throw new TypeError("Service ID must not be empty");
	// TODO: check if this should be part of Chord.
	if (id.startsWith("$chord.")) throw new TypeError("Service IDs beginning with $chord. are reserved");
	return Object.freeze({ id, local: options?.local ?? false });
}

export interface RemoteServiceInstance<T> {
	readonly key: string;
	readonly service: T;
}

export interface RemoteServices {
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
	/** Activate this service set and wait for every acquired service to become ready. */
	activate(context: Context): Promise<void>;
	/** Wait until every currently acquired service has installed its initial snapshot. */
	ready(context: Context): Promise<void>;
	/** Install a host lifecycle guard for proxy member access. */
	setAccessGuard(assertAccess: () => void): void;
	dispose(context: Context): Promise<void>;
}

export type { MutableReplicatedState, ReplicatedState };
