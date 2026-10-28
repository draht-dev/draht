import { useEffect, useState } from "react";
import type { Feed } from "../../../src/contract.js";
import { resolveFeedMediaPaths } from "../lib/mediaPath.js";

export type FeedState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; feed: Feed };

/** `feedPath` is the `feed` field from a {@link RepoIndex} entry, relative to the site root. */
export function useFeed(feedPath: string | undefined): FeedState {
	const [state, setState] = useState<FeedState>({ status: "loading" });

	useEffect(() => {
		if (!feedPath) return;
		let cancelled = false;
		setState({ status: "loading" });

		fetch(`./${feedPath}`)
			.then((response) => {
				if (!response.ok) throw new Error(`${feedPath}: HTTP ${response.status}`);
				return response.json() as Promise<Feed>;
			})
			.then((feed) => {
				if (!cancelled) setState({ status: "ready", feed: resolveFeedMediaPaths(feed, feedPath) });
			})
			.catch((error: unknown) => {
				if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
			});

		return () => {
			cancelled = true;
		};
	}, [feedPath]);

	return state;
}
