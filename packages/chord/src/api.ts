import { FacetKernel } from "./facets/host.ts";
import { disposeLoadedFacets } from "./facets/loader.ts";
import { RemoteServiceBindingImpl } from "./services/consumer.ts";
import { lookupServiceInstanceKey } from "./services/instances.ts";
import type { RemoteServiceProvider } from "./services/provider.ts";
import { MutableReplicatedStateImpl, serviceDeliveryContext } from "./services/state.ts";
import type {
	Facet,
	FacetHost,
	FacetLoader,
	FacetOptions,
	LoadedFacets,
	MutableReplicatedState,
	RemoteServiceBinding,
	RemoteServiceBindingOptions,
	RemoteServiceConnection,
	RemoteServiceContract,
	Service,
} from "./types.ts";

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

export function createStaticFacetLoader(facets: readonly Facet[]): FacetLoader {
	const loadedFacets = Object.freeze([...facets]);
	return {
		async load() {
			return { facets: loadedFacets, async dispose() {} };
		},
	};
}

export function combineFacetLoaders(loaders: readonly FacetLoader[]): FacetLoader {
	return {
		async load() {
			const loaded: LoadedFacets[] = [];
			try {
				for (const loader of loaders) loaded.push(await loader.load());
			} catch (error) {
				const cleanupErrors = await disposeLoadedFacets(loaded.reverse());
				if (cleanupErrors.length > 0) {
					throw new AggregateError([error, ...cleanupErrors], "Facet loading and cleanup failed");
				}
				throw error;
			}
			let disposed = false;
			return {
				facets: Object.freeze(loaded.flatMap(({ facets }) => facets)),
				async dispose() {
					if (disposed) return;
					disposed = true;
					const errors = await disposeLoadedFacets([...loaded].reverse());
					if (errors.length === 1) throw errors[0];
					if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose loaded facets");
				},
			};
		},
	};
}

export function defineFacet(facet: Facet): Facet {
	return facet;
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
	// TODO: check if the reserved namespace should be part of Chord.
	if (id.startsWith("$chord.")) throw new TypeError("Service IDs beginning with $chord. are reserved");
	return Object.freeze({ id, local: options?.local ?? false });
}

/** @publicApiReview Consider hiding this low-level remote binding factory behind facet connections. */
export function createRemoteServiceBinding(options: RemoteServiceBindingOptions): RemoteServiceBinding {
	return new RemoteServiceBindingImpl(options);
}

/**
 * Return the application key for a keyed service proxy, or undefined for a singleton.
 *
 * @publicApiReview Consider passing the key directly to keyed observers instead of exposing proxy metadata.
 */
export function getServiceInstanceKey(service: object): string | undefined {
	return lookupServiceInstanceKey(service);
}

/** @publicApiReview Consider keeping this loopback transport adapter in testing support. */
export function createLoopbackServiceConnection(provider: RemoteServiceProvider): RemoteServiceConnection {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, (update) =>
				listener(update, serviceDeliveryContext()),
			);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}

export function replicatedState<T>(initial: T): MutableReplicatedState<T> {
	return new MutableReplicatedStateImpl(initial);
}
