import { useMemo, useState } from "react";
import type { Feed, ReelEntry, ReleasePlaylist } from "../../../src/contract.js";
import { playlistReelIds, publishedReels } from "../lib/playlists.js";

function PosterTile({ reel }: { reel: ReelEntry }) {
	const [failed, setFailed] = useState(false);
	if (reel.poster && !failed) {
		return <img src={reel.poster} alt="" loading="lazy" className="poster-image" onError={() => setFailed(true)} />;
	}
	return (
		<div className="poster-fallback">
			<p className="poster-fallback-title">{reel.title}</p>
		</div>
	);
}

function StoryRow({ reels, onOpenReel }: { reels: ReelEntry[]; onOpenReel: (reelId: string) => void }) {
	if (reels.length === 0) return null;
	return (
		<div className="playlist-row">
			{reels.map((reel) => (
				<button type="button" key={reel.id} className="playlist-row-item" onClick={() => onOpenReel(reel.id)} aria-label={reel.title}>
					<PosterTile reel={reel} />
					<span className="playlist-row-title">{reel.title}</span>
				</button>
			))}
		</div>
	);
}

/** A release's full playlist page: overview first, stories grouped by theme, then the upstream-sync line. */
export function Playlist({
	feed,
	playlist,
	onPlay,
	onOpenReel,
	onBack,
}: {
	feed: Feed;
	playlist: ReleasePlaylist;
	onPlay: (reelIds: string[]) => void;
	onOpenReel: (reelId: string) => void;
	onBack: () => void;
}) {
	const published = useMemo(() => new Set(publishedReels(feed).map((reel) => reel.id)), [feed]);
	const byId = useMemo(() => new Map(feed.reels.map((reel) => [reel.id, reel] as const)), [feed]);
	const orderedIds = useMemo(() => playlistReelIds(playlist, feed), [playlist, feed]);
	const overview = playlist.overviewId && published.has(playlist.overviewId) ? byId.get(playlist.overviewId) : undefined;

	return (
		<div className="playlist">
			<header className="playlist-header">
				<button type="button" className="playlist-back" onClick={onBack} aria-label="Back to profile">
					←
				</button>
				<div>
					<h1 className="playlist-title">{playlist.title || playlist.tag}</h1>
					<p className="playlist-meta">
						{playlist.date.slice(0, 10)} · {playlist.storyIds.length} {playlist.storyIds.length === 1 ? "story" : "stories"}
					</p>
				</div>
				{orderedIds.length > 0 && (
					<button type="button" className="playlist-play" onClick={() => onPlay(orderedIds)}>
						Play all
					</button>
				)}
			</header>

			{overview && (
				<section className="playlist-section">
					<StoryRow reels={[overview]} onOpenReel={onOpenReel} />
				</section>
			)}

			{playlist.themes.map((theme) => {
				const reels = theme.storyIds.map((id) => byId.get(id)).filter((reel): reel is ReelEntry => reel !== undefined && published.has(reel.id));
				if (reels.length === 0) return null;
				return (
					<section className="playlist-section" key={theme.name}>
						<h2 className="playlist-section-heading">{theme.name}</h2>
						<StoryRow reels={reels} onOpenReel={onOpenReel} />
					</section>
				);
			})}

			{(() => {
				const recaps = playlist.syncs
					.map((sync) => (sync.recapId ? byId.get(sync.recapId) : undefined))
					.filter((reel): reel is ReelEntry => reel !== undefined && published.has(reel.id));
				return (
					recaps.length > 0 && (
						<section className="playlist-section">
							<h2 className="playlist-section-heading">Upstream sync recaps</h2>
							<StoryRow reels={recaps} onOpenReel={onOpenReel} />
						</section>
					)
				);
			})()}

			{playlist.syncs.length > 0 && (
				<p className="playlist-syncs-line">
					Also:{" "}
					{playlist.syncs
						.map((sync) => `${sync.title}, ${sync.commitCount} commit${sync.commitCount === 1 ? "" : "s"}`)
						.join("; ")}
				</p>
			)}
		</div>
	);
}
