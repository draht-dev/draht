import { useEffect, useMemo, useRef, useState } from "react";
import type { Feed, ReelEntry } from "../../../src/contract.js";
import { initials } from "../lib/initials.js";
import { publishedReels, visiblePlaylists } from "../lib/playlists.js";

const PAGE_SIZE = 12;

function PosterTile({ reel }: { reel: ReelEntry }) {
	const [failed, setFailed] = useState(false);

	if (reel.poster && !failed) {
		return <img src={reel.poster} alt="" loading="lazy" className="poster-image" onError={() => setFailed(true)} />;
	}

	return (
		<div className="poster-fallback">
			<p className="poster-fallback-title">{reel.title}</p>
			<p className="poster-fallback-stats">
				+{reel.stats.additions} -{reel.stats.deletions}
			</p>
		</div>
	);
}

function ReleaseRow({ feed, onOpenRelease }: { feed: Feed; onOpenRelease: (tag: string) => void }) {
	const playlists = useMemo(() => visiblePlaylists(feed), [feed]);
	if (playlists.length === 0) return null;

	const byId = new Map(feed.reels.map((reel) => [reel.id, reel] as const));

	return (
		<div className="profile-releases">
			<h2 className="profile-releases-heading">Releases</h2>
			<div className="profile-releases-row">
				{playlists.map((playlist) => {
					const label = playlist.date.slice(0, 10);
					if (playlist.tiny) {
						return (
							<button
								type="button"
								key={playlist.tag}
								className="release-chip"
								onClick={() => onOpenRelease(playlist.tag)}
							>
								<span className="release-chip-tag">{playlist.tag}</span>
								<span className="release-chip-meta">
									{label} · {playlist.storyIds.length} {playlist.storyIds.length === 1 ? "story" : "stories"}
								</span>
							</button>
						);
					}

					const overview = playlist.overviewId ? byId.get(playlist.overviewId) : undefined;
					const fallbackStory = overview ? undefined : byId.get(playlist.storyIds[0] ?? "");
					const posterReel = overview ?? fallbackStory;

					return (
						<button type="button" key={playlist.tag} className="release-card" onClick={() => onOpenRelease(playlist.tag)}>
							<div className="release-card-poster">{posterReel ? <PosterTile reel={posterReel} /> : null}</div>
							<span className="release-card-tag">{playlist.tag}</span>
							<span className="release-card-meta">
								{label} · {playlist.storyIds.length} {playlist.storyIds.length === 1 ? "story" : "stories"}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function Profile({
	feed,
	onOpenReel,
	onOpenRelease,
}: {
	feed: Feed;
	onOpenReel: (reelId: string) => void;
	onOpenRelease: (tag: string) => void;
}) {
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	// Drafts (owner decision 2026-10-05: LLM-written reels are drafts until approved) are never shown.
	const reels = useMemo(() => publishedReels(feed), [feed]);
	const totals = useMemo(
		() =>
			reels.reduce(
				(acc, reel) => ({ additions: acc.additions + reel.stats.additions, deletions: acc.deletions + reel.stats.deletions }),
				{ additions: 0, deletions: 0 },
			),
		[reels],
	);
	const visibleReels = reels.slice(0, visibleCount);
	const sentinelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel || visibleCount >= reels.length) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setVisibleCount((count) => Math.min(count + PAGE_SIZE, reels.length));
			}
		});
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [visibleCount, reels.length]);

	return (
		<div className="profile">
			<header className="profile-header">
				<div className="profile-avatar" aria-hidden="true">
					{initials(feed.repo.name)}
				</div>
				<h1 className="profile-name">{feed.repo.name}</h1>
				<p className="profile-meta">
					{reels.length} reels · +{totals.additions} -{totals.deletions}
				</p>
				{feed.repo.url && (
					<a className="profile-link" href={feed.repo.url} target="_blank" rel="noreferrer">
						{feed.repo.url}
					</a>
				)}
			</header>

			<ReleaseRow feed={feed} onOpenRelease={onOpenRelease} />

			<h2 className="profile-all-heading">All</h2>
			<div className="profile-grid" role="list">
				{visibleReels.map((reel) => (
					<button
						type="button"
						key={reel.id}
						className="profile-grid-item"
						role="listitem"
						onClick={() => onOpenReel(reel.id)}
						aria-label={reel.title}
					>
						<PosterTile reel={reel} />
					</button>
				))}
			</div>

			{visibleCount < reels.length && (
				<div ref={sentinelRef} className="profile-load-more-sentinel">
					<button
						type="button"
						className="profile-load-more"
						onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, reels.length))}
					>
						Load more
					</button>
				</div>
			)}
		</div>
	);
}
