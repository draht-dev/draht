import type { Scene, TranscriptSegment } from "../contract.ts";

export const REEL_COMPOSITION_ID = "Reel";
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_FPS = 30;

/**
 * The feed PWA overlays its own UI on top of the video: a title/meta/stats
 * block across the bottom ~22% of the frame, and a vertical button rail
 * across the right ~12%. Every scene's content and captions must stay
 * inside this box so the burned-in video never collides with that overlay.
 * Exported so the app agent can reference the same numbers in docs/CSS.
 */
export const SAFE_ZONE_X_MIN = 56;
export const SAFE_ZONE_X_MAX = 940;
export const SAFE_ZONE_Y_MIN = 120;
export const SAFE_ZONE_Y_MAX = 1440;
export const SAFE_ZONE_WIDTH = SAFE_ZONE_X_MAX - SAFE_ZONE_X_MIN;
export const SAFE_ZONE_HEIGHT = SAFE_ZONE_Y_MAX - SAFE_ZONE_Y_MIN;

/** The caption sits at the bottom of the safe zone, under the scene content. */
export const CAPTION_Y_MIN = 1300;
export const CAPTION_Y_MAX = SAFE_ZONE_Y_MAX;
export const CAPTION_HEIGHT = CAPTION_Y_MAX - CAPTION_Y_MIN;

/** Scene content (above the caption, with a small gap before it) fills the rest of the safe zone. */
export const SCENE_CONTENT_Y_MAX = CAPTION_Y_MIN - 20;
export const SCENE_CONTENT_HEIGHT = SCENE_CONTENT_Y_MAX - SAFE_ZONE_Y_MIN;

export interface ReelFrameProps extends Record<string, unknown> {
	scenes: Scene[];
	transcript: TranscriptSegment[];
	/** staticFile() path or absolute URL; absent when TTS was disabled. */
	audioSrc?: string;
}

export const DEFAULT_REEL_PROPS: ReelFrameProps = {
	scenes: [
		{ kind: "title", title: "Example reel", subtitle: "draht-mono", narration: "Example reel." },
		{ kind: "outro", narration: "That is the full change." },
	],
	transcript: [
		{ sceneIndex: 0, text: "Example reel.", startMs: 0, endMs: 2000 },
		{ sceneIndex: 1, text: "That is the full change.", startMs: 2000, endMs: 3500 },
	],
};

export function transcriptDurationMs(transcript: TranscriptSegment[]): number {
	return transcript.reduce((max, segment) => Math.max(max, segment.endMs), 0);
}

/** Converts a millisecond offset to a frame count. Does not floor to 1: a scene legitimately starting at ms=0 must land on frame 0, not frame 1 (which would leave frame 0 blank). Callers needing a minimum total duration (e.g. a whole composition) apply their own `Math.max(1, ...)`. */
export function msToFrames(ms: number, fps: number = REEL_FPS): number {
	return Math.round((ms / 1000) * fps);
}
