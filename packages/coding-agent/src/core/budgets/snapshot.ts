import { isUtf8 } from "node:buffer";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { type BudgetSnapshot, readBudgetCache, storeBudgetObject, writeBudgetCache } from "./state.ts";
import {
	type BudgetWorkspace,
	isMissingPath,
	isSourcePath,
	listWorkspacePaths,
	pathsOutsideBudget,
	symlinkCheck,
} from "./workspace.ts";

/** Size, modification time, change time, inode, and the stored content hash, or null for binary content. */
type FileEntry = [number, number, number, number, string | null];

interface StatCache {
	startedAt: number;
	files: Record<string, FileEntry>;
	excluded: string[];
}

export interface WorkspaceSnapshot {
	files: BudgetSnapshot;
	/** Earlier paths that left the budget, existing or not, because Git now ignores them or a nested repository holds them. */
	unmeasured: string[];
}

/**
 * File systems store times with up to two seconds of granularity, so a file changed that close to a snapshot may
 * have changed again within the same timestamp; its cached hash is trusted only once its times are older.
 */
const TIMESTAMP_GRANULARITY_MS = 2000;

function parseStatCache(value: unknown): StatCache | undefined {
	if (typeof value !== "object" || value === null || !("startedAt" in value) || !("files" in value)) return undefined;
	if (!("excluded" in value) || typeof value.startedAt !== "number" || !Array.isArray(value.excluded))
		return undefined;
	const { files } = value;
	if (typeof files !== "object" || files === null) return undefined;
	const entries: Array<[string, FileEntry]> = [];
	for (const [path, entry] of Object.entries(files)) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 5 ||
			!entry.slice(0, 4).every((field) => typeof field === "number") ||
			(entry[4] !== null && (typeof entry[4] !== "string" || !/^[a-f0-9]{64}$/.test(entry[4])))
		) {
			return undefined;
		}
		entries.push([path, [entry[0], entry[1], entry[2], entry[3], entry[4]]]);
	}
	return {
		startedAt: value.startedAt,
		files: Object.fromEntries(entries),
		excluded: value.excluded.filter((path): path is string => typeof path === "string"),
	};
}

function regularFile(path: string): Stats | undefined {
	try {
		const stat = lstatSync(path);
		return stat.isFile() ? stat : undefined;
	} catch (error) {
		if (isMissingPath(error)) return undefined;
		throw error;
	}
}

/**
 * Snapshots the measured files of a worktree. A per-worktree cache of file metadata lets unchanged files skip
 * reading and hashing; exclusion decisions are cached too, because they are fixed for the task.
 */
export function snapshotWorkspace(options: {
	workspace: BudgetWorkspace;
	directory: string;
	cacheName: string;
	excluded: (paths: string[]) => ReadonlySet<string>;
	additionalPaths?: string[];
}): WorkspaceSnapshot {
	const { workspace, directory, cacheName } = options;
	const startedAt = Date.now();
	const previous = readBudgetCache(directory, cacheName, parseStatCache);
	const listed = listWorkspacePaths(workspace);
	const paths = [...new Set([...listed, ...(options.additionalPaths ?? [])])];
	const known = new Set([...(previous?.excluded ?? []), ...Object.keys(previous?.files ?? {})]);
	const excluded = new Set([
		...(previous?.excluded ?? []),
		...options.excluded(paths.filter((path) => !known.has(path))),
	]);
	const linked = symlinkCheck(workspace.root);
	const files: Array<[string, FileEntry]> = [];
	const snapshot: Array<[string, string]> = [];
	const unmeasured: string[] = [];
	const vanished: string[] = [];
	let reread = false;
	for (const path of paths) {
		if (excluded.has(path) || linked(path)) continue;
		const absolutePath = join(workspace.root, path);
		const stat = regularFile(absolutePath);
		// Git no longer lists an earlier path: it left the budget if it still exists, or if Git would leave it out now.
		if (!listed.has(path)) {
			if (stat) unmeasured.push(path);
			else vanished.push(path);
			continue;
		}
		if (!stat) continue;
		const cached = previous && Object.hasOwn(previous.files, path) ? previous.files[path] : undefined;
		const settled = previous && Math.max(stat.mtimeMs, stat.ctimeMs) < previous.startedAt - TIMESTAMP_GRANULARITY_MS;
		let hash: string | null;
		if (
			cached &&
			settled &&
			cached[0] === stat.size &&
			cached[1] === stat.mtimeMs &&
			cached[2] === stat.ctimeMs &&
			cached[3] === stat.ino
		) {
			hash = cached[4];
		} else {
			const bytes = readFileSync(absolutePath);
			// Source text with invalid bytes is decoded lossily instead of skipped, so it cannot hide from the budget.
			hash = isUtf8(bytes) || isSourcePath(path) ? storeBudgetObject(directory, bytes.toString("utf8")) : null;
			reread = true;
		}
		files.push([path, [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, hash]]);
		if (hash) snapshot.push([path, hash]);
	}
	const next: StatCache = {
		startedAt,
		files: Object.fromEntries(files),
		excluded: paths.filter((path) => excluded.has(path)),
	};
	const same =
		previous &&
		JSON.stringify(next.files) === JSON.stringify(previous.files) &&
		JSON.stringify(next.excluded) === JSON.stringify(previous.excluded);
	if (reread || !same) writeBudgetCache(directory, cacheName, next);
	unmeasured.push(...pathsOutsideBudget(workspace, vanished));
	return { files: Object.fromEntries(snapshot), unmeasured };
}
