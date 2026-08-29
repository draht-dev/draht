import type { Facet } from "./types.ts";

export interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

export interface FacetLoader {
	load(): Promise<LoadedFacets>;
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

async function disposeLoadedFacets(loaded: readonly LoadedFacets[]): Promise<unknown[]> {
	const results = await Promise.allSettled(loaded.map((entry) => entry.dispose()));
	return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}
