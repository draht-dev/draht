/** At least half of a moved file's content must survive for the move to count as a rename. */
const MIN_RENAME_SIMILARITY = 0.5;

/** Characters on each distinct line, so the content two files share can be compared regardless of line order. */
function lineProfile(text: string): { lines: Map<string, number>; size: number } {
	const lines = new Map<string, number>();
	for (const line of text.split("\n")) lines.set(line, (lines.get(line) ?? 0) + line.length + 1);
	return { lines, size: text.length + 1 };
}

/** How many trailing path segments two paths share; a moved file usually keeps its name, often its directory. */
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
 * Pairs files a worktree added with files it deleted, so a moved file is measured against its old content instead
 * of costing a whole deletion plus a whole new file. Identical content pairs first. Otherwise a pair's similarity is
 * the share of both files' characters on lines they have in common; the most similar pairs claim their files first,
 * and a shared file name and path only break ties. Returns added path to deleted path.
 */
export function pairRenames(
	deleted: ReadonlyArray<[path: string, hash: string]>,
	added: ReadonlyArray<[path: string, hash: string]>,
	content: (hash: string) => string,
): Map<string, string> {
	const pairs = new Map<string, string>();
	const sources = new Map(deleted);
	const identical = new Map<string, string[]>();
	for (const [path, hash] of deleted) {
		const paths = identical.get(hash);
		if (paths) paths.push(path);
		else identical.set(hash, [path]);
	}
	for (const [path, hash] of added) {
		const source = identical.get(hash)?.find((candidate) => sources.has(candidate));
		if (source === undefined) continue;
		pairs.set(path, source);
		sources.delete(source);
	}
	const targets = added.filter(([path]) => !pairs.has(path));
	if (targets.length === 0 || sources.size === 0) return pairs;
	// Each line lists the deleted files holding it, so only files with lines in common are compared.
	const sizes = new Map<string, number>();
	const holders = new Map<string, Array<[source: string, size: number]>>();
	for (const [source, sourceHash] of sources) {
		const { lines, size } = lineProfile(content(sourceHash));
		sizes.set(source, size);
		for (const [line, lineSize] of lines) {
			const entries = holders.get(line);
			if (entries) entries.push([source, lineSize]);
			else holders.set(line, [[source, lineSize]]);
		}
	}
	const matches: Array<{ path: string; source: string; score: number; shared: number; order: number }> = [];
	for (const [order, [path, hash]] of targets.entries()) {
		const { lines, size } = lineProfile(content(hash));
		const overlaps = new Map<string, number>();
		for (const [line, lineSize] of lines) {
			for (const [source, sourceSize] of holders.get(line) ?? []) {
				overlaps.set(source, (overlaps.get(source) ?? 0) + Math.min(lineSize, sourceSize));
			}
		}
		for (const [source, overlap] of overlaps) {
			const score = (2 * overlap) / (size + (sizes.get(source) ?? 0));
			if (score < MIN_RENAME_SIMILARITY) continue;
			matches.push({ path, source, score, shared: sharedSuffix(path, source), order });
		}
	}
	matches.sort((left, right) => right.score - left.score || right.shared - left.shared || left.order - right.order);
	for (const { path, source } of matches) {
		if (pairs.has(path) || !sources.has(source)) continue;
		pairs.set(path, source);
		sources.delete(source);
	}
	return pairs;
}
