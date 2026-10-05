import { useEffect, useMemo, useRef, useState } from "react";
import type { Feed as FeedData } from "../../../src/contract.js";
import { DEFAULT_APP_KEYBINDINGS } from "../lib/keybindings.js";
import { matchesKeyBinding } from "../lib/matchesKeyBinding.js";
import { publishedReels, reelsByIds } from "../lib/playlists.js";
import { pickMostVisible } from "../lib/visibility.js";
import { ReelCard } from "./ReelCard.js";
import type { usePlaybackPreference } from "../hooks/usePlaybackPreference.js";

export function Feed({
	feed,
	reelIds,
	initialReelId,
	initialDeepDive,
	onActiveReelChange,
	playback,
}: {
	feed: FeedData;
	/** Scopes and orders the feed to a release playlist's reels; absent plays every published reel, newest first. */
	reelIds?: string[];
	initialReelId: string | undefined;
	initialDeepDive?: boolean;
	onActiveReelChange: (reelId: string) => void;
	playback: ReturnType<typeof usePlaybackPreference>;
}) {
	// Drafts (owner decision 2026-10-05: LLM-written reels are drafts until approved)
	// are never shown, in any feed view.
	const reels = useMemo(() => (reelIds ? reelsByIds(feed, reelIds) : publishedReels(feed)), [feed, reelIds]);
	const containerRef = useRef<HTMLDivElement>(null);
	const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
	const initialIndex = useMemo(() => {
		const index = reels.findIndex((reel) => reel.id === initialReelId);
		return index >= 0 ? index : 0;
	}, [reels, initialReelId]);
	const [activeIndex, setActiveIndex] = useState(initialIndex);
	// The reel id this component itself last reported up via
	// onActiveReelChange. App.tsx echoes that id straight back as the next
	// initialReelId (via history.replaceState while scrolling, see useHashRoute),
	// so without this guard every scroll-driven activeIndex change would
	// round-trip into a forced `scrollIntoView` fighting the scroll that
	// caused it in the first place.
	const lastReportedReelId = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (initialReelId !== undefined && initialReelId === lastReportedReelId.current) return;
		const target = sectionRefs.current.get(reels[initialIndex]?.id ?? "");
		target?.scrollIntoView({ block: "start" });
	}, [reels, initialIndex, initialReelId]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		// A single 0.5 threshold only fires when a reel crosses that exact
		// ratio, which a fast scroll can skip past entirely. Observing several
		// thresholds and tracking every observed reel's latest known ratio
		// (entries only report what changed, not the full set) lets us always
		// pick the most-visible reel rather than the first one to cross 0.5.
		const ratios = new Map<string, number>();

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const reelId = entry.target.getAttribute("data-reel-id");
					if (reelId) ratios.set(reelId, entry.intersectionRatio);
				}
				const bestId = pickMostVisible(ratios);
				if (!bestId) return;
				const index = reels.findIndex((reel) => reel.id === bestId);
				if (index >= 0) setActiveIndex(index);
			},
			{ root: container, threshold: [0, 0.5, 0.75, 1] },
		);

		for (const element of sectionRefs.current.values()) observer.observe(element);
		return () => observer.disconnect();
	}, [reels]);

	useEffect(() => {
		const reel = reels[activeIndex];
		if (reel) {
			lastReportedReelId.current = reel.id;
			onActiveReelChange(reel.id);
		}
	}, [activeIndex, reels, onActiveReelChange]);

	const goToIndex = (index: number) => {
		const clamped = Math.min(Math.max(index, 0), reels.length - 1);
		const target = sectionRefs.current.get(reels[clamped]?.id ?? "");
		target?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (matchesKeyBinding(event, DEFAULT_APP_KEYBINDINGS.nextReel)) {
				event.preventDefault();
				goToIndex(activeIndex + 1);
			} else if (matchesKeyBinding(event, DEFAULT_APP_KEYBINDINGS.previousReel)) {
				event.preventDefault();
				goToIndex(activeIndex - 1);
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [activeIndex, reels]);

	useEffect(() => {
		if (!("mediaSession" in navigator)) return;
		navigator.mediaSession.setActionHandler("nexttrack", () => goToIndex(activeIndex + 1));
		navigator.mediaSession.setActionHandler("previoustrack", () => goToIndex(activeIndex - 1));
		return () => {
			navigator.mediaSession.setActionHandler("nexttrack", null);
			navigator.mediaSession.setActionHandler("previoustrack", null);
		};
	}, [activeIndex, reels]);

	return (
		<div ref={containerRef} className="feed">
			{reels.map((reel, index) => (
				<div
					key={reel.id}
					data-reel-id={reel.id}
					className="feed-slide"
					ref={(element) => {
						if (element) sectionRefs.current.set(reel.id, element);
						else sectionRefs.current.delete(reel.id);
					}}
				>
					<ReelCard
						reel={reel}
						repo={feed.repo}
						active={index === activeIndex}
						preference={playback.preference}
						onSetPreference={playback.setPreference}
						muted={playback.muted}
						onToggleMute={() => playback.setMuted(!playback.muted)}
						onEnded={() => goToIndex(index + 1)}
						// Buffering priority only: the browser's `preload` fetches media
						// incrementally and stops when the user scrolls away. Offline
						// caching is triggered by the players on `canplaythrough`.
						preload={index === activeIndex ? "auto" : index === activeIndex + 1 ? "metadata" : "none"}
						initialDeepDive={reel.id === initialReelId ? initialDeepDive : undefined}
					/>
				</div>
			))}
		</div>
	);
}
