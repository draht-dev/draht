import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withCancel } from "../../harness/context.ts";
import type { JsonValue } from "../../harness/session/types.ts";
import { RemoteServiceError } from "./provider.ts";
import { freshDeliveryContext } from "./state.ts";
import {
	cloneJson,
	isJsonValue,
	type RemoteEventListener,
	type RemoteEvents,
	type RemoteEventType,
	type RemoteServiceConnection,
	type RemoteServiceInstance,
	type RemoteServiceNamespaceApi,
	type RemoteServiceNamespaceOptions,
	type RemoteServiceSubscription,
	type ReplicatedState,
	type Service,
	type ServiceInstanceAddress,
	type ServiceInstanceSnapshot,
	type ServiceMemberDescription,
	type ServiceMemberKind,
	type ServiceProviderUpdate,
	type ServiceStateSnapshot,
} from "./types.ts";

type ErrorReporter = (error: Error) => void;

class RemoteStateReplica implements ReplicatedState<JsonValue> {
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

	#deliver(listener: (value: JsonValue, context: Context) => void, value: JsonValue, context: Context): void {
		try {
			listener(value, context);
		} catch (error) {
			this.#reportError(toError(error));
		}
	}
}

class RemoteEventsReplica implements RemoteEvents<JsonValue> {
	readonly #listeners = new Set<RemoteEventListener<JsonValue>>();
	readonly #reportError: ErrorReporter;

	constructor(reportError: ErrorReporter) {
		this.#reportError = reportError;
	}

	subscribe(listener: RemoteEventListener<JsonValue>): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	on<TType extends RemoteEventType<JsonValue>>(
		type: TType,
		listener: RemoteEventListener<Extract<JsonValue, { readonly type: TType }>>,
	): () => void {
		return this.subscribe((event, context) => {
			if (hasEventType(event, type)) listener(event, context);
		});
	}

	deliver(event: JsonValue, context: Context): void {
		for (const listener of this.#listeners) {
			try {
				listener(event, context);
			} catch (error) {
				this.#reportError(toError(error));
			}
		}
	}
}

interface PendingMemberSubscription {
	readonly listener: RemoteEventListener<JsonValue>;
	remove: (() => void) | undefined;
	closed: boolean;
}

class MemberSlot {
	readonly #serviceId: string;
	readonly #member: string;
	readonly #invoke: (args: readonly JsonValue[], context: Context) => Promise<JsonValue | undefined>;
	readonly #state: RemoteStateReplica;
	readonly #events: RemoteEventsReplica;
	readonly #isActive: () => boolean;
	readonly #assertAccess: () => void;
	readonly #reportError: ErrorReporter;
	readonly #pendingSubscriptions = new Set<PendingMemberSubscription>();
	readonly value: unknown;
	#kind: ServiceMemberKind | undefined;
	#expectedKind: ServiceMemberKind | undefined;

	constructor(
		serviceId: string,
		member: string,
		invoke: (args: readonly JsonValue[], context: Context) => Promise<JsonValue | undefined>,
		isActive: () => boolean,
		assertAccess: () => void,
		reportError: ErrorReporter,
	) {
		this.#serviceId = serviceId;
		this.#member = member;
		this.#invoke = invoke;
		this.#isActive = isActive;
		this.#assertAccess = assertAccess;
		this.#reportError = reportError;
		this.#state = new RemoteStateReplica(reportError);
		this.#events = new RemoteEventsReplica(reportError);
		const callable = (): void => {};
		this.value = new Proxy(callable, {
			apply: (_target, _thisArg, args) => this.#call(args),
			get: (_target, property) => {
				if (property === "value") {
					this.#assertAccess();
					this.#expect("state");
					return this.#state.value;
				}
				if (property === "subscribe") return this.#subscribe.bind(this);
				if (property === "on") return this.#on.bind(this);
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
		for (const pending of this.#pendingSubscriptions) this.#activateSubscription(pending, kind);
		this.#pendingSubscriptions.clear();
	}

	hydrate(snapshot: ServiceStateSnapshot, context: Context): void {
		this.setDescription("state");
		this.#state.hydrate(snapshot, context);
	}

	update(sequence: number, value: JsonValue, context: Context): void {
		this.setDescription("state");
		this.#state.update(sequence, value, context);
	}

	deliverEvent(event: JsonValue, context: Context): void {
		this.setDescription("events");
		this.#events.deliver(event, context);
	}

	clear(): void {
		this.#state.clear();
	}

	#subscribe(listener: RemoteEventListener<JsonValue>): () => void {
		this.#assertAccess();
		if (typeof listener !== "function")
			throw new TypeError("Remote service subscription listener must be a function");
		if (this.#kind === "state" || this.#expectedKind === "state") {
			this.#expect("state");
			return this.#state.subscribe(listener);
		}
		if (this.#kind === "events" || this.#expectedKind === "events") {
			this.#expect("events");
			return this.#events.subscribe(listener);
		}
		const pending: PendingMemberSubscription = { listener, remove: undefined, closed: false };
		this.#pendingSubscriptions.add(pending);
		return () => {
			if (pending.closed) return;
			pending.closed = true;
			pending.remove?.();
			this.#pendingSubscriptions.delete(pending);
		};
	}

	#on(type: string, listener: RemoteEventListener<JsonValue>): () => void {
		this.#assertAccess();
		this.#expect("events");
		return this.#events.subscribe((event, context) => {
			if (hasEventType(event, type)) listener(event, context);
		});
	}

	#activateSubscription(pending: PendingMemberSubscription, kind: ServiceMemberKind): void {
		if (pending.closed) return;
		if (kind === "state") pending.remove = this.#state.subscribe(pending.listener);
		else if (kind === "events") pending.remove = this.#events.subscribe(pending.listener);
		else {
			pending.closed = true;
			this.#reportError(
				new RemoteServiceError(
					"service_member_mismatch",
					`Remote service member ${this.#serviceId}.${this.#member} is a method, not subscribable`,
				),
			);
		}
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
		this.#assertAccess();
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
	readonly #assertAccess: () => void;
	readonly proxy: object;

	constructor(
		serviceId: string,
		address: ServiceInstanceAddress | undefined,
		connection: RemoteServiceConnection,
		isActive: () => boolean,
		assertAccess: () => void,
		reportError: ErrorReporter,
	) {
		this.#serviceId = serviceId;
		this.#address = address;
		this.#connection = connection;
		this.#isActive = isActive;
		this.#assertAccess = assertAccess;
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

	deliverEvent(member: string, event: JsonValue, context: Context): void {
		if (this.#descriptions.get(member) !== "events") {
			throw new Error(`Remote service event targets non-event member ${this.#serviceId}.${member}`);
		}
		this.#slot(member).deliverEvent(event, context);
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
			this.#assertAccess,
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
	starting?: Promise<void>;
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
	readonly #service: Service<T>;
	readonly #connection: RemoteServiceConnection;
	readonly #reportError: ErrorReporter;
	readonly #assertAccess: () => void;
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
		service: Service<T>,
		connection: RemoteServiceConnection,
		reportError: ErrorReporter,
		assertAccess: () => void,
		onEmpty: () => void,
		bound: boolean,
	) {
		this.#service = service;
		this.#connection = connection;
		this.#reportError = reportError;
		this.#assertAccess = assertAccess;
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
		if (this.#bound && this.#starting === undefined) {
			const revision = this.#revision;
			const starting = this.#start(revision);
			this.#starting = starting;
			void starting.catch((error: unknown) => {
				if (!this.#closed && this.#revision === revision && this.#bound) this.#reportError(toError(error));
			});
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
		const revision = ++this.#revision;
		await this.#reset(context, false);
		if (this.#closed || this.#revision !== revision || this.#bound !== bound) return;
		if (bound && this.#observers.size > 0) {
			const starting = this.#start(revision);
			this.#starting = starting;
			await starting;
		}
	}

	ready(): Promise<void> {
		return this.#starting ?? Promise.resolve();
	}

	async close(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#revision += 1;
		await this.#reset(context, true);
		for (const observer of this.#observers) observer.closed = true;
		this.#observers.clear();
	}

	async #reset(context: Context, waitForStarting: boolean): Promise<void> {
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
		const starting = this.#starting;
		this.#starting = undefined;
		const subscription = this.#subscription;
		this.#subscription = undefined;
		await Promise.all([
			waitForStarting ? starting?.catch(() => {}) : undefined,
			subscription === undefined ? undefined : subscription.close(context),
		]);
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
				case "event": {
					if (update.instance === undefined) throw new Error("Keyed event has no instance address");
					const instance = this.#instances.get(update.instance.key);
					if (instance?.address.generation !== update.instance.generation) return;
					instance.facade.deliverEvent(update.member, update.event, context);
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
			this.#assertAccess,
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
	#assertAccess: () => void;
	readonly #singletons = new Map<string, SingletonBinding>();
	readonly #keyed = new Map<string, KeyedBinding<unknown>>();
	#bound: boolean;
	#readinessRevision = 0;
	#bindingTransition = Promise.resolve();
	#disposed = false;

	constructor(options: RemoteServiceNamespaceOptions) {
		this.#connection = options.connection;
		const ids = options.services.map(({ id }) => id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Remote service namespace has duplicate service IDs");
		this.#allowlist = new Set(ids);
		this.#reportError = options.onError ?? (() => {});
		this.#assertAccess = options.assertAccess ?? (() => {});
		this.#bound = options.bound ?? true;
	}

	use<T>(service: Service<T>): T {
		this.#assertAvailable(service.id, "singleton");
		let binding = this.#singletons.get(service.id);
		if (binding !== undefined) return binding.facade.proxy as T;
		binding = { facade: undefined as unknown as ServiceFacade, active: true, revision: 0 };
		binding.facade = new ServiceFacade(
			service.id,
			undefined,
			this.#connection,
			() => binding!.active && !this.#disposed && this.#bound,
			() => this.#assertAccess(),
			this.#reportError,
		);
		this.#singletons.set(service.id, binding);
		this.#readinessRevision += 1;
		if (this.#bound) {
			const revision = binding.revision;
			const starting = this.#startSingleton(service.id, binding, revision);
			binding.starting = starting;
			void starting.catch((error: unknown) => {
				if (binding.active && binding.revision === revision && !this.#disposed && this.#bound) {
					this.#reportError(toError(error));
				}
			});
		}
		return binding.facade.proxy as T;
	}

	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void {
		this.#assertAvailable(service.id, "keyed");
		let binding = this.#keyed.get(service.id) as KeyedBinding<T> | undefined;
		if (binding === undefined) {
			binding = new KeyedBinding(
				service,
				this.#connection,
				this.#reportError,
				() => this.#assertAccess(),
				() => {
					if (this.#keyed.get(service.id) !== binding) return;
					this.#keyed.delete(service.id);
					this.#readinessRevision += 1;
					void binding!.close(BACKGROUND_CONTEXT).catch(this.#reportError);
				},
				this.#bound,
			);
			this.#keyed.set(service.id, binding as KeyedBinding<unknown>);
			this.#readinessRevision += 1;
		}
		return binding.observe(handler);
	}

	setAccessGuard(assertAccess: () => void): void {
		this.#assertAccess = assertAccess;
	}

	async ready(context: Context): Promise<void> {
		if (this.#disposed) throw new Error("Remote service namespace is disposed");
		while (true) {
			const revision = this.#readinessRevision;
			const starts = [
				this.#bindingTransition,
				...[...this.#singletons.values()].flatMap((binding) =>
					binding.starting === undefined ? [] : [binding.starting],
				),
				...[...this.#keyed.values()].map((binding) => binding.ready()),
			];
			await awaitWithContext(
				Promise.all(starts).then(() => undefined),
				context,
			);
			if (this.#disposed) throw new Error("Remote service namespace is disposed");
			if (revision === this.#readinessRevision) return;
		}
	}

	async rebind(bound: boolean, context: Context): Promise<void> {
		if (this.#disposed) throw new Error("Remote service namespace is disposed");
		this.#bound = bound;
		this.#readinessRevision += 1;
		const transitions: Promise<void>[] = [];
		for (const [serviceId, binding] of this.#singletons) {
			binding.revision += 1;
			binding.facade.clear();
			const subscription = binding.subscription;
			delete binding.subscription;
			const revision = binding.revision;
			const starting = (async () => {
				await subscription?.close(context);
				if (bound) await this.#startSingleton(serviceId, binding, revision);
			})();
			binding.starting = starting;
			transitions.push(starting);
		}
		for (const binding of this.#keyed.values()) transitions.push(binding.rebind(bound, context));
		const completion = (async () => {
			const results = await Promise.allSettled(transitions);
			const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			if (errors.length > 0)
				throw new AggregateError(
					errors.map(({ reason }) => reason),
					"Failed to rebind services",
				);
		})();
		this.#bindingTransition = completion;
		await completion;
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const closes: Promise<void>[] = [];
		for (const binding of this.#singletons.values()) {
			binding.active = false;
			binding.facade.clear();
			if (binding.starting) closes.push(binding.starting.catch(() => {}));
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
				if (!binding.active || binding.revision !== revision || update.instance !== undefined) return;
				try {
					if (update.type === "state") {
						binding.facade.update(update.member, update.sequence, update.value, context);
					} else if (update.type === "event") {
						binding.facade.deliverEvent(update.member, update.event, context);
					}
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

function hasEventType<T, TType extends string>(event: T, type: TType): event is Extract<T, { readonly type: TType }> {
	return typeof event === "object" && event !== null && "type" in event && event.type === type;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
