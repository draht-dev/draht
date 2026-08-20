import type { Context } from "../../harness/context.ts";
import type { JsonValue } from "../../harness/session/types.ts";
import { getRemoteEventsInternals } from "./events.ts";
import { freshDeliveryContext, getRemoteStateInternals, type RemoteStateInternals } from "./state.ts";
import {
	cloneJson,
	isJsonValue,
	type RemoteService,
	type RemoteServiceConnection,
	type ServiceCall,
	type ServiceInstanceAddress,
	type ServiceInstanceSnapshot,
	type ServiceMemberDescription,
	type ServiceMode,
	type ServiceProviderSubscription,
	type ServiceProviderUpdate,
	type ServiceSubscriptionSnapshot,
} from "./types.ts";

export type RemoteServiceErrorCode =
	| "service_not_allowed"
	| "service_not_found"
	| "service_mode_mismatch"
	| "service_member_not_found"
	| "service_member_mismatch"
	| "service_instance_not_found"
	| "service_stale_instance"
	| "service_invalid_value"
	| "service_not_implemented";

export class RemoteServiceError extends Error {
	readonly code: RemoteServiceErrorCode;

	constructor(code: RemoteServiceErrorCode, message: string) {
		super(message);
		this.name = "RemoteServiceError";
		this.code = code;
	}
}

type RemoteMethod = (...args: unknown[]) => unknown;

type InstanceMember =
	| { readonly kind: "method"; readonly method: RemoteMethod }
	| { readonly kind: "state"; readonly state: RemoteStateInternals }
	| { readonly kind: "events" };

interface ProviderInstance {
	readonly address?: ServiceInstanceAddress;
	readonly implementation: object;
	readonly members: ReadonlyMap<string, InstanceMember>;
	readonly removeStateListeners: readonly (() => void)[];
	active: boolean;
}

interface ProviderSubscriber {
	readonly listener: (update: ServiceProviderUpdate, context: Context) => void;
	readonly buffer: { readonly update: ServiceProviderUpdate; readonly context: Context }[];
	active: boolean;
	closed: boolean;
}

interface ServiceRegistration {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	singleton?: ProviderInstance;
	readonly instances: Map<string, ProviderInstance>;
	readonly generations: Map<string, number>;
	readonly subscribers: Set<ProviderSubscriber>;
}

export class RemoteServiceProvider {
	readonly #allowlist: ReadonlySet<string>;
	readonly #registrations = new Map<string, ServiceRegistration>();
	#disposed = false;

	constructor(services: readonly { readonly id: string }[]) {
		const ids = services.map(({ id }) => id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Remote service allowlist contains duplicate IDs");
		this.#allowlist = new Set(ids);
	}

	provide<T>(service: RemoteService<T>, implementation: T): void {
		this.#assertActive();
		this.#assertAllowed(service.id);
		const registration = this.#registration(service.id, "singleton", true);
		if (registration.singleton !== undefined) {
			throw new RemoteServiceError("service_mode_mismatch", `Remote service ${service.id} already has a provider`);
		}
		const instance = this.#classifyInstance(registration, implementation, undefined);
		registration.singleton = instance;
	}

	use<T>(service: RemoteService<T>): T {
		this.#assertActive();
		this.#assertAllowed(service.id);
		const registration = this.#registrations.get(service.id);
		if (registration?.mode !== "singleton" || registration.singleton === undefined) {
			throw new RemoteServiceError("service_not_found", `Remote service ${service.id} has no local provider`);
		}
		return registration.singleton.implementation as T;
	}

	spawn<T>(service: RemoteService<T>, key: string, implementation: T): () => void {
		this.#assertActive();
		this.#assertAllowed(service.id);
		if (key.length === 0) throw new TypeError("Remote service instance key must not be empty");
		const registration = this.#registration(service.id, "keyed", true);
		if (registration.instances.has(key)) {
			throw new RemoteServiceError(
				"service_mode_mismatch",
				`Remote service ${service.id} already has a live instance with key ${key}`,
			);
		}
		const generation = (registration.generations.get(key) ?? 0) + 1;
		registration.generations.set(key, generation);
		const address = { key, generation } satisfies ServiceInstanceAddress;
		const instance = this.#classifyInstance(registration, implementation, address);
		registration.instances.set(key, instance);
		this.#emit(registration, { type: "spawned", instance: this.#snapshotInstance(instance) });
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			if (registration.instances.get(key) !== instance) return;
			instance.active = false;
			for (const remove of instance.removeStateListeners) remove();
			registration.instances.delete(key);
			this.#emit(registration, { type: "closed", instance: address });
		};
	}

	async invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined> {
		this.#assertActive();
		this.#assertAllowed(call.serviceId);
		if (!call.args.every(isJsonValue)) {
			throw new RemoteServiceError("service_invalid_value", "Remote service arguments must be strict JSON");
		}
		const registration = this.#registrations.get(call.serviceId);
		if (registration === undefined) {
			throw new RemoteServiceError("service_not_found", `Unknown remote service ${call.serviceId}`);
		}
		const instance = this.#resolveInstance(registration, call.instance);
		const member = instance.members.get(call.member);
		if (member === undefined) {
			throw new RemoteServiceError(
				"service_member_not_found",
				`Unknown remote service member ${call.serviceId}.${call.member}`,
			);
		}
		if (member.kind !== "method") {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${call.serviceId}.${call.member} is not a method`,
			);
		}
		const args = call.args.map((value) => cloneJson(value));
		const result: unknown = await Reflect.apply(member.method, instance.implementation, [...args, context]);
		if (result === undefined) return undefined;
		if (!isJsonValue(result)) {
			throw new RemoteServiceError("service_invalid_value", "Remote service result must be strict JSON or void");
		}
		return cloneJson(result);
	}

	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
	): ServiceProviderSubscription {
		this.#assertActive();
		this.#assertAllowed(serviceId);
		const registration = this.#registration(serviceId, mode, mode === "keyed");
		if (registration.mode === "singleton" && registration.singleton === undefined) {
			throw new RemoteServiceError("service_not_found", `Remote service ${serviceId} has no provider`);
		}
		const subscriber: ProviderSubscriber = { listener, buffer: [], active: false, closed: false };
		registration.subscribers.add(subscriber);
		const snapshot = this.#snapshot(registration);
		return {
			snapshot,
			activate: () => {
				if (subscriber.closed || subscriber.active) return;
				subscriber.active = true;
				for (const entry of subscriber.buffer.splice(0)) listener(entry.update, entry.context);
			},
			close: () => {
				if (subscriber.closed) return;
				subscriber.closed = true;
				subscriber.buffer.length = 0;
				registration.subscribers.delete(subscriber);
			},
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const registration of this.#registrations.values()) {
			for (const subscriber of registration.subscribers) {
				subscriber.closed = true;
				subscriber.buffer.length = 0;
			}
			registration.subscribers.clear();
			const instances = [registration.singleton, ...registration.instances.values()];
			for (const instance of instances) {
				if (!instance) continue;
				instance.active = false;
				for (const remove of instance.removeStateListeners) remove();
			}
			registration.instances.clear();
			delete registration.singleton;
		}
		this.#registrations.clear();
	}

	#registration(serviceId: string, mode: ServiceMode, create: boolean): ServiceRegistration {
		const existing = this.#registrations.get(serviceId);
		if (existing !== undefined) {
			if (existing.mode !== mode) {
				throw new RemoteServiceError(
					"service_mode_mismatch",
					`Remote service ${serviceId} is ${existing.mode}, not ${mode}`,
				);
			}
			return existing;
		}
		if (!create) throw new RemoteServiceError("service_not_found", `Unknown remote service ${serviceId}`);
		const registration: ServiceRegistration = {
			serviceId,
			mode,
			instances: new Map(),
			generations: new Map(),
			subscribers: new Set(),
		};
		this.#registrations.set(serviceId, registration);
		return registration;
	}

	#classifyInstance(
		registration: ServiceRegistration,
		implementation: unknown,
		address: ServiceInstanceAddress | undefined,
	): ProviderInstance {
		if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
			throw new TypeError(`Remote service ${registration.serviceId} implementation must be an object`);
		}
		const members = new Map<string, InstanceMember>();
		const removeStateListeners: (() => void)[] = [];
		const instance: ProviderInstance = {
			...(address === undefined ? {} : { address }),
			implementation,
			members,
			removeStateListeners,
			active: true,
		};
		for (const name of Object.keys(implementation).sort()) {
			const descriptor = Object.getOwnPropertyDescriptor(implementation, name);
			if (descriptor === undefined || !("value" in descriptor)) {
				throw new TypeError(`Remote service member ${registration.serviceId}.${name} must be a data property`);
			}
			if (typeof descriptor.value === "function") {
				members.set(name, { kind: "method", method: descriptor.value as RemoteMethod });
				continue;
			}
			const state = getRemoteStateInternals(descriptor.value);
			if (state !== undefined) {
				members.set(name, { kind: "state", state });
				removeStateListeners.push(
					state.subscribe((value, sequence, context) => {
						if (!instance.active) return;
						if (!isJsonValue(value)) {
							throw new RemoteServiceError("service_invalid_value", "Remote state update must be strict JSON");
						}
						this.#emit(
							registration,
							{
								type: "state",
								...(address === undefined ? {} : { instance: address }),
								member: name,
								sequence,
								value,
							},
							context,
						);
					}),
				);
				continue;
			}
			if (getRemoteEventsInternals(descriptor.value) !== undefined) {
				members.set(name, { kind: "events" });
				continue;
			}
			throw new TypeError(`Remote service member ${registration.serviceId}.${name} is not remotely exposable`);
		}
		if (members.size === 0) throw new TypeError(`Remote service ${registration.serviceId} has no members`);
		return instance;
	}

	#resolveInstance(registration: ServiceRegistration, address: ServiceInstanceAddress | undefined): ProviderInstance {
		if (registration.mode === "singleton") {
			if (address !== undefined) {
				throw new RemoteServiceError(
					"service_mode_mismatch",
					`Remote service ${registration.serviceId} is singleton`,
				);
			}
			if (registration.singleton === undefined) {
				throw new RemoteServiceError(
					"service_not_found",
					`Remote service ${registration.serviceId} has no provider`,
				);
			}
			return registration.singleton;
		}
		if (address === undefined) {
			throw new RemoteServiceError("service_mode_mismatch", `Remote service ${registration.serviceId} is keyed`);
		}
		const instance = registration.instances.get(address.key);
		if (instance === undefined) {
			throw new RemoteServiceError(
				"service_instance_not_found",
				`Remote service ${registration.serviceId} has no instance ${address.key}`,
			);
		}
		if (instance.address?.generation !== address.generation) {
			throw new RemoteServiceError(
				"service_stale_instance",
				`Remote service ${registration.serviceId} instance ${address.key} is stale`,
			);
		}
		return instance;
	}

	#snapshot(registration: ServiceRegistration): ServiceSubscriptionSnapshot {
		const instances =
			registration.mode === "singleton"
				? registration.singleton
					? [this.#snapshotInstance(registration.singleton)]
					: []
				: [...registration.instances.values()]
						.sort((left, right) => left.address!.key.localeCompare(right.address!.key))
						.map((instance) => this.#snapshotInstance(instance));
		return { serviceId: registration.serviceId, mode: registration.mode, instances };
	}

	#snapshotInstance(instance: ProviderInstance): ServiceInstanceSnapshot {
		const members: ServiceMemberDescription[] = [];
		const states: Record<string, { sequence: number; value: JsonValue }> = {};
		for (const [name, member] of instance.members) {
			members.push({ name, kind: member.kind });
			if (member.kind === "state") {
				if (!isJsonValue(member.state.value)) {
					throw new RemoteServiceError("service_invalid_value", "Remote state snapshot must be strict JSON");
				}
				states[name] = { sequence: member.state.sequence, value: member.state.value };
			}
		}
		return {
			...(instance.address === undefined ? {} : { instance: instance.address }),
			members,
			states,
		};
	}

	#emit(registration: ServiceRegistration, update: ServiceProviderUpdate, context?: Context): void {
		if (registration.subscribers.size === 0) return;
		const deliveryContext = context ?? freshDeliveryContext();
		for (const subscriber of registration.subscribers) {
			if (subscriber.closed) continue;
			const entry = { update, context: deliveryContext };
			if (subscriber.active) subscriber.listener(entry.update, entry.context);
			else subscriber.buffer.push(entry);
		}
	}

	#assertAllowed(serviceId: string): void {
		if (!this.#allowlist.has(serviceId)) {
			throw new RemoteServiceError("service_not_allowed", `Remote service ${serviceId} is not allowlisted`);
		}
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Remote service provider is disposed");
	}
}

export function createLoopbackServiceConnection(provider: RemoteServiceProvider): RemoteServiceConnection {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, (update) => listener(update, freshDeliveryContext()));
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}
