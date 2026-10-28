import type { Feed } from "../../../src/contract.js";

/** The directory a feed path lives in, with a trailing slash, e.g. "a/b/feed.json" -> "a/b/". */
export function feedDirOf(feedPath: string): string {
	const lastSlash = feedPath.lastIndexOf("/");
	return lastSlash === -1 ? "" : feedPath.slice(0, lastSlash + 1);
}

/**
 * Resolves a reel-relative media path (video/audio/poster) against the
 * feed.json that lists it, per the contract: "Paths are relative to the
 * feed.json that lists them." An absolute URL or root-relative path is
 * returned unchanged.
 */
export function resolveMediaPath(feedPath: string, relativePath: string): string {
	if (/^([a-z]+:)?\/\//i.test(relativePath) || relativePath.startsWith("/")) return relativePath;
	return feedDirOf(feedPath) + relativePath;
}

/** Rewrites every video/audio/poster path in a {@link Feed} to be resolvable from the site root. */
export function resolveFeedMediaPaths(feed: Feed, feedPath: string): Feed {
	return {
		...feed,
		reels: feed.reels.map((reel) => ({
			...reel,
			video: reel.video ? resolveMediaPath(feedPath, reel.video) : undefined,
			audio: reel.audio ? resolveMediaPath(feedPath, reel.audio) : undefined,
			poster: reel.poster ? resolveMediaPath(feedPath, reel.poster) : undefined,
		})),
	};
}
