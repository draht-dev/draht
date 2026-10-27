import type { MeasuredTokens } from "./policy.ts";

/** At least half of a moved file's tokens must survive for the move to count as a rename. */
const MIN_RENAME_SIMILARITY = 0.5;
/**
 * Bounds the new measurements spent on rename candidates in one evaluation. Measurements are cached afterwards, so a
 * batch of moves too large for one evaluation pairs fully over the following ones.
 */
const MAX_RENAME_COMPARISONS = 32;

interface Candidate {
	source: string;
	sourceHash: string;
	rank: number;
}

function similarity(measured: MeasuredTokens): number {
	const total = measured.baselineTokens + measured.fileTokens;
	return total === 0 ? 1 : 1 - (measured.addedTokens + measured.deletedTokens) / total;
}

function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function append(groups: Map<string, string[]>, key: string, path: string): void {
	const paths = groups.get(key);
	if (paths) paths.push(path);
	else groups.set(key, [path]);
}

/** How many trailing path segments two paths share. */
function sharedSuffix(left: string, right: string): number {
	const leftParts = left.split("/");
	const rightParts = right.split("/");
	let shared = 0;
	while (
		shared < Math.min(leftParts.length, rightParts.length) &&
		leftParts[leftParts.length - 1 - shared] === rightParts[rightParts.length - 1 - shared]
	) {
		shared++;
	}
	return shared;
}

/**
 * A moved file usually keeps its name and often its parent directory, so deleted files with the same name come
 * first, those sharing more of the path ahead, followed by every other deleted file.
 */
function* candidates(path: string, sources: ReadonlyMap<string, string>, named: ReadonlyMap<string, string[]>) {
	const name = fileName(path);
	const likely: Candidate[] = [];
	for (const source of named.get(name) ?? []) {
		const sourceHash = sources.get(source);
		if (sourceHash !== undefined) likely.push({ source, sourceHash, rank: sharedSuffix(path, source) });
	}
	yield* likely.sort((left, right) => right.rank - left.rank);
	for (const [source, sourceHash] of sources) {
		if (fileName(source) !== name) yield { source, sourceHash, rank: 0 };
	}
}

/**
 * Pairs files a worktree added with files it deleted, so a moved file is measured against its old content instead
 * of costing a whole deletion plus a whole new file. Identical content pairs first, then the most similar file
 * among the likeliest candidates. Returns added path to deleted path.
 */
export function pairRenames(
	deleted: ReadonlyArray<[path: string, hash: string]>,
	added: ReadonlyArray<[path: string, hash: string]>,
	measure: (beforeHash: string, afterHash: string) => MeasuredTokens,
	measured: (beforeHash: string, afterHash: string) => boolean = () => false,
): Map<string, string> {
	const pairs = new Map<string, string>();
	const sources = new Map(deleted);
	if (sources.size === 0) return pairs;
	const identical = new Map<string, string[]>();
	const named = new Map<string, string[]>();
	for (const [path, hash] of deleted) {
		append(identical, hash, path);
		append(named, fileName(path), path);
	}
	for (const [path, hash] of added) {
		const source = identical.get(hash)?.find((candidate) => sources.has(candidate));
		if (source === undefined) continue;
		pairs.set(path, source);
		sources.delete(source);
	}
	let comparisons = MAX_RENAME_COMPARISONS;
	for (const [path, hash] of added) {
		if (pairs.has(path)) continue;
		let best: (Candidate & { score: number }) | undefined;
		let exhausted = false;
		for (const candidate of candidates(path, sources, named)) {
			// A match among likelier candidates wins over every less likely one.
			if (best && candidate.rank < best.rank) break;
			if (!measured(candidate.sourceHash, hash)) {
				exhausted = comparisons === 0;
				if (exhausted) break;
				comparisons--;
			}
			const score = similarity(measure(candidate.sourceHash, hash));
			if (score >= (best?.score ?? MIN_RENAME_SIMILARITY)) best = { ...candidate, score };
		}
		if (best) {
			pairs.set(path, best.source);
			sources.delete(best.source);
		}
		if (exhausted) break;
	}
	return pairs;
}
