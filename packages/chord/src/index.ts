/**
 * Chord is a standalone application-composition runtime for agentic applications.
 */
export {
	combineFacetLoaders,
	createFacetHost,
	createLoopbackServiceConnection,
	createRemoteServiceBinding,
	createStaticFacetLoader,
	defineFacet,
	defineService,
	getServiceInstanceKey,
	replicatedState,
} from "./api.ts";
export { RemoteServiceError } from "./services/errors.ts";
export { RemoteServiceProvider } from "./services/provider.ts";
export type {
	Context,
	ContextKey,
	Facet,
	FacetConnection,
	FacetEnvironment,
	FacetHost,
	FacetLoader,
	FacetOptions,
	JsonValue,
	LoadedFacets,
	MutableReplicatedState,
	RemoteServiceBinding,
	RemoteServiceBindingOptions,
	RemoteServiceConnection,
	RemoteServiceContract,
	RemoteServiceErrorCode,
	RemoteServices,
	ReplicatedState,
	Service,
	ServiceCall,
	ServiceCatalogueEntry,
	ServiceInstanceAddress,
	ServiceInstanceSnapshot,
	ServiceMemberSnapshot,
	ServiceMode,
	ServiceProviderUpdate,
	ServiceSpawner,
	ServiceSubscription,
	ServiceSubscriptionSnapshot,
} from "./types.ts";
