import {
	BACKGROUND_CONTEXT,
	type Context,
	type MutableReplicatedState,
	type RemoteServiceContract,
	type RemoteServiceInstance,
	RemoteServiceProvider,
	type RemoteServices,
	replicatedState,
	type Service,
	type ServiceCatalogueEntry,
	type ServiceMode,
	withCancel,
} from "@draht/agent-core";

export interface ServiceInstances<T> {
	add(key: string, implementation: T): () => void;
}

interface FacetServiceReference {
	readonly serviceId: string;
	readonly mode: ServiceMode;
}

interface FacetRecord {
	readonly facetId: string;
	readonly requires: readonly FacetServiceReference[];
	readonly provides: readonly FacetServiceReference[];
}

export interface FacetEnvironment {
	/**
	 * Declare a hard dependency on one singleton service and return its stable handle.
	 *
	 * Call this synchronously during setup so the host can validate and order the complete
	 * dependency graph before activation. The handle cannot be accessed during setup. It
	 * binds when the host activates and follows later provider-facet replacements, whether
	 * the implementation is process-local or reached through RPC.
	 */
	use<T>(service: Service<T>): T;

	/**
	 * Declare a hard dependency on a keyed service and observe each live instance.
	 *
	 * The host starts the handler after the instance and its replicated state have hydrated.
	 * The handler receives a context that is aborted when that instance closes or is replaced.
	 * The returned idempotent function stops this observation early; otherwise the facet owns
	 * it automatically. Use keyed services when instances appear and disappear at runtime.
	 */
	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;

	/**
	 * Declare and install this facet's singleton implementation of a service.
	 *
	 * Call this synchronously during setup. The declaration lets the host reject duplicate
	 * providers and order consumers after this facet. Remotable tokens are published
	 * automatically; `{ local: true }` tokens remain process-local. Reloading this facet swaps
	 * the implementation behind existing consumer handles.
	 */
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;

	/**
	 * Declare ownership of a keyed service and return the handle used to add live instances.
	 *
	 * Declaring ownership during setup makes the service discoverable even while it has no
	 * instances. Instances may be added only while the facet is active and are closed
	 * automatically when the facet deactivates.
	 */
	provideMany<T>(service: Service<T>): ServiceInstances<T>;

	/**
	 * Create initialized mutable state suitable for exposing through a service implementation.
	 *
	 * Remote consumers receive a stable read-only replica that hydrates from this value and
	 * follows later updates. This is live projection state, not durable storage; the facet must
	 * be able to reconstruct it after reload or process restart.
	 */
	replicatedState<T>(initial: T): MutableReplicatedState<T>;

	/**
	 * Give the facet ownership of a resource cleanup function.
	 *
	 * Cleanups run once in reverse registration order during deactivation and startup-failure
	 * cleanup. Register every subscription, timer, process, file, or contribution here so a
	 * failed or reloaded facet cannot leak resources into its replacement.
	 */
	own(disposal: () => void | Promise<void>): void;

	/**
	 * Register asynchronous initialization to run after dependencies are bound and ready.
	 *
	 * Setup itself must stay synchronous because it declares the graph. Put I/O, hydration,
	 * and other effects here. Provider facets activate before facets that consume them.
	 */
	onActivate(callback: () => void | Promise<void>): void;

	/**
	 * Register final facet teardown.
	 *
	 * The callback runs after resources acquired during activation have been released. Use it
	 * for shutdown work that is not naturally represented by an individual `own()` cleanup.
	 */
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export function defineFacet(facet: Facet): Facet {
	return facet;
}

type LifecycleState = "setting_up" | "prepared" | "active" | "disposing" | "dead";
type GenerationPhase =
	| "setup"
	| "assembling"
	| "connecting"
	| "activating"
	| "active"
	| "reloading"
	| "disposing"
	| "dead";
type Disposal = () => void | Promise<void>;

class FacetLifecycle {
	readonly id: string;
	readonly #effects: Disposal[] = [];
	readonly #observations: Array<() => Disposal> = [];
	readonly #activate: Array<() => void | Promise<void>> = [];
	#state: LifecycleState = "setting_up";

	constructor(id: string) {
		this.id = id;
	}

	assertSettingUp(operation: string): void {
		if (this.#state !== "setting_up") {
			throw new Error(`Facet ${this.id} can ${operation} only during setup`);
		}
	}

	assertRunning(operation: string): void {
		if (this.#state !== "setting_up" && this.#state !== "active") {
			throw new Error(`Facet ${this.id} cannot ${operation} while ${this.#state}`);
		}
	}

	assertActive(operation: string): void {
		if (this.#state !== "active") throw new Error(`Facet ${this.id} can ${operation} only while active`);
	}

	own(disposal: Disposal): void {
		this.assertRunning("own resources");
		this.#effects.push(disposal);
	}

	observe(start: () => Disposal): void {
		this.assertSettingUp("observe services");
		this.#observations.push(start);
	}

	onActivate(callback: () => void | Promise<void>): void {
		this.assertSettingUp("register activation callbacks");
		this.#activate.push(callback);
	}

	prepared(): void {
		this.assertSettingUp("finish setup");
		this.#state = "prepared";
	}

	async activate(): Promise<void> {
		if (this.#state !== "prepared") throw new Error(`Facet ${this.id} is not prepared`);
		this.#state = "active";
		for (const start of this.#observations) this.#effects.push(start());
		for (const callback of this.#activate) await callback();
	}

	async dispose(): Promise<void> {
		if (this.#state === "dead") return;
		this.#state = "disposing";
		const errors: unknown[] = [];
		for (const effect of this.#effects.splice(0).reverse()) {
			try {
				await effect();
			} catch (error) {
				errors.push(error);
			}
		}
		this.#observations.length = 0;
		this.#activate.length = 0;
		this.#state = "dead";
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, `Failed to dispose facet ${this.id}`);
	}
}

class FacetLedger {
	readonly #facetId: string;
	readonly #requires = new Map<string, FacetServiceReference>();
	readonly #provides = new Map<string, FacetServiceReference>();

	constructor(facetId: string) {
		this.#facetId = facetId;
	}

	require(service: { readonly id: string }, mode: ServiceMode): void {
		this.#record(this.#requires, service, mode);
	}

	provide(service: { readonly id: string }, mode: ServiceMode): void {
		this.#record(this.#provides, service, mode);
	}

	record(): FacetRecord {
		return Object.freeze({
			facetId: this.#facetId,
			requires: Object.freeze([...this.#requires.values()]),
			provides: Object.freeze([...this.#provides.values()]),
		});
	}

	#record(target: Map<string, FacetServiceReference>, service: { readonly id: string }, mode: ServiceMode): void {
		const reference = Object.freeze({ serviceId: service.id, mode });
		target.set(referenceKey(reference), reference);
	}
}

class FacetServiceHandle {
	readonly #serviceId: string;
	readonly #assertAccess: () => void;
	readonly #methods = new Map<PropertyKey, unknown>();
	readonly proxy: object;
	#implementation: object | undefined;
	#remote = false;

	constructor(serviceId: string, assertAccess: () => void) {
		this.#serviceId = serviceId;
		this.#assertAccess = assertAccess;
		this.proxy = new Proxy(
			{},
			{
				get: (_target, property) => {
					this.#assertAccess();
					if (this.#implementation === undefined) throw new Error(`Service ${this.#serviceId} is disconnected`);
					const value: unknown = Reflect.get(this.#implementation, property, this.#implementation);
					if (this.#remote || typeof value !== "function") return value;
					let method = this.#methods.get(property);
					if (method === undefined) {
						method = (...args: unknown[]) => {
							this.#assertAccess();
							if (this.#implementation === undefined) {
								throw new Error(`Service ${this.#serviceId} is disconnected`);
							}
							const current: unknown = Reflect.get(this.#implementation, property, this.#implementation);
							if (typeof current !== "function") {
								throw new TypeError(`Service ${this.#serviceId}.${String(property)} is not a method`);
							}
							return Reflect.apply(current, this.#implementation, args);
						};
						this.#methods.set(property, method);
					}
					return method;
				},
			},
		);
	}

	bind(implementation: object, remote = false): void {
		this.#implementation = implementation;
		this.#remote = remote;
	}

	unbind(): void {
		this.#implementation = undefined;
		this.#remote = false;
	}
}

interface StagedObservation {
	start(): () => void;
	stop(): void;
}

interface KeyedServiceSource {
	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
}

interface LocalKeyedInstance {
	readonly key: string;
	readonly generation: number;
	readonly handle: FacetServiceHandle;
}

interface LocalKeyedObserver {
	readonly handler: (instance: RemoteServiceInstance<unknown>, context: Context) => void | Promise<void>;
	readonly tasks: Map<string, { readonly cancel: (reason?: unknown) => void }>;
	closed: boolean;
}

interface LocalKeyedRegistration {
	readonly serviceId: string;
	readonly generations: Map<string, number>;
	readonly instances: Map<string, LocalKeyedInstance>;
	readonly observers: Set<LocalKeyedObserver>;
}

class LocalKeyedServiceRegistry implements KeyedServiceSource {
	readonly #registrations = new Map<string, LocalKeyedRegistration>();
	readonly #assertAccess: () => void;
	readonly #onError: (error: Error) => void;
	#disposed = false;

	constructor(
		services: readonly { readonly id: string }[],
		assertAccess: () => void,
		onError: (error: Error) => void,
	) {
		const ids = services.map(({ id }) => id);
		if (new Set(ids).size !== ids.length) throw new TypeError("Local keyed service registry has duplicate IDs");
		for (const serviceId of ids) {
			this.#registrations.set(serviceId, {
				serviceId,
				generations: new Map(),
				instances: new Map(),
				observers: new Set(),
			});
		}
		this.#assertAccess = assertAccess;
		this.#onError = onError;
	}

	spawn<T>(service: Service<T>, key: string, implementation: T): () => void {
		this.#assertActive();
		if (key.length === 0) throw new TypeError("Local service instance key must not be empty");
		if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
			throw new TypeError(`Local service ${service.id} implementation must be an object`);
		}
		const registration = this.#registration(service.id);
		if (registration.instances.has(key)) {
			throw new Error(`Local service ${service.id} already has a live instance with key ${key}`);
		}
		const generation = (registration.generations.get(key) ?? 0) + 1;
		registration.generations.set(key, generation);
		const handle = new FacetServiceHandle(service.id, this.#assertAccess);
		handle.bind(implementation);
		const instance = { key, generation, handle };
		registration.instances.set(key, instance);
		for (const observer of registration.observers) this.#startTask(observer, instance);
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			if (registration.instances.get(key) !== instance) return;
			registration.instances.delete(key);
			instance.handle.unbind();
			const taskKey = localInstanceTaskKey(instance);
			for (const observer of registration.observers) {
				observer.tasks.get(taskKey)?.cancel();
				observer.tasks.delete(taskKey);
			}
		};
	}

	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void {
		this.#assertActive();
		const registration = this.#registration(service.id);
		const observer: LocalKeyedObserver = {
			handler: handler as unknown as LocalKeyedObserver["handler"],
			tasks: new Map(),
			closed: false,
		};
		registration.observers.add(observer);
		for (const instance of registration.instances.values()) this.#startTask(observer, instance);
		return () => {
			if (observer.closed) return;
			observer.closed = true;
			for (const task of observer.tasks.values()) task.cancel();
			observer.tasks.clear();
			registration.observers.delete(observer);
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const registration of this.#registrations.values()) {
			for (const observer of registration.observers) {
				observer.closed = true;
				for (const task of observer.tasks.values()) task.cancel();
				observer.tasks.clear();
			}
			registration.observers.clear();
			for (const instance of registration.instances.values()) instance.handle.unbind();
			registration.instances.clear();
		}
		this.#registrations.clear();
	}

	#startTask(observer: LocalKeyedObserver, instance: LocalKeyedInstance): void {
		if (observer.closed) return;
		const taskKey = localInstanceTaskKey(instance);
		if (observer.tasks.has(taskKey)) return;
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		observer.tasks.set(taskKey, { cancel });
		try {
			void Promise.resolve(observer.handler({ key: instance.key, service: instance.handle.proxy }, context)).catch(
				(error: unknown) => {
					if (!context.abortSignal?.aborted) this.#onError(toError(error));
				},
			);
		} catch (error) {
			if (!context.abortSignal?.aborted) this.#onError(toError(error));
		}
	}

	#registration(serviceId: string): LocalKeyedRegistration {
		const registration = this.#registrations.get(serviceId);
		if (registration === undefined) throw new Error(`Local keyed service ${serviceId} is not registered`);
		return registration;
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Local keyed service registry is disposed");
	}
}

class FacetServiceHandles {
	readonly #assertAccess: () => void;
	readonly #singletons = new Map<string, FacetServiceHandle>();
	readonly #singletonServices = new Map<string, Service<unknown>>();
	readonly #keyedSources = new Map<string, KeyedServiceSource>();

	constructor(assertAccess: () => void) {
		this.#assertAccess = assertAccess;
	}

	use<T>(service: Service<T>): T {
		let handle = this.#singletons.get(service.id);
		if (handle === undefined) {
			handle = new FacetServiceHandle(service.id, this.#assertAccess);
			this.#singletons.set(service.id, handle);
			this.#singletonServices.set(service.id, service as Service<unknown>);
		}
		return handle.proxy as T;
	}

	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): StagedObservation {
		let close: (() => void) | undefined;
		let closed = false;
		const stop = (): void => {
			if (closed) return;
			closed = true;
			close?.();
		};
		return {
			start: () => {
				if (closed) return () => {};
				const source = this.#keyedSources.get(service.id);
				if (source === undefined) throw new Error(`Service ${service.id} is disconnected`);
				close = source.observe(service, handler);
				return stop;
			},
			stop,
		};
	}

	bindSingleton(serviceId: string, implementation: object): void {
		this.#singletons.get(serviceId)?.bind(implementation);
	}

	unbindSingleton(serviceId: string): void {
		this.#singletons.get(serviceId)?.unbind();
	}

	bindRemoteSingleton(serviceId: string, services: RemoteServices): void {
		const handle = this.#singletons.get(serviceId);
		const service = this.#singletonServices.get(serviceId);
		if (handle === undefined || service === undefined)
			throw new Error(`Service ${serviceId} has no singleton handle`);
		handle.bind(services.use(service) as object, true);
	}

	bindKeyed(serviceId: string, services: KeyedServiceSource): void {
		this.#keyedSources.set(serviceId, services);
	}

	dispose(): void {
		for (const handle of this.#singletons.values()) handle.unbind();
		this.#singletons.clear();
		this.#singletonServices.clear();
		this.#keyedSources.clear();
	}
}

type ServiceInstanceInstaller<T> = (key: string, implementation: T) => () => void;

class StagedServiceInstances<T> implements ServiceInstances<T> {
	readonly #lifecycle: FacetLifecycle;
	readonly #installers: ServiceInstanceInstaller<T>[] = [];

	constructor(lifecycle: FacetLifecycle) {
		this.#lifecycle = lifecycle;
	}

	connect(installer: ServiceInstanceInstaller<T>): void {
		this.#installers.push(installer);
	}

	add(key: string, implementation: T): () => void {
		this.#lifecycle.assertActive("add service instances");
		if (this.#installers.length === 0) throw new Error("Facet service provider is not connected");
		const closes: Array<() => void> = [];
		try {
			for (const install of this.#installers) closes.push(install(key, implementation));
		} catch (error) {
			for (const close of closes.reverse()) close();
			throw error;
		}
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			for (const release of closes.reverse()) release();
		};
		this.#lifecycle.own(close);
		return close;
	}
}

interface SingletonProvision {
	readonly facetId: string;
	readonly service: { readonly id: string; readonly local: boolean };
	readonly implementation: object;
	install(provider: RemoteServiceProvider): void;
	withdraw(provider: RemoteServiceProvider): void;
	replace(provider: RemoteServiceProvider): void;
}

interface KeyedProvision {
	readonly facetId: string;
	readonly service: { readonly id: string; readonly local: boolean };
	connectLocal(registry: LocalKeyedServiceRegistry): void;
	connectRemote(provider: RemoteServiceProvider): void;
}

export interface FacetConnection {
	/** Whether this currently unavailable route may provisionally own requirements absent from its catalogue. */
	readonly acceptsUnavailableServices: boolean;
	catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]>;
	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices;
}

interface FacetOptions {
	readonly facets: readonly Facet[];
	readonly connections?: readonly FacetConnection[];
	readonly onError?: (error: Error) => void;
}

export interface FacetHost {
	readonly services: RemoteServiceProvider;
	/** Replace active facets with matching IDs while preserving consumer service handles. */
	reload(facets: readonly Facet[]): Promise<void>;
	dispose(): Promise<void>;
}

/** Create an active host for one complete set of facets. */
export async function createFacetHost(options: FacetOptions): Promise<FacetHost> {
	const kernel = new FacetKernel(options);
	await kernel.activate();
	return Object.freeze({
		services: kernel.provider,
		reload: (facets: readonly Facet[]) => kernel.reload(facets),
		dispose: () => kernel.dispose(),
	});
}

/** Private lifecycle and dependency kernel behind the atomic host entry point. */
class FacetKernel {
	readonly #facets: readonly Facet[];
	readonly #connections: readonly FacetConnection[];
	readonly #onError: (error: Error) => void;
	readonly #lifecycles = new Map<string, FacetLifecycle>();
	readonly #records = new Map<string, FacetRecord>();
	readonly #singletons: SingletonProvision[] = [];
	readonly #keyed: KeyedProvision[] = [];
	readonly #handles: FacetServiceHandles;
	readonly #connectionBindings = new Map<FacetConnection, RemoteServices>();
	#activationOrder: readonly string[] = [];
	#provider: RemoteServiceProvider | undefined;
	#localKeyedServices: LocalKeyedServiceRegistry | undefined;
	#phase: GenerationPhase = "setup";

	constructor(options: FacetOptions) {
		const ids = options.facets.map((facet) => facet.id);
		if (ids.some((id) => id.length === 0)) throw new Error("Facet ID must not be empty");
		if (new Set(ids).size !== ids.length) throw new Error("Facet IDs must be unique within a generation");
		this.#facets = options.facets;
		this.#connections = options.connections ?? [];
		this.#onError = options.onError ?? (() => {});
		this.#handles = new FacetServiceHandles(() => this.#assertServiceAccess());
	}

	get provider(): RemoteServiceProvider {
		if (this.#provider === undefined) throw new Error("Facet service provider is not assembled");
		return this.#provider;
	}

	async activate(): Promise<void> {
		const records: FacetRecord[] = [];
		try {
			for (const facet of this.#facets) {
				const lifecycle = new FacetLifecycle(facet.id);
				const ledger = new FacetLedger(facet.id);
				this.#lifecycles.set(facet.id, lifecycle);
				const result: unknown = facet.setup(this.#environment(lifecycle, ledger));
				if (isPromiseLike(result)) {
					void Promise.resolve(result).catch(() => {});
					throw new Error(`Facet ${facet.id} setup must be synchronous`);
				}
				lifecycle.prepared();
				const record = ledger.record();
				records.push(record);
				this.#records.set(record.facetId, record);
			}

			this.#phase = "assembling";
			const externalServices = await this.#resolveExternalServices(records);
			this.#activationOrder = validateFacets(records, externalServices);
			this.#assembleProviders();
			this.#bindServices(externalServices);

			this.#phase = "connecting";
			await Promise.all(
				[...this.#connectionBindings.values()].map((services) => services.activate(BACKGROUND_CONTEXT)),
			);

			this.#phase = "activating";
			for (const id of this.#activationOrder) await this.#lifecycles.get(id)!.activate();
			this.#phase = "active";
		} catch (error) {
			const cleanupErrors = await this.#disposeLifecycles();
			this.#phase = "disposing";
			try {
				await this.#localKeyedServices?.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			cleanupErrors.push(...(await this.#disposeConnectionBindings()));
			this.#handles.dispose();
			this.#provider?.dispose();
			this.#phase = "dead";
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Facet generation startup and cleanup failed");
			}
			throw error;
		}
	}

	async reload(facets: readonly Facet[]): Promise<void> {
		if (this.#phase !== "active") throw new Error(`Facet host cannot reload while ${this.#phase}`);
		const ids = facets.map(({ id }) => id);
		if (ids.some((id) => id.length === 0)) throw new Error("Facet ID must not be empty");
		if (new Set(ids).size !== ids.length) throw new Error("Reloaded facet IDs must be unique");
		for (const id of ids) {
			if (!this.#records.has(id)) throw new Error(`Facet ${id} is not active`);
		}
		this.#phase = "reloading";

		const stagedLifecycles: FacetLifecycle[] = [];
		const candidates: Array<{
			readonly lifecycle: FacetLifecycle;
			readonly record: FacetRecord;
			readonly singletons: SingletonProvision[];
			readonly keyed: KeyedProvision[];
		}> = [];
		try {
			for (const facet of facets) {
				const lifecycle = new FacetLifecycle(facet.id);
				stagedLifecycles.push(lifecycle);
				const ledger = new FacetLedger(facet.id);
				const singletons: SingletonProvision[] = [];
				const keyed: KeyedProvision[] = [];
				const result: unknown = facet.setup(this.#environment(lifecycle, ledger, singletons, keyed));
				if (isPromiseLike(result)) {
					void Promise.resolve(result).catch(() => {});
					throw new Error(`Facet ${facet.id} setup must be synchronous`);
				}
				lifecycle.prepared();
				const record = ledger.record();
				const previous = this.#records.get(facet.id)!;
				if (!sameFacetShape(previous, record)) {
					throw new Error(`Reloaded facet ${facet.id} must preserve its service requirements and provisions`);
				}
				this.#validateReplacementProvisions(singletons, keyed);
				candidates.push({ lifecycle, record, singletons, keyed });
			}
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			for (const lifecycle of stagedLifecycles.reverse()) {
				try {
					await lifecycle.dispose();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			this.#phase = "active";
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Facet reload setup and cleanup failed");
			}
			throw error;
		}

		const replacements = new Map(candidates.map((candidate) => [candidate.record.facetId, candidate]));
		for (const candidate of candidates) {
			for (const provision of candidate.singletons) {
				this.#handles.unbindSingleton(provision.service.id);
				if (!provision.service.local) provision.withdraw(this.provider);
			}
		}
		const disposalErrors: unknown[] = [];
		for (const id of [...this.#activationOrder].reverse()) {
			if (!replacements.has(id)) continue;
			const lifecycle = this.#lifecycles.get(id)!;
			this.#lifecycles.delete(id);
			try {
				await lifecycle.dispose();
			} catch (error) {
				disposalErrors.push(error);
			}
		}
		if (disposalErrors.length > 0) {
			for (const { lifecycle } of candidates.reverse()) {
				try {
					await lifecycle.dispose();
				} catch (error) {
					disposalErrors.push(error);
				}
			}
			this.#phase = "active";
			throw new AggregateError(disposalErrors, "Failed to deactivate reloaded facets");
		}

		for (let index = this.#singletons.length - 1; index >= 0; index--) {
			if (replacements.has(this.#singletons[index]!.facetId)) this.#singletons.splice(index, 1);
		}
		for (let index = this.#keyed.length - 1; index >= 0; index--) {
			if (replacements.has(this.#keyed[index]!.facetId)) this.#keyed.splice(index, 1);
		}

		this.#phase = "activating";
		try {
			for (const candidate of candidates) {
				for (const provision of candidate.keyed) {
					provision.connectLocal(this.#localKeyedRegistry);
					if (!provision.service.local) provision.connectRemote(this.provider);
				}
				this.#singletons.push(...candidate.singletons);
				this.#keyed.push(...candidate.keyed);
				this.#lifecycles.set(candidate.record.facetId, candidate.lifecycle);
				this.#records.set(candidate.record.facetId, candidate.record);
			}
			for (const id of this.#activationOrder) {
				const candidate = replacements.get(id);
				if (candidate === undefined) continue;
				await candidate.lifecycle.activate();
				for (const provision of candidate.singletons) {
					this.#handles.bindSingleton(provision.service.id, provision.implementation);
					if (!provision.service.local) provision.replace(this.provider);
				}
			}
		} finally {
			this.#phase = "active";
		}
	}

	async dispose(): Promise<void> {
		if (this.#phase === "dead") return;
		if (this.#phase === "reloading") throw new Error("Facet host cannot be disposed while reloading");
		const errors = await this.#disposeLifecycles();
		this.#phase = "disposing";
		try {
			await this.#localKeyedServices?.dispose();
		} catch (error) {
			errors.push(error);
		}
		errors.push(...(await this.#disposeConnectionBindings()));
		this.#handles.dispose();
		this.#provider?.dispose();
		this.#phase = "dead";
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose facet generation");
	}

	#validateReplacementProvisions(singletons: readonly SingletonProvision[], keyed: readonly KeyedProvision[]): void {
		const definitions = [
			...singletons
				.filter(({ service }) => !service.local)
				.map(({ service }) => ({ service, mode: "singleton" as const })),
			...keyed.filter(({ service }) => !service.local).map(({ service }) => ({ service, mode: "keyed" as const })),
		];
		const provider = new RemoteServiceProvider(definitions);
		try {
			for (const provision of singletons) {
				if (!provision.service.local) provision.install(provider);
			}
		} finally {
			provider.dispose();
		}
	}

	#environment(
		lifecycle: FacetLifecycle,
		ledger: FacetLedger,
		singletons: SingletonProvision[] = this.#singletons,
		keyed: KeyedProvision[] = this.#keyed,
	): FacetEnvironment {
		return {
			provide: <T>(service: Service<T>, implementation: NoInfer<T>): void => {
				lifecycle.assertSettingUp("provide services");
				if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
					throw new TypeError(`Service ${service.id} implementation must be an object`);
				}
				ledger.provide(service, "singleton");
				singletons.push({
					facetId: lifecycle.id,
					service,
					implementation,
					install: (provider) => provider.provide(service, implementation as NoInfer<RemoteServiceContract<T>>),
					withdraw: (provider) => provider.withdraw(service),
					replace: (provider) => provider.replace(service, implementation as NoInfer<RemoteServiceContract<T>>),
				});
			},
			provideMany: <T>(service: Service<T>): ServiceInstances<T> => {
				lifecycle.assertSettingUp("provide service instances");
				ledger.provide(service, "keyed");
				const instances = new StagedServiceInstances<T>(lifecycle);
				keyed.push({
					facetId: lifecycle.id,
					service,
					connectLocal: (registry) =>
						instances.connect((key, implementation) => registry.spawn(service, key, implementation)),
					connectRemote: (provider) =>
						instances.connect((key, implementation) =>
							provider.spawn(service, key, implementation as NoInfer<RemoteServiceContract<T>>),
						),
				});
				return instances;
			},
			use: <T>(service: Service<T>): T => {
				lifecycle.assertSettingUp("acquire services");
				ledger.require(service, "singleton");
				return this.#handles.use(service);
			},
			observe: <T>(
				service: Service<T>,
				handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
			): (() => void) => {
				lifecycle.assertSettingUp("observe services");
				ledger.require(service, "keyed");
				const observation = this.#handles.observe(service, handler);
				lifecycle.observe(() => observation.start());
				return observation.stop;
			},
			replicatedState: <T>(initial: T) => {
				lifecycle.assertRunning("create replicated state");
				return replicatedState(initial);
			},
			own: (disposal) => lifecycle.own(disposal),
			onActivate: (callback) => lifecycle.onActivate(callback),
			onDeactivate: (callback) => lifecycle.own(callback),
		};
	}

	async #resolveExternalServices(
		records: readonly FacetRecord[],
	): Promise<ReadonlyMap<string, { readonly mode: ServiceMode; readonly connection: FacetConnection }>> {
		const catalogues = await Promise.all(
			this.#connections.map(async (connection) => ({
				connection,
				entries: await connection.catalogue(BACKGROUND_CONTEXT),
			})),
		);
		const offered = new Map<string, { readonly mode: ServiceMode; readonly connection: FacetConnection }>();
		for (const { connection, entries } of catalogues) {
			for (const { serviceId, mode } of entries) {
				if (offered.has(serviceId)) {
					throw new Error(`Facet host service ${serviceId} is offered by more than one connection`);
				}
				offered.set(serviceId, { mode, connection });
			}
		}

		const local = new Set(records.flatMap(({ provides }) => provides.map(({ serviceId }) => serviceId)));
		const external = new Map<string, { readonly mode: ServiceMode; readonly connection: FacetConnection }>();
		for (const { requires } of records) {
			for (const requirement of requires) {
				if (local.has(requirement.serviceId) || external.has(requirement.serviceId)) continue;
				let provider = offered.get(requirement.serviceId);
				if (provider === undefined) {
					const deferred = this.#connections.filter(
						({ acceptsUnavailableServices }) => acceptsUnavailableServices,
					);
					if (deferred.length > 1) {
						throw new Error(`Facet host service ${requirement.serviceId} has more than one deferred connection`);
					}
					if (deferred.length === 1) provider = { mode: requirement.mode, connection: deferred[0]! };
				}
				if (provider !== undefined) external.set(requirement.serviceId, provider);
			}
		}
		const serviceIdsByConnection = new Map<FacetConnection, string[]>();
		for (const [serviceId, { connection }] of external) {
			let serviceIds = serviceIdsByConnection.get(connection);
			if (serviceIds === undefined) {
				serviceIds = [];
				serviceIdsByConnection.set(connection, serviceIds);
			}
			serviceIds.push(serviceId);
		}
		for (const [connection, serviceIds] of serviceIdsByConnection) {
			this.#connectionBindings.set(
				connection,
				connection.open({
					services: serviceIds.map((id) => ({ id })),
					assertAccess: () => this.#assertServiceAccess(),
					onError: this.#onError,
				}),
			);
		}
		return external;
	}

	#assembleProviders(): void {
		const remotelyPublishedServices = [
			...this.#singletons
				.filter(({ service }) => !service.local)
				.map(({ service }) => ({ service, mode: "singleton" as const })),
			...this.#keyed
				.filter(({ service }) => !service.local)
				.map(({ service }) => ({ service, mode: "keyed" as const })),
		];
		const provider = new RemoteServiceProvider(remotelyPublishedServices);
		const localKeyedServices = new LocalKeyedServiceRegistry(
			this.#keyed.map(({ service }) => service),
			() => this.#assertServiceAccess(),
			this.#onError,
		);
		this.#provider = provider;
		this.#localKeyedServices = localKeyedServices;
		for (const provision of this.#singletons) {
			if (!provision.service.local) provision.install(provider);
		}
		for (const provision of this.#keyed) {
			provision.connectLocal(localKeyedServices);
			if (!provision.service.local) provision.connectRemote(provider);
		}
	}

	#bindServices(
		externalServices: ReadonlyMap<string, { readonly mode: ServiceMode; readonly connection: FacetConnection }>,
	): void {
		for (const provision of this.#singletons) {
			this.#handles.bindSingleton(provision.service.id, provision.implementation);
		}
		for (const provision of this.#keyed) {
			this.#handles.bindKeyed(provision.service.id, this.#localKeyedRegistry);
		}
		for (const [serviceId, { mode, connection }] of externalServices) {
			const services = this.#connectionBindings.get(connection);
			if (services === undefined) throw new Error(`Service connection for ${serviceId} is not open`);
			if (mode === "singleton") this.#handles.bindRemoteSingleton(serviceId, services);
			else this.#handles.bindKeyed(serviceId, services);
		}
	}

	get #localKeyedRegistry(): LocalKeyedServiceRegistry {
		if (this.#localKeyedServices === undefined) throw new Error("Facet keyed services are not assembled");
		return this.#localKeyedServices;
	}

	async #disposeConnectionBindings(): Promise<unknown[]> {
		const bindings = [...this.#connectionBindings.values()];
		this.#connectionBindings.clear();
		const results = await Promise.allSettled(bindings.map((services) => services.dispose(BACKGROUND_CONTEXT)));
		return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	}

	#assertServiceAccess(): void {
		if (this.#phase !== "activating" && this.#phase !== "active" && this.#phase !== "reloading") {
			throw new Error(`Facet service handles cannot be used during ${this.#phase}`);
		}
	}

	async #disposeLifecycles(): Promise<unknown[]> {
		const errors: unknown[] = [];
		const order =
			this.#activationOrder.length > 0
				? [...this.#activationOrder].reverse()
				: [...this.#lifecycles.keys()].reverse();
		for (const id of order) {
			const lifecycle = this.#lifecycles.get(id);
			if (lifecycle === undefined) continue;
			this.#lifecycles.delete(id);
			try {
				await lifecycle.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}
}

function validateFacets(
	records: readonly FacetRecord[],
	externalServices: ReadonlyMap<string, { readonly mode: ServiceMode }>,
): string[] {
	const providers = new Map<
		string,
		{ readonly facetId: string | undefined; readonly mode: ServiceMode | undefined }
	>();
	for (const [serviceId, { mode }] of externalServices) providers.set(serviceId, { facetId: undefined, mode });
	for (const record of records) {
		for (const provision of record.provides) {
			const existing = providers.get(provision.serviceId);
			if (existing !== undefined) {
				if (existing.mode !== undefined && existing.mode !== provision.mode) {
					throw new Error(`Service ${provision.serviceId} is provided as both singleton and keyed`);
				}
				if (existing.facetId === undefined) {
					throw new Error(`Service ${provision.serviceId} is provided by both the host and ${record.facetId}`);
				}
				throw new Error(
					`Service ${provision.serviceId} is provided by both ${existing.facetId} and ${record.facetId}`,
				);
			}
			providers.set(provision.serviceId, { facetId: record.facetId, mode: provision.mode });
		}
	}

	const dependencies = new Map(records.map((record) => [record.facetId, new Set<string>()]));
	const dependents = new Map(records.map((record) => [record.facetId, new Set<string>()]));
	for (const record of records) {
		for (const requirement of record.requires) {
			const provider = providers.get(requirement.serviceId);
			if (provider === undefined) {
				throw new Error(
					`Facet ${record.facetId} requires local/${requirement.serviceId}/${requirement.mode}, but no facet provides it`,
				);
			}
			if (provider.mode !== undefined && provider.mode !== requirement.mode) {
				throw new Error(
					`Facet ${record.facetId} requires ${requirement.serviceId} as ${requirement.mode}, but ${provider.facetId ?? "the host"} provides it as ${provider.mode}`,
				);
			}
			if (provider.facetId === undefined || provider.facetId === record.facetId) continue;
			dependencies.get(record.facetId)!.add(provider.facetId);
			dependents.get(provider.facetId)!.add(record.facetId);
		}
	}
	return topologicalOrder(records, dependencies, dependents);
}

function topologicalOrder(
	records: readonly FacetRecord[],
	dependencies: ReadonlyMap<string, ReadonlySet<string>>,
	dependents: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
	const remaining = new Map([...dependencies].map(([id, values]) => [id, values.size]));
	const ready = records.map((record) => record.facetId).filter((id) => remaining.get(id) === 0);
	const order: string[] = [];
	while (ready.length > 0) {
		const id = ready.shift()!;
		order.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			const count = remaining.get(dependent)! - 1;
			remaining.set(dependent, count);
			if (count === 0) ready.push(dependent);
		}
	}
	if (order.length !== records.length) {
		const cycle = records.map((record) => record.facetId).filter((id) => remaining.get(id)! > 0);
		throw new Error(`Facet dependency cycle: ${cycle.join(", ")}`);
	}
	return order;
}

function sameFacetShape(left: FacetRecord, right: FacetRecord): boolean {
	return sameReferences(left.requires, right.requires) && sameReferences(left.provides, right.provides);
}

function sameReferences(left: readonly FacetServiceReference[], right: readonly FacetServiceReference[]): boolean {
	if (left.length !== right.length) return false;
	const rightKeys = new Set(right.map(referenceKey));
	return left.every((reference) => rightKeys.has(referenceKey(reference)));
}

function referenceKey(reference: FacetServiceReference): string {
	return `${reference.serviceId}\0${reference.mode}`;
}

function localInstanceTaskKey(instance: LocalKeyedInstance): string {
	return `${instance.key}\0${instance.generation}`;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
