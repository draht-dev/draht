import { useEffect } from "react";
import { Feed } from "./components/Feed.js";
import { Home } from "./components/Home.js";
import { Playlist } from "./components/Playlist.js";
import { Profile } from "./components/Profile.js";
import { useFeed } from "./hooks/useFeed.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { usePlaybackPreference } from "./hooks/usePlaybackPreference.js";
import { useRepoIndex } from "./hooks/useRepoIndex.js";
import { playlistReelIds } from "./lib/playlists.js";

export function App() {
	const repoIndexState = useRepoIndex();
	const [route, navigate] = useHashRoute();
	const playback = usePlaybackPreference();

	const repoName = route.kind !== "home" ? route.repo : undefined;
	const repoEntry =
		repoIndexState.status === "ready" ? repoIndexState.index.repos.find((repo) => repo.name === repoName) : undefined;
	const feedState = useFeed(repoEntry?.feed);

	useEffect(() => {
		if (route.kind !== "home" || repoIndexState.status !== "ready") return;
		if (repoIndexState.index.repos.length === 1) {
			const only = repoIndexState.index.repos[0];
			if (only) navigate({ kind: "repo", repo: only.name });
		}
	}, [route.kind, repoIndexState, navigate]);

	if (repoIndexState.status === "loading") {
		return (
			<main className="app-state" aria-busy="true">
				Loading…
			</main>
		);
	}

	if (repoIndexState.status === "error") {
		return <main className="app-state app-error">Could not load repos.json: {repoIndexState.message}</main>;
	}

	if (route.kind === "home") {
		return <Home index={repoIndexState.index} onOpenRepo={(repo) => navigate({ kind: "repo", repo })} />;
	}

	if (!repoEntry) {
		return <main className="app-state app-error">Unknown repo: {route.repo}</main>;
	}

	if (feedState.status === "loading") {
		return (
			<main className="app-state" aria-busy="true">
				Loading…
			</main>
		);
	}

	if (feedState.status === "error") {
		return <main className="app-state app-error">Could not load feed: {feedState.message}</main>;
	}

	const { feed } = feedState;

	if (route.kind === "repo") {
		return (
			<Profile
				feed={feed}
				onOpenReel={(reelId) => navigate({ kind: "reel", repo: route.repo, reelId })}
				onOpenRelease={(tag) => navigate({ kind: "release", repo: route.repo, tag })}
			/>
		);
	}

	if (route.kind === "release") {
		const playlist = feed.playlists?.find((candidate) => candidate.tag === route.tag);
		if (!playlist) {
			return <main className="app-state app-error">Unknown release: {route.tag}</main>;
		}
		return (
			<Playlist
				feed={feed}
				playlist={playlist}
				onPlay={(reelIds) => {
					const first = reelIds[0];
					if (first) navigate({ kind: "reel", repo: route.repo, reelId: first, releaseTag: route.tag });
				}}
				onOpenReel={(reelId) => navigate({ kind: "reel", repo: route.repo, reelId, releaseTag: route.tag })}
				onBack={() => navigate({ kind: "repo", repo: route.repo })}
			/>
		);
	}

	// The playlist scope is recomputed from the route (rather than kept as
	// local state) so a reload or a shared link restores it.
	const scopedPlaylist = route.releaseTag ? feed.playlists?.find((candidate) => candidate.tag === route.releaseTag) : undefined;
	const scopedIds = scopedPlaylist ? playlistReelIds(scopedPlaylist, feed) : undefined;

	return (
		<Feed
			feed={feed}
			reelIds={scopedIds}
			initialReelId={route.reelId}
			initialDeepDive={route.deep}
			onActiveReelChange={(reelId) => {
				if (reelId !== route.reelId) {
					navigate({ kind: "reel", repo: route.repo, reelId, releaseTag: route.releaseTag }, { replace: true });
				}
			}}
			onDeepDiveChange={(reelId, deep) => {
				// A route change that swaps the feed's reel scope can transiently
				// report a different card as "active" before the feed scrolls to
				// `route.reelId`; ignoring any reel other than the routed one keeps
				// that transient signal from stomping the deep-dive flag it just set.
				if (reelId !== route.reelId || Boolean(route.deep) === deep) return;
				navigate(
					{ kind: "reel", repo: route.repo, reelId: route.reelId, releaseTag: route.releaseTag, deep: deep ? true : undefined },
					{ replace: true },
				);
			}}
			playback={playback}
		/>
	);
}
