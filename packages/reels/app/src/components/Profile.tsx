import { useEffect, useMemo, useRef, useState } from "react";
import type { Feed, ReelEntry } from "../../../src/contract.js";
import { initials } from "../lib/initials.js";

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

export function Profile({ feed, onOpenReel }: { feed: Feed; onOpenReel: (reelId: string) => void }) {
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const totals = useMemo(
		() =>
			feed.reels.reduce(
				(acc, reel) => ({ additions: acc.additions + reel.stats.additions, deletions: acc.deletions + reel.stats.deletions }),
				{ additions: 0, deletions: 0 },
			),
		[feed.reels],
	);
	const visibleReels = feed.reels.slice(0, visibleCount);
	const sentinelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!sentinel || visibleCount >= feed.reels.length) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				setVisibleCount((count) => Math.min(count + PAGE_SIZE, feed.reels.length));
			}
		});
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [visibleCount, feed.reels.length]);

	return (
		<div className="profile">
			<header className="profile-header">
				<div className="profile-avatar" aria-hidden="true">
					{initials(feed.repo.name)}
				</div>
				<h1 className="profile-name">{feed.repo.name}</h1>
				<p className="profile-meta">
					{feed.reels.length} reels · +{totals.additions} -{totals.deletions}
				</p>
				{feed.repo.url && (
					<a className="profile-link" href={feed.repo.url} target="_blank" rel="noreferrer">
						{feed.repo.url}
					</a>
				)}
			</header>

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

			{visibleCount < feed.reels.length && (
				<div ref={sentinelRef} className="profile-load-more-sentinel">
					<button
						type="button"
						className="profile-load-more"
						onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, feed.reels.length))}
					>
						Load more
					</button>
				</div>
			)}
		</div>
	);
}
