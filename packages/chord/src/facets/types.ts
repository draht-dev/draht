import type { Context } from "../context.ts";
import type { RemoteServiceInstance, RemoteServices, Service } from "../services/contracts.ts";
import type { ServiceCatalogueEntry } from "../services/protocol.ts";
import type { RemoteServiceProvider } from "../services/provider.ts";
import type { MutableReplicatedState } from "../state.ts";

export interface ServiceInstances<T> {
	add(key: string, implementation: T): () => void;
}

export interface FacetEnvironment {
	/** Declare a hard dependency on one singleton service and return its stable handle. */
	use<T>(service: Service<T>): T;
	/** Declare a hard dependency on a keyed service and observe each live instance. */
	observe<T>(
		service: Service<T>,
		handler: (instance: RemoteServiceInstance<T>, context: Context) => void | Promise<void>,
	): () => void;
	/** Declare and install this facet's singleton implementation of a service. */
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	/** Declare ownership of a keyed service and return its live-instance collection. */
	provideMany<T>(service: Service<T>): ServiceInstances<T>;
	/** Create initialized mutable state suitable for exposing through a service implementation. */
	replicatedState<T>(initial: T): MutableReplicatedState<T>;
	/** Give the facet ownership of a resource cleanup function. */
	own(disposal: () => void | Promise<void>): void;
	/** Register asynchronous initialization after dependencies are bound and ready. */
	onActivate(callback: () => void | Promise<void>): void;
	/** Register final facet teardown. */
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export function defineFacet(facet: Facet): Facet {
	return facet;
}

export interface FacetConnection {
	/** Whether this currently unavailable route may provisionally own absent requirements. */
	readonly acceptsUnavailableServices: boolean;
	catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]>;
	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices;
}

export interface FacetOptions {
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
