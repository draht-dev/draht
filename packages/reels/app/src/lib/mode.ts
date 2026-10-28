import type { ReelEntry } from "../../../src/contract.js";

export type PlaybackPreference = "visual" | "audio";
export type PlaybackMode = "visual" | "audio" | "slideshow";

/**
 * Resolves the user's visual/audio preference against what a reel actually
 * ships. "visual" falls back to "audio" (and then the silent slideshow) when
 * no video exists. "audio" never falls back to video: it is the narrated
 * scene track, so when there is no audio file it falls back to the silent
 * scene slideshow, advancing by transcript timing, same as it would for a
 * reel with neither asset.
 */
export function resolvePlaybackMode(preferred: PlaybackPreference, reel: Pick<ReelEntry, "video" | "audio">): PlaybackMode {
	const hasVideo = Boolean(reel.video);
	const hasAudio = Boolean(reel.audio);

	if (preferred === "visual") {
		if (hasVideo) return "visual";
		if (hasAudio) return "audio";
		return "slideshow";
	}

	return hasAudio ? "audio" : "slideshow";
}
