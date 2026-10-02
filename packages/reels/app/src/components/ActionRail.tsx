import type { PlaybackMode, PlaybackPreference } from "../lib/mode.js";
import { AudioIcon, MuteIcon, UnmuteIcon, VideoIcon } from "./icons.js";

/** Right-side vertical rail of round icon buttons, TikTok-style: mode selection plus mute. */
export function ActionRail({
	mode,
	hasVideo,
	onSetPreference,
	muted,
	onToggleMute,
}: {
	mode: PlaybackMode;
	hasVideo: boolean;
	onSetPreference: (preference: PlaybackPreference) => void;
	muted: boolean;
	onToggleMute: () => void;
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
		</div>
	);
}
