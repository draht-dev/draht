import type { PublicSource } from "../../../src/contract.js";

/** The subset of `sources` cited by `citedIds` (a beat's `cites`), in `sources` order. */
export function sourcesCitedBy(sources: PublicSource[] | undefined, citedIds: string[] | undefined): PublicSource[] {
	if (!sources || !citedIds || citedIds.length === 0) return [];
	const cited = new Set(citedIds);
	return sources.filter((source) => cited.has(source.id));
}

export function isSourceCited(citedIds: string[] | undefined, sourceId: string): boolean {
	return Boolean(citedIds?.includes(sourceId));
}
