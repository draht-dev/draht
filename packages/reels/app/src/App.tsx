import { useEffect, useState } from "react";
import { Feed } from "./components/Feed.js";
import { Home } from "./components/Home.js";
import { Playlist } from "./components/Playlist.js";
import { Profile } from "./components/Profile.js";
import { useFeed } from "./hooks/useFeed.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { usePlaybackPreference } from "./hooks/usePlaybackPreference.js";
import { useRepoIndex } from "./hooks/useRepoIndex.js";

/** Reel ids currently playing from a release playlist, and its tag (so navigating away from that reel, e.g. via the "All" grid, drops the scope). */
type PlaylistScope = { tag: string; reelIds: string[] };

export function App() {
	const repoIndexState = useRepoIndex();
	const [route, navigate] = useHashRoute();
	const playback = usePlaybackPreference();
	const [playlistScope, setPlaylistScope] = useState<PlaylistScope | undefined>(undefined);

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
				onOpenReel={(reelId) => {
					setPlaylistScope(undefined);
					navigate({ kind: "reel", repo: route.repo, reelId });
				}}
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
					setPlaylistScope({ tag: route.tag, reelIds });
					const first = reelIds[0];
					if (first) navigate({ kind: "reel", repo: route.repo, reelId: first });
				}}
				onOpenReel={(reelId) => {
					setPlaylistScope({ tag: route.tag, reelIds: [reelId] });
					navigate({ kind: "reel", repo: route.repo, reelId });
				}}
				onBack={() => navigate({ kind: "repo", repo: route.repo })}
			/>
		);
	}

	const scopedIds =
		playlistScope && playlistScope.reelIds.includes(route.reelId) ? playlistScope.reelIds : undefined;

	return (
		<Feed
			feed={feed}
			reelIds={scopedIds}
			initialReelId={route.reelId}
			initialDeepDive={route.deep}
			onActiveReelChange={(reelId) => {
				if (reelId !== route.reelId) navigate({ kind: "reel", repo: route.repo, reelId }, { replace: true });
			}}
			playback={playback}
		/>
	);
}
