import { BACKGROUND_CONTEXT } from "../context/index.ts";
import { ServiceHandle } from "../services/handle.ts";
import { InstanceDirectory, type InstanceDirectoryEntry } from "../services/instances.ts";
import { RemoteServiceProvider, validateRemoteServiceImplementation } from "../services/provider.ts";
import { MutableReplicatedStateImpl } from "../services/state.ts";
import type {
	Context,
	Facet,
	FacetConnection,
	FacetEnvironment,
	FacetOptions,
	RemoteServiceContract,
	RemoteServices,
	Service,
	ServiceMode,
	ServiceSpawner,
} from "../types.ts";

interface FacetServiceReference {
	readonly serviceId: string;
	readonly mode: ServiceMode;
}

interface FacetShape {
	facetId: string;
	requires: readonly FacetServiceReference[];
	provides: readonly FacetServiceReference[];
}

interface FacetRuntime extends FacetShape {
	requires: FacetServiceReference[];
	provides: FacetServiceReference[];
	readonly lifecycle: FacetLifecycle;
	readonly provisions: FacetProvision[];
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

interface StagedObservation {
	start(): () => void;
	stop(): void;
}

interface KeyedServiceSource {
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void;
}

interface LocalKeyedRegistration {
	readonly generations: Map<string, number>;
	readonly directory: InstanceDirectory<InstanceDirectoryEntry>;
}

class LocalKeyedServiceRegistry implements KeyedServiceSource {
	readonly #registrations = new Map<string, LocalKeyedRegistration>();
	readonly #assertAccess: () => void;
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
				generations: new Map(),
				directory: new InstanceDirectory({ ready: true, onError }),
			});
		}
		this.#assertAccess = assertAccess;
	}

	spawn<T>(service: Service<T>, key: string, implementation: T): () => void {
		this.#assertActive();
		if (key.length === 0) throw new TypeError("Local service instance key must not be empty");
		if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
			throw new TypeError(`Local service ${service.id} implementation must be an object`);
		}
		const registration = this.#registration(service.id);
		if (registration.directory.get(key) !== undefined) {
			throw new Error(`Local service ${service.id} already has a live instance with key ${key}`);
		}
		const generation = (registration.generations.get(key) ?? 0) + 1;
		registration.generations.set(key, generation);
		const handle = new ServiceHandle(service.id, this.#assertAccess);
		handle.bind(implementation);
		const instance: InstanceDirectoryEntry = {
			key,
			generation,
			service: handle.proxy,
			deactivate: () => handle.unbind(),
		};
		registration.directory.insert(instance);
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			registration.directory.remove(instance);
		};
	}

	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void {
		this.#assertActive();
		return this.#registration(service.id).directory.observe(handler);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const registration of this.#registrations.values()) registration.directory.dispose();
		this.#registrations.clear();
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
	readonly #singletons = new Map<string, ServiceHandle>();
	readonly #singletonServices = new Map<string, Service<unknown>>();
	readonly #keyedSources = new Map<string, KeyedServiceSource>();

	constructor(assertAccess: () => void) {
		this.#assertAccess = assertAccess;
	}

	use<T>(service: Service<T>): T {
		let handle = this.#singletons.get(service.id);
		if (handle === undefined) {
			handle = new ServiceHandle(service.id, this.#assertAccess);
			this.#singletons.set(service.id, handle);
			this.#singletonServices.set(service.id, service as Service<unknown>);
		}
		return handle.proxy as T;
	}

	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): StagedObservation {
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

class StagedServiceSpawner<T> implements ServiceSpawner<T> {
	readonly #lifecycle: FacetLifecycle;
	readonly #installers: ServiceInstanceInstaller<T>[] = [];

	constructor(lifecycle: FacetLifecycle) {
		this.#lifecycle = lifecycle;
	}

	connect(installer: ServiceInstanceInstaller<T>): void {
		this.#installers.push(installer);
	}

	spawn(key: string, implementation: T): () => void {
		this.#lifecycle.assertActive("spawn service instances");
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

type FacetProvision =
	| {
			readonly kind: "singleton";
			readonly service: { readonly id: string; readonly local: boolean };
			readonly implementation: object;
			install(provider: RemoteServiceProvider): void;
			withdraw(provider: RemoteServiceProvider): void;
			replace(provider: RemoteServiceProvider): void;
	  }
	| {
			readonly kind: "keyed";
			readonly service: { readonly id: string; readonly local: boolean };
			connectLocal(registry: LocalKeyedServiceRegistry): void;
			connectRemote(provider: RemoteServiceProvider): void;
	  };

/** Private lifecycle and dependency kernel behind the atomic host entry point. */
export class FacetKernel {
	readonly #initialFacets: readonly Facet[];
	readonly #connections: readonly FacetConnection[];
	readonly #onError: (error: Error) => void;
	readonly #facets = new Map<string, FacetRuntime>();
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
		this.#initialFacets = options.facets;
		this.#connections = options.connections ?? [];
		this.#onError = options.onError ?? (() => {});
		this.#handles = new FacetServiceHandles(() => this.#assertServiceAccess());
	}

	get provider(): RemoteServiceProvider {
		if (this.#provider === undefined) throw new Error("Facet service provider is not assembled");
		return this.#provider;
	}

	#createFacetRuntime(facetId: string): FacetRuntime {
		return {
			facetId,
			requires: [],
			provides: [],
			lifecycle: new FacetLifecycle(facetId),
			provisions: [],
		};
	}

	#setupFacet(facet: Facet, record: FacetRuntime): void {
		const result: unknown = facet.setup(this.#environment(record));
		if (isPromiseLike(result)) {
			void Promise.resolve(result).catch(() => {});
			throw new Error(`Facet ${facet.id} setup must be synchronous`);
		}
		record.lifecycle.prepared();
	}

	async activate(): Promise<void> {
		const records: FacetRuntime[] = [];
		try {
			for (const facet of this.#initialFacets) {
				const record = this.#createFacetRuntime(facet.id);
				this.#facets.set(facet.id, record);
				this.#setupFacet(facet, record);
				records.push(record);
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
			for (const id of this.#activationOrder) await this.#facets.get(id)!.lifecycle.activate();
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
			if (!this.#facets.has(id)) throw new Error(`Facet ${id} is not active`);
		}
		this.#phase = "reloading";

		const staged: FacetRuntime[] = [];
		const candidates: FacetRuntime[] = [];
		try {
			for (const facet of facets) {
				const record = this.#createFacetRuntime(facet.id);
				staged.push(record);
				this.#setupFacet(facet, record);
				const previous = this.#facets.get(facet.id)!;
				if (!sameFacetShape(previous, record)) {
					throw new Error(`Reloaded facet ${facet.id} must preserve its service requirements and provisions`);
				}
				this.#validateReplacementProvisions(record.provisions);
				candidates.push(record);
			}
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			for (const record of staged.reverse()) {
				try {
					await record.lifecycle.dispose();
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

		const replacements = new Map(candidates.map((record) => [record.facetId, record]));
		for (const candidate of candidates) {
			for (const provision of candidate.provisions) {
				if (provision.kind !== "singleton") continue;
				this.#handles.unbindSingleton(provision.service.id);
				if (!provision.service.local) provision.withdraw(this.provider);
			}
		}
		const disposalErrors: unknown[] = [];
		for (const id of [...this.#activationOrder].reverse()) {
			if (!replacements.has(id)) continue;
			const record = this.#facets.get(id)!;
			this.#facets.delete(id);
			try {
				await record.lifecycle.dispose();
			} catch (error) {
				disposalErrors.push(error);
			}
		}
		if (disposalErrors.length > 0) {
			for (const candidate of candidates.reverse()) {
				try {
					await candidate.lifecycle.dispose();
				} catch (error) {
					disposalErrors.push(error);
				}
			}
			this.#phase = "active";
			throw new AggregateError(disposalErrors, "Failed to deactivate reloaded facets");
		}

		this.#phase = "activating";
		try {
			for (const candidate of candidates) {
				for (const provision of candidate.provisions) {
					if (provision.kind !== "keyed") continue;
					provision.connectLocal(this.#localKeyedRegistry);
					if (!provision.service.local) provision.connectRemote(this.provider);
				}
				this.#facets.set(candidate.facetId, candidate);
			}
			for (const id of this.#activationOrder) {
				const candidate = replacements.get(id);
				if (candidate === undefined) continue;
				await candidate.lifecycle.activate();
				for (const provision of candidate.provisions) {
					if (provision.kind !== "singleton") continue;
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

	#validateReplacementProvisions(provisions: readonly FacetProvision[]): void {
		for (const provision of provisions) {
			if (provision.kind !== "singleton" || provision.service.local) continue;
			validateRemoteServiceImplementation(provision.service.id, provision.implementation);
		}
	}

	#environment(runtime: FacetRuntime): FacetEnvironment {
		const { lifecycle, provisions } = runtime;
		return {
			provide: <T>(service: Service<T>, implementation: NoInfer<T>): void => {
				lifecycle.assertSettingUp("provide services");
				if (typeof implementation !== "object" || implementation === null || Array.isArray(implementation)) {
					throw new TypeError(`Service ${service.id} implementation must be an object`);
				}
				recordServiceReference(runtime.provides, service, "singleton");
				provisions.push({
					kind: "singleton",
					service,
					implementation,
					install: (provider) => provider.provide(service, implementation as NoInfer<RemoteServiceContract<T>>),
					withdraw: (provider) => provider.withdraw(service),
					replace: (provider) => provider.replace(service, implementation as NoInfer<RemoteServiceContract<T>>),
				});
			},
			provideMany: <T>(service: Service<T>): ServiceSpawner<T> => {
				lifecycle.assertSettingUp("provide service instances");
				recordServiceReference(runtime.provides, service, "keyed");
				const instances = new StagedServiceSpawner<T>(lifecycle);
				provisions.push({
					kind: "keyed",
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
				recordServiceReference(runtime.requires, service, "singleton");
				return this.#handles.use(service);
			},
			observe: <T>(
				service: Service<T>,
				handler: (service: T, context: Context) => void | Promise<void>,
			): (() => void) => {
				lifecycle.assertSettingUp("observe services");
				recordServiceReference(runtime.requires, service, "keyed");
				const observation = this.#handles.observe(service, handler);
				lifecycle.observe(() => observation.start());
				return observation.stop;
			},
			replicatedState: <T>(initial: T) => {
				lifecycle.assertRunning("create replicated state");
				return new MutableReplicatedStateImpl(initial);
			},
			own: (disposal) => lifecycle.own(disposal),
			onActivate: (callback) => lifecycle.onActivate(callback),
			onDeactivate: (callback) => lifecycle.own(callback),
		};
	}

	async #resolveExternalServices(
		records: readonly FacetShape[],
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
		const provisions = this.#provisions();
		const provider = new RemoteServiceProvider(
			provisions.filter(({ service }) => !service.local).map(({ service, kind }) => ({ service, mode: kind })),
		);
		const localKeyedServices = new LocalKeyedServiceRegistry(
			provisions.flatMap((provision) => (provision.kind === "keyed" ? [provision.service] : [])),
			() => this.#assertServiceAccess(),
			this.#onError,
		);
		this.#provider = provider;
		this.#localKeyedServices = localKeyedServices;
		for (const provision of provisions) {
			if (provision.kind === "singleton") {
				if (!provision.service.local) provision.install(provider);
			} else {
				provision.connectLocal(localKeyedServices);
				if (!provision.service.local) provision.connectRemote(provider);
			}
		}
	}

	#bindServices(
		externalServices: ReadonlyMap<string, { readonly mode: ServiceMode; readonly connection: FacetConnection }>,
	): void {
		for (const provision of this.#provisions()) {
			if (provision.kind === "singleton") {
				this.#handles.bindSingleton(provision.service.id, provision.implementation);
			} else {
				this.#handles.bindKeyed(provision.service.id, this.#localKeyedRegistry);
			}
		}
		for (const [serviceId, { mode, connection }] of externalServices) {
			const services = this.#connectionBindings.get(connection);
			if (services === undefined) throw new Error(`Service connection for ${serviceId} is not open`);
			if (mode === "singleton") this.#handles.bindRemoteSingleton(serviceId, services);
			else this.#handles.bindKeyed(serviceId, services);
		}
	}

	#provisions(): FacetProvision[] {
		return [...this.#facets.values()].flatMap(({ provisions }) => provisions);
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
			this.#activationOrder.length > 0 ? [...this.#activationOrder].reverse() : [...this.#facets.keys()].reverse();
		for (const id of order) {
			const record = this.#facets.get(id);
			if (record === undefined) continue;
			this.#facets.delete(id);
			try {
				await record.lifecycle.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}
}

function validateFacets(
	records: readonly FacetShape[],
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
	records: readonly FacetShape[],
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

function recordServiceReference(
	target: FacetServiceReference[],
	service: { readonly id: string },
	mode: ServiceMode,
): void {
	if (target.some((reference) => reference.serviceId === service.id && reference.mode === mode)) return;
	target.push({ serviceId: service.id, mode });
}

function sameFacetShape(left: FacetShape, right: FacetShape): boolean {
	return sameReferences(left.requires, right.requires) && sameReferences(left.provides, right.provides);
}

function sameReferences(left: readonly FacetServiceReference[], right: readonly FacetServiceReference[]): boolean {
	return (
		left.length === right.length &&
		left.every((reference) =>
			right.some((other) => other.serviceId === reference.serviceId && other.mode === reference.mode),
		)
	);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
