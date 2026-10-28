/**
 * Per-repo sidecar at `<out>/<name>/.reels-state.json` tracking change sets
 * that failed to render, so a deterministically-failing commit (e.g. a
 * 429 from ElevenLabs, a Remotion crash) does not stall every later run
 * forever: it is retried up to {@link MAX_RENDER_ATTEMPTS} times, then
 * skipped (still counted and reported) until `--force`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_RENDER_ATTEMPTS = 3;

export interface FailedEntry {
	attempts: number;
	lastError: string;
	lastAttemptAt: string;
}

export interface RejectedEntry {
	reason?: string;
	date: string;
}

export interface ApprovedEntry {
	date: string;
}

export interface ReelsState {
	failed: Record<string, FailedEntry>;
	/** T12b: story ids a human rejected (`draht-reels reject`). `build` skips these unless `--force`. Absent means none. */
	rejected?: Record<string, RejectedEntry>;
	/** T12b: story ids a human approved (`draht-reels approve`), for audit; `build`'s own skip of approved ids reads the real public feed, not this. Absent means none. */
	approved?: Record<string, ApprovedEntry>;
}

function statePath(outDir: string, repoName: string): string {
	return join(outDir, repoName, ".reels-state.json");
}

export async function readState(outDir: string, repoName: string): Promise<ReelsState> {
	const path = statePath(outDir, repoName);
	const empty: ReelsState = { failed: {} };
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.warn(`draht-reels: ignoring corrupt state file ${path}: ${(error as Error).message}`);
		return empty;
	}
	if (typeof parsed !== "object" || parsed === null) {
		console.warn(`draht-reels: ignoring invalid state file ${path}: expected a JSON object`);
		return empty;
	}
	const partial = parsed as Partial<ReelsState>;
	return {
		failed: partial.failed ?? {},
		...(partial.rejected ? { rejected: partial.rejected } : {}),
		...(partial.approved ? { approved: partial.approved } : {}),
	};
}

export async function writeState(outDir: string, repoName: string, state: ReelsState): Promise<void> {
	const path = statePath(outDir, repoName);
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, `${JSON.stringify(state, null, "\t")}\n`);
	await rename(tmpPath, path);
}

export function recordFailure(state: ReelsState, id: string, errorMessage: string, now: string): ReelsState {
	const attempts = (state.failed[id]?.attempts ?? 0) + 1;
	return { ...state, failed: { ...state.failed, [id]: { attempts, lastError: errorMessage, lastAttemptAt: now } } };
}

export function recordSuccess(state: ReelsState, id: string): ReelsState {
	if (!(id in state.failed)) return state;
	const failed = { ...state.failed };
	delete failed[id];
	return { ...state, failed };
}

/** T12b `draht-reels reject <id>`: records who/when/why, so `build` skips it unless `--force`. */
export function recordRejection(state: ReelsState, id: string, now: string, reason?: string): ReelsState {
	return { ...state, rejected: { ...state.rejected, [id]: { date: now, ...(reason ? { reason } : {}) } } };
}

/** T12b `draht-reels approve <id>…`: audit trail only (the public feed itself is the source of truth for "already published"). */
export function recordApproval(state: ReelsState, id: string, now: string): ReelsState {
	return { ...state, approved: { ...state.approved, [id]: { date: now } } };
}

/** True when `id` was rejected; `build` excludes it unless `--force`. */
export function isRejected(state: ReelsState, id: string): boolean {
	return id in (state.rejected ?? {});
}

export function shouldSkip(state: ReelsState, id: string, maxAttempts: number = MAX_RENDER_ATTEMPTS): boolean {
	return (state.failed[id]?.attempts ?? 0) >= maxAttempts;
}

/** ids that have hit the render retry cap and should not be retried without `--force`. */
export function cappedIds(state: ReelsState, maxAttempts: number = MAX_RENDER_ATTEMPTS): Set<string> {
	return new Set(Object.keys(state.failed).filter((id) => shouldSkip(state, id, maxAttempts)));
}
