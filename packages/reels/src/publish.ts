/**
 * Maintains `<out>/<repoName>/feed.json`, media files, and `<out>/repos.json`
 * incrementally: runs can be repeated and merge idempotently by {@link ReelEntry.id}.
 */

import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertValidSha } from "./collect.ts";
import { FEED_SCHEMA_VERSION, type Feed, type ReelEntry, type RepoIndex } from "./contract.ts";

export interface RepoMeta {
	name: string;
	url?: string;
	commitUrlTemplate?: string;
}

function sortReelsNewestFirst(reels: ReelEntry[]): ReelEntry[] {
	return [...reels].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/**
 * Merges new reel entries into an existing feed, replacing entries with the
 * same id and keeping newest-first order. `repo.url`/`repo.commitUrlTemplate`
 * fall back to the existing feed's values when a later run omits
 * `--repo-url` — a run should never silently erase them.
 */
export function mergeFeed(
	existing: Feed | undefined,
	repo: RepoMeta,
	newEntries: ReelEntry[],
	generatedAt: string,
): Feed {
	const byId = new Map<string, ReelEntry>();
	for (const entry of existing?.reels ?? []) byId.set(entry.id, entry);
	for (const entry of newEntries) byId.set(entry.id, entry);

	return {
		schemaVersion: FEED_SCHEMA_VERSION,
		repo: {
			name: repo.name,
			url: repo.url ?? existing?.repo.url,
			commitUrlTemplate: repo.commitUrlTemplate ?? existing?.repo.commitUrlTemplate,
		},
		generatedAt,
		reels: sortReelsNewestFirst(Array.from(byId.values())),
	};
}

/**
 * Merges or inserts one repo's summary into the root index, keyed by name.
 * `latest` is the newest reel's ISO date (the app parses it as a date, not
 * an id); `poster` is relative to `repos.json` itself, so it is prefixed
 * with the repo name (feed.json's own `poster` field is relative to
 * feed.json, one directory deeper).
 */
export function mergeRepoIndex(existing: RepoIndex | undefined, feed: Feed): RepoIndex {
	const repos = (existing?.repos ?? []).filter((r) => r.name !== feed.repo.name);
	const latest = feed.reels[0];
	repos.push({
		name: feed.repo.name,
		feed: `${feed.repo.name}/feed.json`,
		latest: latest?.date,
		reelCount: feed.reels.length,
		poster: latest?.poster ? `${feed.repo.name}/${latest.poster}` : undefined,
	});
	repos.sort((a, b) => a.name.localeCompare(b.name));
	return { schemaVersion: FEED_SCHEMA_VERSION, repos };
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Writes to a temp file in the same directory, then renames over the target, so a crash mid-write never leaves a truncated file for the next run to choke on. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmpPath, content);
	await rename(tmpPath, path);
}

/** Reads `<outDir>/<repoName>/feed.json` if it exists, for incremental builds (skip-already-published, since-bound). */
export async function readFeed(outDir: string, repoName: string): Promise<Feed | undefined> {
	return readJsonIfExists<Feed>(join(outDir, repoName, "feed.json"));
}

export interface PublishOptions {
	outDir: string;
	repo: RepoMeta;
	entries: ReelEntry[];
	now?: () => string;
}

/** Merges `entries` into `feed.json`/`repos.json`, writing both atomically. Safe to call once per successfully-rendered reel. */
export async function publishFeed(options: PublishOptions): Promise<{ feedPath: string; feed: Feed }> {
	const repoDir = join(options.outDir, options.repo.name);
	await mkdir(repoDir, { recursive: true });
	const feedPath = join(repoDir, "feed.json");

	const existing = await readJsonIfExists<Feed>(feedPath);
	const generatedAt = (options.now ?? (() => new Date().toISOString()))();
	const feed = mergeFeed(existing, options.repo, options.entries, generatedAt);
	await writeFileAtomic(feedPath, `${JSON.stringify(feed, null, "\t")}\n`);

	const indexPath = join(options.outDir, "repos.json");
	const existingIndex = await readJsonIfExists<RepoIndex>(indexPath);
	const index = mergeRepoIndex(existingIndex, feed);
	await writeFileAtomic(indexPath, `${JSON.stringify(index, null, "\t")}\n`);

	return { feedPath, feed };
}

/** Removes feed entries (and, best-effort, their media directory) whose id is no longer reachable from `reachableIds` — used by the `prune` CLI command after a force-push. */
export async function pruneFeed(
	outDir: string,
	repoName: string,
	reachableIds: ReadonlySet<string>,
	now: () => string = () => new Date().toISOString(),
): Promise<{ removed: ReelEntry[]; feed: Feed } | undefined> {
	const existing = await readFeed(outDir, repoName);
	if (!existing) return undefined;

	const kept = existing.reels.filter((r) => reachableIds.has(r.id));
	const removed = existing.reels.filter((r) => !reachableIds.has(r.id));
	if (removed.length === 0) return { removed: [], feed: existing };

	const feed: Feed = { ...existing, generatedAt: now(), reels: kept };
	const feedPath = join(outDir, repoName, "feed.json");
	await writeFileAtomic(feedPath, `${JSON.stringify(feed, null, "\t")}\n`);

	const indexPath = join(outDir, "repos.json");
	const existingIndex = await readJsonIfExists<RepoIndex>(indexPath);
	const index = mergeRepoIndex(existingIndex, feed);
	await writeFileAtomic(indexPath, `${JSON.stringify(index, null, "\t")}\n`);

	const reelsDir = resolve(outDir, repoName, "reels");
	for (const entry of removed) {
		let shortSha: string;
		try {
			shortSha = assertValidSha(entry.id).slice(0, 12);
		} catch {
			console.warn(`draht-reels: skipping media prune for entry with invalid id "${entry.id}"`);
			continue;
		}
		const target = resolve(reelsDir, shortSha);
		if (target !== reelsDir && !target.startsWith(reelsDir + sep)) {
			console.warn(`draht-reels: refusing to prune path outside the reels directory: ${target}`);
			continue;
		}
		await rm(target, { recursive: true, force: true });
	}

	return { removed, feed };
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Copies the built PWA (`app/dist`) into `<out>/` without touching feed.json or repos.json. */
export async function publishSite(appDistDir: string, outDir: string): Promise<void> {
	if (!(await pathExists(appDistDir))) {
		throw new Error(`reels site: ${appDistDir} does not exist. Run "npm run build:app" in packages/reels first.`);
	}
	await mkdir(outDir, { recursive: true });
	await cp(appDistDir, outDir, {
		recursive: true,
		filter: (source) => {
			const base = source.split("/").pop();
			return base !== "feed.json" && base !== "repos.json";
		},
	});
}
