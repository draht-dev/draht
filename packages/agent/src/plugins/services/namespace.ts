import { BACKGROUND_CONTEXT, type Context, withCancel } from "../../harness/context.ts";
import type { JsonValue } from "../../harness/session/types.ts";
import { RemoteServiceError } from "./provider.ts";
import { freshDeliveryContext } from "./state.ts";
import {
	cloneJson,
	isJsonValue,
	type RemoteService,
	type RemoteServiceConnection,
	type RemoteServiceInstance,
	type RemoteServiceNamespaceApi,
	type RemoteServiceNamespaceOptions,
	type RemoteServiceSubscription,
	type RemoteState,
	type ServiceInstanceAddress,
	type ServiceInstanceSnapshot,
	type ServiceMemberDescription,
	type ServiceMemberKind,
	type ServiceProviderUpdate,
	ServiceSliceNotImplemented,
	type ServiceStateSnapshot,
} from "./types.ts";

type ErrorReporter = (error: Error) => void;

class RemoteStateReplica implements RemoteState<JsonValue> {
	readonly #listeners = new Set<(value: JsonValue, context: Context) => void>();
	readonly #reportError: ErrorReporter;
	#value: JsonValue | undefined;
	#sequence: number | undefined;

	constructor(reportError: ErrorReporter) {
		this.#reportError = reportError;
	}

	get value(): JsonValue | undefined {
		return this.#value;
	}

	subscribe(listener: (value: JsonValue, context: Context) => void): () => void {
		this.#listeners.add(listener);
		if (this.#value !== undefined) this.#deliver(listener, this.#value, freshDeliveryContext());
		return () => this.#listeners.delete(listener);
	}

	hydrate(snapshot: ServiceStateSnapshot, context: Context): void {
		this.#sequence = snapshot.sequence;
		this.#value = snapshot.value;
		this.#deliverAll(context);
	}

	update(sequence: number, value: JsonValue, context: Context): void {
		if (this.#sequence === undefined) throw new Error("Remote state received an update before hydration");
		if (sequence <= this.#sequence) return;
		if (sequence !== this.#sequence + 1) throw new Error("Remote state update sequence has a gap");
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

	#deliver(listener: (value: JsonValue, context: Context) => void, value: JsonValue, context: Context): void {
		try {
			listener(value, context);
		} catch (error) {
			this.#reportError(toError(error));
		}
	}
}

class MemberSlot {
	readonly #serviceId: string;
	readonly #member: string;
	readonly #invoke: (args: readonly JsonValue[], context: Context) => Promise<JsonValue | undefined>;
	readonly #state: RemoteStateReplica;
	readonly #isActive: () => boolean;
	readonly value: unknown;
	#kind: ServiceMemberKind | undefined;
	#expectedKind: ServiceMemberKind | undefined;

	constructor(
		serviceId: string,
		member: string,
		invoke: (args: readonly JsonValue[], context: Context) => Promise<JsonValue | undefined>,
		isActive: () => boolean,
		reportError: ErrorReporter,
	) {
		this.#serviceId = serviceId;
		this.#member = member;
		this.#invoke = invoke;
		this.#isActive = isActive;
		this.#state = new RemoteStateReplica(reportError);
		const callable = (): void => {};
		this.value = new Proxy(callable, {
			apply: (_target, _thisArg, args) => this.#call(args),
			get: (_target, property) => {
				if (property === "value") {
					this.#expect("state");
					return this.#state.value;
				}
				if (property === "subscribe") {
					if (this.#kind === "events") {
						this.#expect("events");
						return () => {
							throw new ServiceSliceNotImplemented("RemoteEvents.subscribe");
						};
					}
					this.#expect("state");
					return this.#state.subscribe.bind(this.#state);
				}
				if (property === "on") {
					this.#expect("events");
					return () => {
						throw new ServiceSliceNotImplemented("RemoteEvents.on");
					};
				}
				if (property === Symbol.toStringTag) return "RemoteServiceMember";
				if (property === "then") return undefined;
				return undefined;
			},
		});
	}

	setDescription(kind: ServiceMemberKind): void {
		if (this.#kind !== undefined && this.#kind !== kind) {
			throw new Error(`Remote service member ${this.#serviceId}.${this.#member} changed kind`);
		}
		this.#kind = kind;
		if (this.#expectedKind !== undefined && this.#expectedKind !== kind) {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${this.#serviceId}.${this.#member} is ${kind}, not ${this.#expectedKind}`,
			);
		}
	}

	hydrate(snapshot: ServiceStateSnapshot, context: Context): void {
		this.setDescription("state");
		this.#state.hydrate(snapshot, context);
	}

	update(sequence: number, value: JsonValue, context: Context): void {
		this.setDescription("state");
		this.#state.update(sequence, value, context);
	}

	clear(): void {
		this.#state.clear();
	}

	#expect(kind: ServiceMemberKind): void {
		if (this.#expectedKind !== undefined && this.#expectedKind !== kind) {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${this.#serviceId}.${this.#member} was used as two different kinds`,
			);
		}
		this.#expectedKind = kind;
		if (this.#kind !== undefined && this.#kind !== kind) {
			throw new RemoteServiceError(
				"service_member_mismatch",
				`Remote service member ${this.#serviceId}.${this.#member} is ${this.#kind}, not ${kind}`,
			);
		}
	}

	#call(args: unknown[]): Promise<JsonValue | undefined> {
		this.#expect("method");
		if (!this.#isActive()) {
			return Promise.reject(
				new RemoteServiceError("service_stale_instance", `Remote service ${this.#serviceId} binding is closed`),
			);
		}
		const context = args.at(-1);
		if (!isContext(context)) {
			return Promise.reject(
				new RemoteServiceError(
					"service_invalid_value",
					`Remote service method ${this.#serviceId}.${this.#member} requires a trailing Context`,
				),
			);
		}
		const businessArgs = args.slice(0, -1);
		if (!businessArgs.every(isJsonValue)) {
			return Promise.reject(
				new RemoteServiceError(
					"service_invalid_value",
					`Remote service method ${this.#serviceId}.${this.#member} arguments must be strict JSON`,
				),
			);
		}
		return this.#invoke(
			businessArgs.map((value) => cloneJson(value)),
			context,
		);
	}
}

class ServiceFacade {
	readonly #serviceId: string;
	readonly #address: ServiceInstanceAddress | undefined;
	readonly #connection: RemoteServiceConnection;
	readonly #reportError: ErrorReporter;
	readonly #slots = new Map<string, MemberSlot>();
	readonly #descriptions = new Map<string, ServiceMemberKind>();
	readonly #stateSnapshots = new Map<string, ServiceStateSnapshot>();
	readonly #isActive: () => boolean;
	readonly proxy: object;

	constructor(
		serviceId: string,
		address: ServiceInstanceAddress | undefined,
		connection: RemoteServiceConnection,
		isActive: () => boolean,
		reportError: ErrorReporter,
	) {
		this.#serviceId = serviceId;
		this.#address = address;
		this.#connection = connection;
		this.#isActive = isActive;
		this.#reportError = reportError;
		this.proxy = new Proxy(Object.create(null) as object, {
			get: (_target, property) => {
				if (typeof property !== "string") return undefined;
				return this.#slot(property).value;
			},
		});
	}

	install(snapshot: ServiceInstanceSnapshot, context: Context): void {
		if (!sameAddress(snapshot.instance, this.#address))
			throw new Error("Remote service snapshot has the wrong address");
		const descriptions = validateMemberDescriptions(snapshot.members);
		for (const name of this.#slots.keys()) {
			if (!descriptions.has(name)) {
				throw new RemoteServiceError(
					"service_member_not_found",
					`Unknown remote service member ${this.#serviceId}.${name}`,
				);
			}
		}
		for (const [name, kind] of descriptions) {
			if ((kind === "state") !== Object.hasOwn(snapshot.states, name)) {
				throw new Error(`Remote service snapshot has invalid state metadata for ${this.#serviceId}.${name}`);
			}
		}
		this.#descriptions.clear();
		for (const [name, kind] of descriptions) {
			this.#descriptions.set(name, kind);
			this.#slots.get(name)?.setDescription(kind);
		}
		this.#stateSnapshots.clear();
		for (const [name, state] of Object.entries(snapshot.states)) {
			this.#stateSnapshots.set(name, state);
			this.#slot(name).hydrate(state, context);
		}
	}

	update(member: string, sequence: number, value: JsonValue, context: Context): void {
		if (this.#descriptions.get(member) !== "state") {
			throw new Error(`Remote service update targets non-state member ${this.#serviceId}.${member}`);
		}
		const snapshot = { sequence, value };
		this.#stateSnapshots.set(member, snapshot);
		this.#slot(member).update(sequence, value, context);
	}

	clear(): void {
		for (const slot of this.#slots.values()) slot.clear();
		this.#stateSnapshots.clear();
	}

	#slot(member: string): MemberSlot {
		let slot = this.#slots.get(member);
		if (slot !== undefined) return slot;
		slot = new MemberSlot(
			this.#serviceId,
			member,
			(args, context) =>
				this.#connection.invoke(
					{
						serviceId: this.#serviceId,
						...(this.#address === undefined ? {} : { instance: this.#address }),
						member,
						args,
					},
					context,
				),
			this.#isActive,
			this.#reportError,
		);
		const kind = this.#descriptions.get(member);
		if (kind !== undefined) slot.setDescription(kind);
		const state = this.#stateSnapshots.get(member);
		if (state !== undefined) slot.hydrate(state, freshDeliveryContext());
		this.#slots.set(member, slot);
		return slot;
	}
}

interface SingletonBinding {
	facade: ServiceFacade;
	subscription?: RemoteServiceSubscription;
	active: boolean;
	revision: number;
}

interface KeyedInstance {
	readonly address: ServiceInstanceAddress;
	facade: ServiceFacade;
	active: boolean;
}

interface ObserverTask {
	readonly cancel: (reason?: unknown) => void;
}

interface ObserverRegistration<T> {
	readonly handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>;
	readonly tasks: Map<string, ObserverTask>;
	closed: boolean;
}

class KeyedBinding<T> {
	readonly #service: RemoteService<T>;
	readonly #connection: RemoteServiceConnection;
	readonly #reportError: ErrorReporter;
	readonly #onEmpty: () => void;
	readonly #instances = new Map<string, KeyedInstance>();
	readonly #observers = new Set<ObserverRegistration<T>>();
	#subscription: RemoteServiceSubscription | undefined;
	#starting: Promise<void> | undefined;
	#closed = false;
	#bound: boolean;
	#hydrated = false;
	#revision = 0;

	constructor(
		service: RemoteService<T>,
		connection: RemoteServiceConnection,
		reportError: ErrorReporter,
		onEmpty: () => void,
		bound: boolean,
	) {
		this.#service = service;
		this.#connection = connection;
		this.#reportError = reportError;
		this.#onEmpty = onEmpty;
		this.#bound = bound;
	}

	observe(handler: ObserverRegistration<T>["handler"]): () => void {
		if (this.#closed) throw new Error("Remote keyed service binding is closed");
		const observer: ObserverRegistration<T> = { handler, tasks: new Map(), closed: false };
		this.#observers.add(observer);
		if (this.#hydrated) {
			for (const instance of this.#instances.values()) this.#startTask(observer, instance);
		}
		if (this.#bound) {
			this.#starting ??= this.#start(this.#revision);
			void this.#starting.catch(this.#reportError);
		}
		return () => {
			if (observer.closed) return;
			observer.closed = true;
			for (const task of observer.tasks.values()) task.cancel();
			observer.tasks.clear();
			this.#observers.delete(observer);
			if (this.#observers.size === 0) this.#onEmpty();
		};
	}

	async rebind(bound: boolean, context: Context): Promise<void> {
		if (this.#closed) return;
		this.#bound = bound;
		this.#revision += 1;
		await this.#reset(context);
		if (bound && this.#observers.size > 0) {
			this.#starting = this.#start(this.#revision);
			void this.#starting.catch(this.#reportError);
		}
	}

	async close(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#revision += 1;
		await this.#reset(context);
		for (const observer of this.#observers) observer.closed = true;
		this.#observers.clear();
	}

	async #reset(context: Context): Promise<void> {
		for (const observer of this.#observers) {
			for (const task of observer.tasks.values()) task.cancel();
			observer.tasks.clear();
		}
		for (const instance of this.#instances.values()) {
			instance.active = false;
			instance.facade.clear();
		}
		this.#instances.clear();
		this.#hydrated = false;
		this.#starting = undefined;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		await subscription?.close(context);
	}

	async #start(revision: number): Promise<void> {
		const subscription = await this.#connection.subscribe(
			this.#service.id,
			"keyed",
			(update, context) => {
				if (this.#revision === revision) this.#update(update, context);
			},
			BACKGROUND_CONTEXT,
		);
		if (this.#closed || !this.#bound || this.#revision !== revision) {
			await subscription.close(BACKGROUND_CONTEXT);
			return;
		}
		this.#subscription = subscription;
		if (subscription.snapshot.mode !== "keyed" || subscription.snapshot.serviceId !== this.#service.id) {
			throw new Error(`Remote service ${this.#service.id} returned the wrong keyed snapshot`);
		}
		for (const snapshot of subscription.snapshot.instances) this.#spawn(snapshot, freshDeliveryContext(), false);
		this.#hydrated = true;
		for (const observer of this.#observers) {
			for (const instance of this.#instances.values()) this.#startTask(observer, instance);
		}
		subscription.activate();
	}

	#update(update: ServiceProviderUpdate, context: Context): void {
		if (this.#closed) return;
		try {
			switch (update.type) {
				case "spawned":
					this.#spawn(update.instance, context, true);
					break;
				case "closed":
					this.#closeInstance(update.instance);
					break;
				case "state": {
					if (update.instance === undefined) throw new Error("Keyed state update has no instance address");
					const instance = this.#instances.get(update.instance.key);
					if (instance?.address.generation !== update.instance.generation) return;
					instance.facade.update(update.member, update.sequence, update.value, context);
					break;
				}
			}
		} catch (error) {
			this.#reportError(toError(error));
		}
	}

	#spawn(snapshot: ServiceInstanceSnapshot, context: Context, startTasks: boolean): void {
		const address = snapshot.instance;
		if (address === undefined) throw new Error("Keyed service instance snapshot has no address");
		const previous = this.#instances.get(address.key);
		if (previous !== undefined) {
			if (previous.address.generation === address.generation)
				throw new Error("Keyed service repeated a live generation");
			this.#closeInstance(previous.address);
		}
		const instance: KeyedInstance = {
			address,
			active: true,
			facade: undefined as unknown as ServiceFacade,
		};
		instance.facade = new ServiceFacade(
			this.#service.id,
			address,
			this.#connection,
			() => instance.active && !this.#closed,
			this.#reportError,
		);
		instance.facade.install(snapshot, context);
		this.#instances.set(address.key, instance);
		if (startTasks && this.#hydrated) {
			for (const observer of this.#observers) this.#startTask(observer, instance);
		}
	}

	#closeInstance(address: ServiceInstanceAddress): void {
		const instance = this.#instances.get(address.key);
		if (instance?.address.generation !== address.generation) return;
		instance.active = false;
		instance.facade.clear();
		this.#instances.delete(address.key);
		const taskKey = instanceTaskKey(address);
		for (const observer of this.#observers) {
			observer.tasks.get(taskKey)?.cancel();
			observer.tasks.delete(taskKey);
		}
	}

	#startTask(observer: ObserverRegistration<T>, instance: KeyedInstance): void {
		if (observer.closed || !instance.active) return;
		const key = instanceTaskKey(instance.address);
		if (observer.tasks.has(key)) return;
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		observer.tasks.set(key, { cancel });
		const exposed = { key: instance.address.key, service: instance.facade.proxy as T };
		try {
			void Promise.resolve(observer.handler(exposed, context)).catch((error: unknown) => {
				if (!context.abortSignal?.aborted) this.#reportError(toError(error));
			});
		} catch (error) {
			if (!context.abortSignal?.aborted) this.#reportError(toError(error));
		}
	}
}

export class RemoteServiceNamespace implements RemoteServiceNamespaceApi {
	readonly #connection: RemoteServiceConnection;
	readonly #allowlist: ReadonlySet<string>;
	readonly #reportError: ErrorReporter;
	readonly #modes = new Map<string, "singleton" | "keyed">();
	readonly #singletons = new Map<string, SingletonBinding>();
	readonly #keyed = new Map<string, KeyedBinding<unknown>>();
	#bound: boolean;
	#disposed = false;

	constructor(options: RemoteServiceNamespaceOptions) {
		this.#connection = options.connection;
		const ids = options.services.map(({ id }) => id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Remote service namespace has duplicate service IDs");
		this.#allowlist = new Set(ids);
		this.#reportError = options.onError ?? (() => {});
		this.#bound = options.bound ?? true;
	}

	use<T>(service: RemoteService<T>): T {
		this.#assertAvailable(service.id, "singleton");
		let binding = this.#singletons.get(service.id);
		if (binding !== undefined) return binding.facade.proxy as T;
		binding = { facade: undefined as unknown as ServiceFacade, active: true, revision: 0 };
		binding.facade = new ServiceFacade(
			service.id,
			undefined,
			this.#connection,
			() => binding!.active && !this.#disposed,
			this.#reportError,
		);
		this.#singletons.set(service.id, binding);
		if (this.#bound) void this.#startSingleton(service.id, binding, binding.revision).catch(this.#reportError);
		return binding.facade.proxy as T;
	}

	observe<T>(
		service: RemoteService<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void {
		this.#assertAvailable(service.id, "keyed");
		let binding = this.#keyed.get(service.id) as KeyedBinding<T> | undefined;
		if (binding === undefined) {
			binding = new KeyedBinding(
				service,
				this.#connection,
				this.#reportError,
				() => {
					if (this.#keyed.get(service.id) !== binding) return;
					this.#keyed.delete(service.id);
					void binding!.close(BACKGROUND_CONTEXT).catch(this.#reportError);
				},
				this.#bound,
			);
			this.#keyed.set(service.id, binding as KeyedBinding<unknown>);
		}
		return binding.observe(handler);
	}

	async rebind(bound: boolean, context: Context): Promise<void> {
		if (this.#disposed) throw new Error("Remote service namespace is disposed");
		this.#bound = bound;
		const transitions: Promise<void>[] = [];
		for (const [serviceId, binding] of this.#singletons) {
			binding.revision += 1;
			binding.facade.clear();
			const subscription = binding.subscription;
			delete binding.subscription;
			const revision = binding.revision;
			transitions.push(
				(async () => {
					await subscription?.close(context);
					if (bound) await this.#startSingleton(serviceId, binding, revision);
				})(),
			);
		}
		for (const binding of this.#keyed.values()) transitions.push(binding.rebind(bound, context));
		const results = await Promise.allSettled(transitions);
		const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (errors.length > 0)
			throw new AggregateError(
				errors.map(({ reason }) => reason),
				"Failed to rebind services",
			);
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const closes: Promise<void>[] = [];
		for (const binding of this.#singletons.values()) {
			binding.active = false;
			binding.facade.clear();
			if (binding.subscription) closes.push(Promise.resolve(binding.subscription.close(context)));
		}
		for (const binding of this.#keyed.values()) closes.push(binding.close(context));
		this.#singletons.clear();
		this.#keyed.clear();
		const results = await Promise.allSettled(closes);
		const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (errors.length > 0)
			throw new AggregateError(
				errors.map(({ reason }) => reason),
				"Failed to dispose services",
			);
	}

	async #startSingleton(serviceId: string, binding: SingletonBinding, revision: number): Promise<void> {
		const subscription = await this.#connection.subscribe(
			serviceId,
			"singleton",
			(update, context) => {
				if (
					!binding.active ||
					binding.revision !== revision ||
					update.type !== "state" ||
					update.instance !== undefined
				) {
					return;
				}
				try {
					binding.facade.update(update.member, update.sequence, update.value, context);
				} catch (error) {
					this.#reportError(toError(error));
				}
			},
			BACKGROUND_CONTEXT,
		);
		if (!binding.active || this.#disposed || !this.#bound || binding.revision !== revision) {
			await subscription.close(BACKGROUND_CONTEXT);
			return;
		}
		binding.subscription = subscription;
		const snapshot = subscription.snapshot;
		if (snapshot.mode !== "singleton" || snapshot.serviceId !== serviceId || snapshot.instances.length !== 1) {
			throw new Error(`Remote service ${serviceId} returned an invalid singleton snapshot`);
		}
		binding.facade.install(snapshot.instances[0]!, freshDeliveryContext());
		subscription.activate();
	}

	#assertAvailable(serviceId: string, mode: "singleton" | "keyed"): void {
		if (this.#disposed) throw new Error("Remote service namespace is disposed");
		if (!this.#allowlist.has(serviceId)) {
			throw new RemoteServiceError("service_not_allowed", `Remote service ${serviceId} is not allowlisted`);
		}
		const existing = this.#modes.get(serviceId);
		if (existing !== undefined && existing !== mode) {
			throw new RemoteServiceError(
				"service_mode_mismatch",
				`Remote service ${serviceId} is already used as ${existing}`,
			);
		}
		this.#modes.set(serviceId, mode);
	}
}

function validateMemberDescriptions(
	descriptions: readonly ServiceMemberDescription[],
): ReadonlyMap<string, ServiceMemberKind> {
	const result = new Map<string, ServiceMemberKind>();
	for (const { name, kind } of descriptions) {
		if (name.length === 0 || result.has(name)) throw new Error("Remote service has invalid member descriptions");
		result.set(name, kind);
	}
	return result;
}

function sameAddress(left: ServiceInstanceAddress | undefined, right: ServiceInstanceAddress | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.key === right.key && left.generation === right.generation;
}

function instanceTaskKey(address: ServiceInstanceAddress): string {
	return `${address.key}\0${address.generation}`;
}

function isContext(value: unknown): value is Context {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<Context>;
	return typeof candidate.value === "function" && typeof candidate.toString === "function";
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
