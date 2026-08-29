/**
 * Chord is a standalone application-composition runtime.
 *
 * Its public API is under development.
 */
export * from "./context.ts";
export { createFacetHost } from "./facets/host.ts";
export {
	combineFacetLoaders,
	createStaticFacetLoader,
	type FacetLoader,
	type LoadedFacets,
} from "./facets/loader.ts";
export {
	defineFacet,
	type Facet,
	type FacetConnection,
	type FacetEnvironment,
	type FacetHost,
	type FacetOptions,
	type ServiceInstances,
} from "./facets/types.ts";
export type { JsonValue } from "./json.ts";
export {
	createRemoteServiceBinding,
	type RemoteServiceBinding,
	type RemoteServiceBindingOptions,
} from "./services/consumer.ts";
export {
	defineService,
	type RemoteServiceInstance,
	type RemoteServices,
	type Service,
	type ServiceMode,
} from "./services/contracts.ts";
export { RemoteServiceError, type RemoteServiceErrorCode } from "./services/errors.ts";
export type {
	RemoteServiceConnection,
	ServiceCall,
	ServiceCatalogueEntry,
	ServiceInstanceAddress,
	ServiceInstanceSnapshot,
	ServiceMemberSnapshot,
	ServiceProviderUpdate,
	ServiceSubscription,
	ServiceSubscriptionSnapshot,
} from "./services/protocol.ts";
export { createLoopbackServiceConnection, RemoteServiceProvider } from "./services/provider.ts";
export { freshDeliveryContext, type MutableReplicatedState, type ReplicatedState, replicatedState } from "./state.ts";
