import type { PlaybackMode, PlaybackPreference } from "../lib/mode.js";
import { AudioIcon, DeepDiveIcon, MuteIcon, SourcesIcon, UnmuteIcon, VideoIcon } from "./icons.js";

/** Right-side vertical rail of round icon buttons, TikTok-style: mode selection, deep dive, sources, plus mute. */
export function ActionRail({
	mode,
	hasVideo,
	onSetPreference,
	muted,
	onToggleMute,
	hasDeepDive,
	viewingDeepDive,
	onToggleDeepDive,
	hasSources,
	onOpenSources,
}: {
	mode: PlaybackMode;
	hasVideo: boolean;
	onSetPreference: (preference: PlaybackPreference) => void;
	muted: boolean;
	onToggleMute: () => void;
	hasDeepDive: boolean;
	viewingDeepDive: boolean;
	onToggleDeepDive: () => void;
	hasSources: boolean;
	onOpenSources: () => void;
}) {
	return (
		<div className="reel-action-rail">
			<div className="rail-item">
				<button
					type="button"
					className="rail-icon-btn"
					aria-pressed={mode === "visual"}
					aria-label={hasVideo ? "Switch to video" : "No video available for this reel"}
					disabled={!hasVideo}
					onClick={() => onSetPreference("visual")}
				>
					<VideoIcon />
				</button>
				<span className="rail-label">{hasVideo ? "Video" : "No video"}</span>
			</div>

			<div className="rail-item">
				<button
					type="button"
					className="rail-icon-btn"
					aria-pressed={mode === "audio" || mode === "slideshow"}
					aria-label="Switch to audio"
					onClick={() => onSetPreference("audio")}
				>
					<AudioIcon />
				</button>
				<span className="rail-label">Audio</span>
			</div>

			{(mode === "visual" || mode === "audio") && (
				<div className="rail-item">
					<button
						type="button"
						className="rail-icon-btn"
						aria-pressed={muted}
						aria-label={muted ? "Unmute" : "Mute"}
						onClick={onToggleMute}
					>
						{muted ? <MuteIcon /> : <UnmuteIcon />}
					</button>
					<span className="rail-label">{muted ? "Muted" : "Sound"}</span>
				</div>
			)}

			{hasDeepDive && (
				<div className="rail-item">
					<button
						type="button"
						className="rail-icon-btn"
						aria-pressed={viewingDeepDive}
						aria-label={viewingDeepDive ? "Back to the short" : "Watch the deep dive"}
						onClick={onToggleDeepDive}
					>
						<DeepDiveIcon />
					</button>
					<span className="rail-label">{viewingDeepDive ? "Back" : "Deep dive"}</span>
				</div>
			)}

			{hasSources && (
				<div className="rail-item">
					<button type="button" className="rail-icon-btn" aria-label="Show sources" onClick={onOpenSources}>
						<SourcesIcon />
					</button>
					<span className="rail-label">Sources</span>
				</div>
			)}
		</div>
	);
}
