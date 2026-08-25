import {
	BACKGROUND_CONTEXT,
	type Context,
	createLoopbackServiceConnection,
	type MutableRemoteEvents,
	type MutableReplicatedState,
	type RemoteServiceConnection,
	type RemoteServiceInstance,
	RemoteServiceNamespace,
	type RemoteServiceNamespaceApi,
	RemoteServiceProvider,
	remoteEvents,
	remoteState,
	type Service,
	type ServiceMode,
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
	use<T>(service: Service<T>): T;
	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	provideMany<T>(service: Service<T>): ServiceInstances<T>;
	remoteState<T>(initial: T): MutableReplicatedState<T>;
	remoteEvents<T>(): MutableRemoteEvents<T>;
	own(disposal: () => void | Promise<void>): void;
	onActivate(callback: () => void | Promise<void>): void;
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet<TAttributes extends object = object> {
	readonly id: string;
	setup(env: FacetEnvironment & TAttributes): void;
}

export function defineFacet<TAttributes extends object = object>(facet: Facet<TAttributes>): Facet<TAttributes> {
	return facet;
}

type LifecycleState = "setting_up" | "prepared" | "active" | "disposing" | "dead";
type GenerationPhase = "setup" | "assembling" | "connecting" | "activating" | "active" | "disposing" | "dead";
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

interface LocalServiceHandle {
	readonly mode: ServiceMode;
	readonly namespace: RemoteServiceNamespace;
}

class LocalServiceHandles {
	readonly #assertAccess: () => void;
	readonly #onError: (error: Error) => void;
	readonly #handles = new Map<string, LocalServiceHandle>();
	#connection: RemoteServiceConnection | undefined;

	constructor(assertAccess: () => void, onError: (error: Error) => void) {
		this.#assertAccess = assertAccess;
		this.#onError = onError;
	}

	use<T>(service: Service<T>): T {
		return this.#handle(service, "singleton").namespace.use(service);
	}

	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void {
		return this.#handle(service, "keyed").namespace.observe(service, handler);
	}

	async connect(provider: RemoteServiceProvider): Promise<void> {
		this.#connection = createLoopbackServiceConnection(provider);
		await Promise.all(
			[...this.#handles.values()].map(async ({ namespace }) => {
				await namespace.rebind(true, BACKGROUND_CONTEXT);
				await namespace.ready(BACKGROUND_CONTEXT);
			}),
		);
	}

	async dispose(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.#handles.values()].map(({ namespace }) => namespace.dispose(BACKGROUND_CONTEXT)),
		);
		this.#handles.clear();
		this.#connection = undefined;
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose local facet service handles");
	}

	#handle<T>(service: Service<T>, mode: ServiceMode): LocalServiceHandle {
		const existing = this.#handles.get(service.id);
		if (existing !== undefined) {
			if (existing.mode !== mode) {
				throw new Error(`Local service ${service.id} is used as both singleton and keyed`);
			}
			return existing;
		}
		const namespace = new RemoteServiceNamespace({
			services: [service],
			bound: false,
			assertAccess: this.#assertAccess,
			onError: this.#onError,
			connection: {
				invoke: (call, context) => {
					if (this.#connection === undefined) throw new Error("Local facet services are not connected");
					return this.#connection.invoke(call, context);
				},
				subscribe: (serviceId, serviceMode, listener, context) => {
					if (this.#connection === undefined) throw new Error("Local facet services are not connected");
					return this.#connection.subscribe(serviceId, serviceMode, listener, context);
				},
			},
		});
		const handle = { mode, namespace };
		this.#handles.set(service.id, handle);
		return handle;
	}
}

class StagedServiceInstances<T> implements ServiceInstances<T> {
	readonly #service: Service<T>;
	readonly #lifecycle: FacetLifecycle;
	#provider: RemoteServiceProvider | undefined;

	constructor(service: Service<T>, lifecycle: FacetLifecycle) {
		this.#service = service;
		this.#lifecycle = lifecycle;
	}

	connect(provider: RemoteServiceProvider): void {
		this.#provider = provider;
	}

	add(key: string, implementation: T): () => void {
		this.#lifecycle.assertActive("add service instances");
		if (this.#provider === undefined) throw new Error("Facet service provider is not connected");
		const close = this.#provider.spawn(this.#service, key, implementation);
		this.#lifecycle.own(close);
		return close;
	}
}

interface SingletonProvision {
	readonly service: { readonly id: string };
	install(provider: RemoteServiceProvider): void;
}

interface KeyedProvision {
	readonly service: { readonly id: string };
	connect(provider: RemoteServiceProvider): void;
}

type FacetOptions<TAttributes extends object> = {
	readonly facets: readonly Facet<TAttributes>[];
	readonly onError?: (error: Error) => void;
} & (keyof TAttributes extends never ? { readonly attributes?: TAttributes } : { readonly attributes: TAttributes });

type RemoteFacetOptions<TAttributes extends object> = FacetOptions<TAttributes> & {
	readonly source: RemoteServiceNamespaceApi;
	readonly connect?: () => void | Promise<void>;
};

type FacetKernelOptions<TAttributes extends object> = FacetOptions<TAttributes> &
	(
		| { readonly kind: "provider" }
		| {
				readonly kind: "remote";
				readonly source: RemoteServiceNamespaceApi;
				readonly connect?: () => void | Promise<void>;
		  }
	);

export interface FacetGeneration {
	dispose(): Promise<void>;
}

export interface FacetServiceGeneration extends FacetGeneration {
	readonly provider: RemoteServiceProvider;
}

/** Assemble and activate facets that provide and consume services within one process. */
export async function assembleFacetServices<TAttributes extends object = object>(
	options: FacetOptions<TAttributes>,
): Promise<FacetServiceGeneration> {
	const kernel = new FacetKernel<TAttributes>({ ...options, kind: "provider" });
	await kernel.activate();
	return Object.freeze({
		provider: kernel.provider,
		dispose: () => kernel.dispose(),
	});
}

/** Activate facets whose services come from an existing remote binding. */
export async function activateRemoteFacets<TAttributes extends object = object>(
	options: RemoteFacetOptions<TAttributes>,
): Promise<FacetGeneration> {
	const kernel = new FacetKernel<TAttributes>({ ...options, kind: "remote" });
	await kernel.activate();
	return Object.freeze({ dispose: () => kernel.dispose() });
}

/** Private lifecycle and dependency kernel shared by the two atomic entry points. */
class FacetKernel<TAttributes extends object> {
	readonly #facets: readonly Facet<TAttributes>[];
	readonly #attributes: TAttributes;
	readonly #source: RemoteServiceNamespaceApi | undefined;
	readonly #connect: (() => void | Promise<void>) | undefined;
	readonly #onError: (error: Error) => void;
	readonly #lifecycles = new Map<string, FacetLifecycle>();
	readonly #singletons: SingletonProvision[] = [];
	readonly #keyed: KeyedProvision[] = [];
	readonly #localHandles: LocalServiceHandles;
	#activationOrder: readonly string[] = [];
	#provider: RemoteServiceProvider | undefined;
	#phase: GenerationPhase = "setup";

	constructor(options: FacetKernelOptions<TAttributes>) {
		const ids = options.facets.map((facet) => facet.id);
		if (ids.some((id) => id.length === 0)) throw new Error("Facet ID must not be empty");
		if (new Set(ids).size !== ids.length) throw new Error("Facet IDs must be unique within a generation");
		this.#facets = options.facets;
		this.#attributes = options.attributes ?? ({} as TAttributes);
		this.#source = options.kind === "remote" ? options.source : undefined;
		this.#connect = options.kind === "remote" ? options.connect : undefined;
		this.#onError = options.onError ?? (() => {});
		this.#localHandles = new LocalServiceHandles(() => this.#assertServiceAccess(), this.#onError);
		this.#source?.setAccessGuard(() => this.#assertServiceAccess());
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
				const result: unknown = facet.setup(Object.assign(this.#environment(lifecycle, ledger), this.#attributes));
				if (isPromiseLike(result)) {
					void Promise.resolve(result).catch(() => {});
					throw new Error(`Facet ${facet.id} setup must be synchronous`);
				}
				lifecycle.prepared();
				records.push(ledger.record());
			}

			this.#phase = "assembling";
			if (this.#source === undefined) {
				this.#activationOrder = validateFacets(records);
				this.#assembleProvider();
			} else {
				this.#activationOrder = records.map((record) => record.facetId);
			}

			this.#phase = "connecting";
			if (this.#source === undefined) await this.#localHandles.connect(this.provider);
			else await this.#connect?.();

			this.#phase = "activating";
			for (const id of this.#activationOrder) await this.#lifecycles.get(id)!.activate();
			this.#phase = "active";
		} catch (error) {
			const cleanupErrors = await this.#disposeLifecycles();
			this.#phase = "disposing";
			try {
				await this.#localHandles.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			this.#provider?.dispose();
			this.#phase = "dead";
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Facet generation startup and cleanup failed");
			}
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.#phase === "dead") return;
		const errors = await this.#disposeLifecycles();
		this.#phase = "disposing";
		try {
			await this.#localHandles.dispose();
		} catch (error) {
			errors.push(error);
		}
		this.#provider?.dispose();
		this.#phase = "dead";
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose facet generation");
	}

	#environment(lifecycle: FacetLifecycle, ledger: FacetLedger): FacetEnvironment {
		return {
			provide: <T>(service: Service<T>, implementation: NoInfer<T>): void => {
				lifecycle.assertSettingUp("provide services");
				this.#assertProviderGeneration(lifecycle);
				ledger.provide(service, "singleton");
				this.#singletons.push({
					service,
					install: (provider) => provider.provide(service, implementation),
				});
			},
			provideMany: <T>(service: Service<T>): ServiceInstances<T> => {
				lifecycle.assertSettingUp("provide service instances");
				this.#assertProviderGeneration(lifecycle);
				ledger.provide(service, "keyed");
				const instances = new StagedServiceInstances(service, lifecycle);
				this.#keyed.push({ service, connect: (target) => instances.connect(target) });
				return instances;
			},
			use: <T>(service: Service<T>): T => {
				lifecycle.assertSettingUp("acquire services");
				if (this.#source !== undefined) return this.#source.use(service);
				ledger.require(service, "singleton");
				return this.#localHandles.use(service);
			},
			observe: <T>(
				service: Service<T>,
				handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
			): (() => void) => {
				lifecycle.assertSettingUp("observe services");
				const services = this.#source ?? this.#localHandles;
				if (this.#source === undefined) ledger.require(service, "keyed");
				const prepare = services.observe(service, () => {});
				return this.#stageObservation(lifecycle, () => services.observe(service, handler), prepare);
			},
			remoteState: <T>(initial: T) => {
				lifecycle.assertRunning("create replicated state");
				return remoteState(initial);
			},
			remoteEvents: <T>() => {
				lifecycle.assertRunning("create remote events");
				return remoteEvents<T>();
			},
			own: (disposal) => lifecycle.own(disposal),
			onActivate: (callback) => lifecycle.onActivate(callback),
			onDeactivate: (callback) => lifecycle.own(callback),
		};
	}

	#assertProviderGeneration(lifecycle: FacetLifecycle): void {
		if (this.#source !== undefined) {
			throw new Error(`Remote facet ${lifecycle.id} cannot provide services`);
		}
	}

	#stageObservation(lifecycle: FacetLifecycle, start: () => () => void, prepare: () => void): () => void {
		let close: (() => void) | undefined;
		let closed = false;
		const stop = (): void => {
			if (closed) return;
			closed = true;
			close?.();
			prepare();
		};
		lifecycle.own(prepare);
		lifecycle.observe(() => {
			if (!closed) {
				close = start();
				prepare();
			}
			return stop;
		});
		return stop;
	}

	#assembleProvider(): void {
		const services = new Map<string, { readonly id: string }>();
		for (const { service } of [...this.#singletons, ...this.#keyed]) services.set(service.id, service);
		const provider = new RemoteServiceProvider([...services.values()]);
		this.#provider = provider;
		for (const provision of this.#singletons) provision.install(provider);
		for (const provision of this.#keyed) provision.connect(provider);
	}

	#assertServiceAccess(): void {
		if (this.#phase !== "activating" && this.#phase !== "active") {
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

function validateFacets(records: readonly FacetRecord[]): string[] {
	const providers = new Map<string, { readonly facetId: string; readonly mode: ServiceMode }>();
	for (const record of records) {
		for (const provision of record.provides) {
			const existing = providers.get(provision.serviceId);
			if (existing !== undefined) {
				if (existing.mode !== provision.mode) {
					throw new Error(`Service ${provision.serviceId} is provided as both singleton and keyed`);
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
			if (provider.mode !== requirement.mode) {
				throw new Error(
					`Facet ${record.facetId} requires ${requirement.serviceId} as ${requirement.mode}, but ${provider.facetId} provides it as ${provider.mode}`,
				);
			}
			if (provider.facetId === record.facetId) continue;
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

function referenceKey(reference: FacetServiceReference): string {
	return `${reference.serviceId}\0${reference.mode}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
