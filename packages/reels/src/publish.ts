/**
 * Maintains `<out>/<repoName>/feed.json`, media files, and `<out>/repos.json`
 * incrementally: runs can be repeated and merge idempotently by {@link ReelEntry.id}.
 */

import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { assertValidSha } from "./collect.ts";
import { FEED_SCHEMA_VERSION, type Feed, type ReelEntry, type ReleasePlaylist, type RepoIndex } from "./contract.ts";

export interface RepoMeta {
	name: string;
	url?: string;
	commitUrlTemplate?: string;
}

/** Validates a release tag as a safe path segment under `releases/<tag>` (D9): no `../`, no `/`, no leading dot. */
export const SAFE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Thrown by {@link readFeed}-family readers when a feed's `schemaVersion` is newer than this build understands. */
export class FeedVersionError extends Error {}

function sortReelsNewestFirst(reels: ReelEntry[]): ReelEntry[] {
	return [...reels].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function sortPlaylistsNewestFirst(playlists: ReleasePlaylist[]): ReleasePlaylist[] {
	return [...playlists].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/** Merges new reel entries over an existing one with the same id, keeping fields a later partial re-merge should not erase. */
function mergeEntry(existing: ReelEntry | undefined, incoming: ReelEntry): ReelEntry {
	if (!existing) return incoming;
	return {
		...incoming,
		deepDive: incoming.deepDive ?? existing.deepDive,
		sources: incoming.sources ?? existing.sources,
	};
}

/**
 * Merges {@link ReleasePlaylist} entries by `tag`, replacing a playlist with
 * the same tag instead of duplicating it, newest release first. Idempotent:
 * merging the same playlist twice yields one entry.
 */
export function mergePlaylists(
	existing: readonly ReleasePlaylist[] | undefined,
	incoming: readonly ReleasePlaylist[],
): ReleasePlaylist[] {
	const byTag = new Map<string, ReleasePlaylist>();
	for (const playlist of existing ?? []) byTag.set(playlist.tag, playlist);
	for (const playlist of incoming) byTag.set(playlist.tag, playlist);
	return sortPlaylistsNewestFirst(Array.from(byTag.values()));
}

/**
 * Merges new reel entries into an existing feed, replacing entries with the
 * same id and keeping newest-first order. `repo.url`/`repo.commitUrlTemplate`
 * fall back to the existing feed's values when a later run omits
 * `--repo-url` — a run should never silently erase them. `newPlaylists`,
 * when given, is merged over `existing.playlists` by tag; otherwise the
 * existing playlists are kept as-is.
 */
export function mergeFeed(
	existing: Feed | undefined,
	repo: RepoMeta,
	newEntries: ReelEntry[],
	generatedAt: string,
	newPlaylists?: ReleasePlaylist[],
): Feed {
	const byId = new Map<string, ReelEntry>();
	for (const entry of existing?.reels ?? []) byId.set(entry.id, entry);
	for (const entry of newEntries) byId.set(entry.id, mergeEntry(byId.get(entry.id), entry));

	const playlists = newPlaylists ? mergePlaylists(existing?.playlists, newPlaylists) : existing?.playlists;

	return {
		schemaVersion: FEED_SCHEMA_VERSION,
		repo: {
			name: repo.name,
			url: repo.url ?? existing?.repo.url,
			commitUrlTemplate: repo.commitUrlTemplate ?? existing?.repo.commitUrlTemplate,
		},
		generatedAt,
		reels: sortReelsNewestFirst(Array.from(byId.values())),
		...(playlists ? { playlists } : {}),
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
		playlistCount: feed.playlists?.length,
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

/**
 * Reads a feed file, upgrading a v1 feed to v2 in memory (old `change`
 * entries stay valid: every v2 field is optional). Refuses to read a feed
 * whose `schemaVersion` is newer than this build understands, so an older
 * tool never silently downgrades a newer feed.
 */
async function readFeedAt(path: string): Promise<Feed | undefined> {
	const raw = await readJsonIfExists<Feed>(path);
	if (!raw) return undefined;
	if (raw.schemaVersion > FEED_SCHEMA_VERSION) {
		throw new FeedVersionError(
			`${path}: schemaVersion ${raw.schemaVersion} is newer than this build of draht-reels understands (max ${FEED_SCHEMA_VERSION}); refusing to read or overwrite it`,
		);
	}
	if (raw.schemaVersion === FEED_SCHEMA_VERSION) return raw;
	return { ...raw, schemaVersion: FEED_SCHEMA_VERSION };
}

/** Reads `<outDir>/<repoName>/feed.json` if it exists, for incremental builds (skip-already-published, since-bound). */
export async function readFeed(outDir: string, repoName: string): Promise<Feed | undefined> {
	return readFeedAt(join(outDir, repoName, "feed.json"));
}

export interface PublishOptions {
	outDir: string;
	repo: RepoMeta;
	entries: ReelEntry[];
	playlists?: ReleasePlaylist[];
	now?: () => string;
}

/** Merges `entries` into `feed.json`/`repos.json`, writing both atomically. Safe to call once per successfully-rendered reel. */
export async function publishFeed(options: PublishOptions): Promise<{ feedPath: string; feed: Feed }> {
	const repoDir = join(options.outDir, options.repo.name);
	await mkdir(repoDir, { recursive: true });
	const feedPath = join(repoDir, "feed.json");

	const existing = await readFeedAt(feedPath);
	const generatedAt = (options.now ?? (() => new Date().toISOString()))();
	const feed = mergeFeed(existing, options.repo, options.entries, generatedAt, options.playlists);
	await writeFileAtomic(feedPath, `${JSON.stringify(feed, null, "\t")}\n`);

	const indexPath = join(options.outDir, "repos.json");
	const existingIndex = await readJsonIfExists<RepoIndex>(indexPath);
	const index = mergeRepoIndex(existingIndex, feed);
	await writeFileAtomic(indexPath, `${JSON.stringify(index, null, "\t")}\n`);

	return { feedPath, feed };
}

/**
 * Mainline reachability, as returned by {@link walkMainline}/{@link
 * listReleaseTags}: the set of commit shas on the mainline walk (main and
 * side chains, so back-merge side-line stories like `7eaeb65a2` are not
 * dropped), and the set of release tag names reachable on that same walk.
 * One function feeds both story selection and prune, so they can never
 * disagree about what is reachable.
 */
export interface MainlineReachability {
	shas: ReadonlySet<string>;
	tags: ReadonlySet<string>;
}

/** The release tag of a `kind: "release"` entry, from `release` or (fallback) the `release-<tag>` id. */
function releaseEntryTag(entry: ReelEntry): string | undefined {
	return entry.release ?? entry.id.replace(/^release-/, "");
}

function isEntryReachable(entry: ReelEntry, reachable: MainlineReachability): boolean {
	if (entry.kind === "release") {
		const tag = releaseEntryTag(entry);
		return tag !== undefined && SAFE_TAG_RE.test(tag) && reachable.tags.has(tag);
	}
	return reachable.shas.has(entry.id);
}

/**
 * Removes feed entries (`story`/`recap`/legacy `change` by sha, `release` by
 * tag) no longer reachable on the mainline walk, their media, the
 * `release-<tag>` playlist whose tag vanished, and the `releases/<tag>`
 * media directory — used by the `prune` CLI command after a force-push or a
 * history rewrite.
 */
export async function pruneFeed(
	outDir: string,
	repoName: string,
	reachable: MainlineReachability,
	now: () => string = () => new Date().toISOString(),
): Promise<{ removed: ReelEntry[]; feed: Feed } | undefined> {
	const existing = await readFeed(outDir, repoName);
	if (!existing) return undefined;

	const kept = existing.reels.filter((r) => isEntryReachable(r, reachable));
	const removed = existing.reels.filter((r) => !isEntryReachable(r, reachable));

	const existingPlaylists = existing.playlists ?? [];
	const keptPlaylists = existingPlaylists.filter((p) => SAFE_TAG_RE.test(p.tag) && reachable.tags.has(p.tag));
	const removedPlaylistTags = existingPlaylists
		.filter((p) => !(SAFE_TAG_RE.test(p.tag) && reachable.tags.has(p.tag)))
		.map((p) => p.tag);

	if (removed.length === 0 && removedPlaylistTags.length === 0) return { removed: [], feed: existing };

	const feed: Feed = {
		...existing,
		generatedAt: now(),
		reels: kept,
		...(existing.playlists ? { playlists: keptPlaylists } : {}),
	};
	const feedPath = join(outDir, repoName, "feed.json");
	await writeFileAtomic(feedPath, `${JSON.stringify(feed, null, "\t")}\n`);

	const indexPath = join(outDir, "repos.json");
	const existingIndex = await readJsonIfExists<RepoIndex>(indexPath);
	const index = mergeRepoIndex(existingIndex, feed);
	await writeFileAtomic(indexPath, `${JSON.stringify(index, null, "\t")}\n`);

	const reelsDir = resolve(outDir, repoName, "reels");
	for (const entry of removed) {
		if (entry.kind === "release") continue;
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

	const releasesDir = resolve(outDir, repoName, "releases");
	const releaseTagsToRemove = new Set<string>();
	for (const tag of removedPlaylistTags) {
		if (!SAFE_TAG_RE.test(tag)) {
			console.warn(`draht-reels: skipping media prune for playlist with invalid tag "${tag}"`);
			continue;
		}
		releaseTagsToRemove.add(tag);
	}
	for (const entry of removed) {
		if (entry.kind !== "release") continue;
		const tag = releaseEntryTag(entry);
		if (tag === undefined) continue;
		if (!SAFE_TAG_RE.test(tag)) {
			console.warn(`draht-reels: skipping media prune for release entry with invalid tag "${tag}"`);
			continue;
		}
		releaseTagsToRemove.add(tag);
	}
	for (const tag of releaseTagsToRemove) {
		const target = resolve(releasesDir, tag);
		if (target !== releasesDir && !target.startsWith(releasesDir + sep)) {
			console.warn(`draht-reels: refusing to prune path outside the releases directory: ${target}`);
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
