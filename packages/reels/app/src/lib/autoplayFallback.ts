export type AutoplayGesture = "play" | "unmute" | null;

/**
 * What affordance to show after an autoplay attempt was rejected by the
 * browser's gesture policy. `desiredMuted` is the user's stored preference,
 * never mutated by this fallback; `mutedRetrySucceeded` is only meaningful
 * (and only attempted) when the initial attempt wanted sound.
 */
export function resolveAutoplayGesture(desiredMuted: boolean, mutedRetrySucceeded: boolean): AutoplayGesture {
	if (desiredMuted) return "play";
	return mutedRetrySucceeded ? "unmute" : "play";
}
