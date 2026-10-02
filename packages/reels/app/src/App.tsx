import { useEffect } from "react";
import { Feed } from "./components/Feed.js";
import { Home } from "./components/Home.js";
import { Profile } from "./components/Profile.js";
import { useFeed } from "./hooks/useFeed.js";
import { useHashRoute } from "./hooks/useHashRoute.js";
import { usePlaybackPreference } from "./hooks/usePlaybackPreference.js";
import { useRepoIndex } from "./hooks/useRepoIndex.js";

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

	if (route.kind === "repo") {
		return (
			<Profile feed={feedState.feed} onOpenReel={(reelId) => navigate({ kind: "reel", repo: route.repo, reelId })} />
		);
	}

	return (
		<Feed
			feed={feedState.feed}
			initialReelId={route.reelId}
			playback={playback}
			onActiveReelChange={(reelId) => {
				if (reelId !== route.reelId) navigate({ kind: "reel", repo: route.repo, reelId }, { replace: true });
			}}
		/>
	);
}
