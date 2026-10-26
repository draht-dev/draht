import type { MeasuredTokens } from "./policy.ts";

/** At least half of a moved file's tokens must survive for the move to count as a rename. */
const MIN_RENAME_SIMILARITY = 0.5;
/** Bounds the measurements spent on rename candidates in one evaluation; measurements are cached afterwards. */
const MAX_RENAME_COMPARISONS = 32;

function similarity(measured: MeasuredTokens): number {
	const total = measured.baselineTokens + measured.fileTokens;
	return total === 0 ? 1 : 1 - (measured.addedTokens + measured.deletedTokens) / total;
}

/**
 * Pairs files a worktree added with files it deleted, so a moved file is measured against its old content instead
 * of costing a whole deletion plus a whole new file. Identical content pairs first, then the most similar file.
 * Returns added path to deleted path.
 */
export function pairRenames(
	deleted: ReadonlyArray<[path: string, hash: string]>,
	added: ReadonlyArray<[path: string, hash: string]>,
	measure: (beforeHash: string, afterHash: string) => MeasuredTokens,
): Map<string, string> {
	const pairs = new Map<string, string>();
	const sources = new Map(deleted);
	if (sources.size === 0) return pairs;
	for (const [path, hash] of added) {
		const source = [...sources].find(([, sourceHash]) => sourceHash === hash)?.[0];
		if (source === undefined) continue;
		pairs.set(path, source);
		sources.delete(source);
	}
	let comparisons = MAX_RENAME_COMPARISONS;
	for (const [path, hash] of added) {
		if (pairs.has(path)) continue;
		let best: string | undefined;
		let bestSimilarity = MIN_RENAME_SIMILARITY;
		for (const [source, sourceHash] of sources) {
			if (comparisons-- <= 0) return pairs;
			const score = similarity(measure(sourceHash, hash));
			if (score >= bestSimilarity) {
				best = source;
				bestSimilarity = score;
			}
		}
		if (best === undefined) continue;
		pairs.set(path, best);
		sources.delete(best);
	}
	return pairs;
}
