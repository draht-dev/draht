import type { Feed, ReelEntry, ReleasePlaylist } from "../../../src/contract.js";

/**
 * The contract has no draft marker yet (owner decision 2026-10-05: LLM-written
 * reels are drafts until `draht-reels approve <id>`, and `build` is expected
 * to keep drafts out of the published feed entirely). This reads an optional
 * `status` field defensively, in case a draft ever ends up in a feed the app
 * is given, so the publish gate holds on the read side too.
 */
type MaybeDraft = ReelEntry & { status?: "draft" | "published" };

export function isDraftReel(reel: ReelEntry): boolean {
	return (reel as MaybeDraft).status === "draft";
}

/** `feed.reels`, drafts excluded. Newest-first order (the feed's own order) is preserved. */
export function publishedReels(feed: Feed): ReelEntry[] {
	return feed.reels.filter((reel) => !isDraftReel(reel));
}

/** `feed.playlists`, newest-tag-first as stored, with playlists that have no published reel at all hidden. */
export function visiblePlaylists(feed: Feed): ReleasePlaylist[] {
	const published = new Set(publishedReels(feed).map((reel) => reel.id));
	return (feed.playlists ?? []).filter((playlist) => {
		const ids = [playlist.overviewId, ...playlist.storyIds, ...playlist.syncs.map((sync) => sync.recapId)];
		return ids.some((id) => id !== undefined && published.has(id));
	});
}

/**
 * A playlist's reel ids in play order: the release overview first, then its
 * stories (in `storyIds` order, which is theme-grouped by the pipeline), then
 * any rendered sync recaps. Draft ids are dropped, and an id with no matching
 * published reel (not yet rendered, or pruned) is dropped too.
 */
export function playlistReelIds(playlist: ReleasePlaylist, feed: Feed): string[] {
	const published = new Set(publishedReels(feed).map((reel) => reel.id));
	const ids: string[] = [];
	if (playlist.overviewId && published.has(playlist.overviewId)) ids.push(playlist.overviewId);
	for (const storyId of playlist.storyIds) {
		if (published.has(storyId) && !ids.includes(storyId)) ids.push(storyId);
	}
	for (const sync of playlist.syncs) {
		if (sync.recapId && published.has(sync.recapId)) ids.push(sync.recapId);
	}
	return ids;
}

export function reelsByIds(feed: Feed, ids: string[]): ReelEntry[] {
	const byId = new Map(feed.reels.map((reel) => [reel.id, reel] as const));
	return ids.map((id) => byId.get(id)).filter((reel): reel is ReelEntry => reel !== undefined);
}
