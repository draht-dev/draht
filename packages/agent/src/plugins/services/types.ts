import type { Context } from "../../harness/context.ts";
import type { JsonValue } from "../../harness/session/types.ts";

const SERVICE_TYPE = Symbol("pi.service.type");

export type ServiceMode = "singleton" | "keyed";
export type ServiceMemberKind = "method" | "state" | "events";

export class ServiceSliceNotImplemented extends Error {
	readonly code = "service_not_implemented" as const;

	constructor(operation: string) {
		super(`${operation} is not implemented until its later plugin-service slice`);
		this.name = "ServiceSliceNotImplemented";
	}
}

export interface ReplicatedState<T> {
	/** Borrowed immutable value, or undefined until hydration. Do not mutate or retain it. */
	readonly value: T | undefined;
	/** Listener values are borrowed and must not be mutated or retained. */
	subscribe(listener: (value: T, context: Context) => void): () => void;
}

export interface MutableReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	/** Transfers the JSON value to the state; the caller must not subsequently mutate it. */
	set(value: T, context: Context): void;
}

export type RemoteEventType<T> = T extends { readonly type: infer TType extends string } ? TType : never;
export type RemoteEventListener<T> = (event: T, context: Context) => void;

/** Non-durable semantic events. Event values are borrowed immutable JSON and are never replayed. */
export interface RemoteEvents<T> {
	subscribe(listener: RemoteEventListener<T>): () => void;
	on<TType extends RemoteEventType<T>>(
		type: TType,
		listener: RemoteEventListener<Extract<T, { readonly type: TType }>>,
	): () => void;
}

export interface MutableRemoteEvents<T> extends RemoteEvents<T> {
	emit(event: T, context: Context): void;
}

/** Marks an existing schema-validated wire DTO as JSON-safe for static service-contract checking. */
declare const REMOTE_JSON_TYPE: unique symbol;
export type RemoteJson<T> = T & { readonly [REMOTE_JSON_TYPE]?: true };

type JsonPrimitive = null | boolean | number | string;
type InvalidJsonPart<T> = typeof REMOTE_JSON_TYPE extends keyof T
	? never
	: T extends JsonPrimitive
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
	: T extends RemoteEvents<infer TEvent>
		? InvalidJsonPart<TEvent> extends never
			? never
			: "event value is not JSON"
		: T extends (...args: [...infer TArgs, Context]) => Promise<infer TResult>
			? InvalidJsonPart<TArgs[number]> extends never
				? TResult extends void
					? never
					: InvalidJsonPart<TResult> extends never
						? never
						: "method result is not JSON or void"
				: "method argument is not JSON"
			: "member is not a remote method, ReplicatedState, or RemoteEvents";

type InvalidRemoteMemberNames<T> = {
	[TKey in keyof T]-?: InvalidRemoteMember<T[TKey]> extends never ? never : TKey;
}[keyof T];

type CheckedRemoteContract<T> = InvalidRemoteMemberNames<T> extends never ? T : never;

/** Stable identity for one shared TypeScript service contract. */
export interface Service<T> {
	readonly id: string;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

export type ServiceType<TService> = TService extends Service<infer T> ? T : never;

export function defineService<T>(id: string): Service<CheckedRemoteContract<T>> {
	if (id.length === 0) throw new TypeError("Remote service ID must not be empty");
	if (id.startsWith("$pi.")) throw new TypeError("Remote service IDs beginning with $pi. are reserved");
	return Object.freeze({ id });
}

export interface ServiceInstanceAddress {
	readonly key: string;
	readonly generation: number;
}

export interface ServiceMemberDescription {
	readonly name: string;
	readonly kind: ServiceMemberKind;
}

export interface ServiceStateSnapshot {
	readonly sequence: number;
	readonly value: JsonValue;
}

export interface ServiceInstanceSnapshot {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberDescription[];
	readonly states: Readonly<Record<string, ServiceStateSnapshot>>;
}

export interface ServiceSubscriptionSnapshot {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
}

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly value: JsonValue;
	  }
	| {
			readonly type: "event";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly event: JsonValue;
	  }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export interface ServiceCall {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	readonly args: readonly JsonValue[];
}

export interface ServiceProviderSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(): void;
}

export interface RemoteServiceSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context: Context): void | Promise<void>;
}

/** Transport-neutral connection consumed by a remote service namespace. */
export interface RemoteServiceConnection {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<RemoteServiceSubscription>;
}

export interface RemoteServiceInstance<T> {
	readonly key: string;
	readonly service: T;
}

export interface RemoteServiceNamespaceOptions {
	readonly services: readonly { readonly id: string }[];
	readonly connection: RemoteServiceConnection;
	readonly bound?: boolean;
	readonly onError?: (error: Error) => void;
}

export interface RemoteServiceNamespaceApi {
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
	/** Wait until every currently acquired service has installed its initial snapshot. */
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export function isJsonValue(value: unknown): value is JsonValue {
	return checkJsonValue(value, new Set<object>());
}

function checkJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;
	if (!Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		if (
			Object.getOwnPropertySymbols(value).some((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol))
		) {
			return false;
		}
	}
	ancestors.add(value);
	const valid = Array.isArray(value)
		? checkJsonArray(value, ancestors)
		: Object.values(value).every((item) => checkJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}

function checkJsonArray(value: unknown[], ancestors: Set<object>): value is JsonValue[] {
	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index) || !checkJsonValue(value[index], ancestors)) return false;
	}
	return true;
}

export function cloneJson<T>(value: T): T {
	if (!isJsonValue(value)) throw new TypeError("Remote service value must be strict JSON");
	return structuredClone(value);
}
