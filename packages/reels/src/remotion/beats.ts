/**
 * Shared beat-timing math for scenes that light up part of their picture
 * while a beat is spoken (code lines, diagram nodes, title subtitle).
 * `beatStartFrames` is scene-relative (frame 0 = the scene's own start),
 * parallel to `scene.beats`; see `Reel.tsx` for where it is derived from
 * `TranscriptSegment.beatStartsMs`.
 */

/** Index of the beat active at `frame`, or -1 when there are no beats (or none have started yet). */
export function activeBeatIndex(beatStartFrames: number[] | undefined, frame: number): number {
	if (!beatStartFrames || beatStartFrames.length === 0) return -1;
	let index = -1;
	for (let i = 0; i < beatStartFrames.length; i++) {
		if (frame >= beatStartFrames[i]) index = i;
		else break;
	}
	return index;
}

/** Frames since the active beat started, clamped to 0 so a scene with no active beat yet does not animate. */
export function framesSinceBeatStart(
	beatStartFrames: number[] | undefined,
	activeIndex: number,
	frame: number,
): number {
	if (activeIndex < 0 || !beatStartFrames) return 0;
	return Math.max(0, frame - beatStartFrames[activeIndex]);
}
