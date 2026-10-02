import { useCallback, useEffect, useMemo, useState } from "react";
import type { Feed, ReelEntry } from "../../../src/contract.js";
import { type PlaybackPreference, resolvePlaybackMode } from "../lib/mode.js";
import { ActionRail } from "./ActionRail.js";
import { AudioPlayer } from "./AudioPlayer.js";
import { SlideshowPlayer } from "./SlideshowPlayer.js";
import { VisualPlayer } from "./VisualPlayer.js";

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function relativeDate(iso: string): string {
	const deltaMs = Date.now() - new Date(iso).getTime();
	const days = Math.floor(deltaMs / 86_400_000);
	if (days <= 0) return "today";
	if (days === 1) return "1 day ago";
	if (days < 30) return `${days} days ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} mo ago`;
	return `${Math.floor(months / 12)} yr ago`;
}

export function ReelCard({
	reel,
	repo,
	active,
	preference,
	onSetPreference,
	muted,
	onToggleMute,
	onEnded,
	preload,
}: {
	reel: ReelEntry;
	repo: Feed["repo"];
	active: boolean;
	preference: PlaybackPreference;
	onSetPreference: (preference: PlaybackPreference) => void;
	muted: boolean;
	onToggleMute: () => void;
	onEnded: () => void;
	preload: "auto" | "metadata" | "none";
}) {
	const mode = useMemo(() => resolvePlaybackMode(preference, reel), [preference, reel]);
	const [progress, setProgress] = useState(0);
	const onProgress = useCallback((fraction: number) => setProgress(Math.min(1, Math.max(0, fraction))), []);

	const primarySha = reel.commits[0];
	const commitHref = primarySha ? repo.commitUrlTemplate?.replace("{sha}", primarySha) : undefined;

	// Only the active card may own the system media session: otherwise every
	// mounted (but off-screen) card's effect would overwrite it on mount, and
	// whichever rendered last would arbitrarily win regardless of what is
	// actually playing.
	useEffect(() => {
		if (!active || !("mediaSession" in navigator)) return;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: reel.title,
			artist: reel.authors.join(", "),
		});
		return () => {
			navigator.mediaSession.metadata = null;
		};
	}, [active, reel]);

	return (
		<section className="reel-card" aria-label={reel.title}>
			<div className="reel-media">
				{mode === "visual" && (
					<VisualPlayer reel={reel} active={active} muted={muted} preload={preload} onEnded={onEnded} onProgress={onProgress} />
				)}
				{mode === "audio" && (
					<AudioPlayer reel={reel} active={active} muted={muted} preload={preload} onEnded={onEnded} onProgress={onProgress} />
				)}
				{mode === "slideshow" && <SlideshowPlayer reel={reel} active={active} onEnded={onEnded} onProgress={onProgress} />}
			</div>

			<div className="reel-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
				<div className="reel-progress-bar" style={{ width: `${progress * 100}%` }} />
			</div>

			<ActionRail
				mode={mode}
				hasVideo={Boolean(reel.video)}
				onSetPreference={onSetPreference}
				muted={muted}
				onToggleMute={onToggleMute}
			/>

			<div className="reel-overlay">
				<h1 className="reel-title">{reel.title}</h1>
				<p className="reel-meta-line">
					{primarySha &&
						(commitHref ? (
							<a href={commitHref} target="_blank" rel="noreferrer" className="reel-sha">
								{shortSha(primarySha)}
							</a>
						) : (
							<span className="reel-sha">{shortSha(primarySha)}</span>
						))}
					{" · "}
					{reel.authors.join(", ")}
					{" · "}
					{relativeDate(reel.date)}
				</p>
				<p className="reel-stats-line">
					{reel.stats.files} files · <span className="stat-add">+{reel.stats.additions}</span>{" "}
					<span className="stat-del">-{reel.stats.deletions}</span>
				</p>
			</div>
		</section>
	);
}
