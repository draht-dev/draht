/**
 * Pure color/opacity logic for {@link CodeScene.tsx}'s diff lines, kept out
 * of the component so contrast can be asserted in a unit test without
 * Remotion or a DOM. See `theme.ts` for the underlying palette and the
 * `blendOver`/`contrastRatio` WCAG helpers.
 */

import { COLOR, hexToRgba } from "../theme.ts";

export type LineRole = "context" | "addition" | "deletion";

/** A focused line's text is opaque; readability there must beat the old scheme outright. */
export const FOCUSED_OPACITY = 1;
/**
 * An unfocused line stays legible (WCAG "large text" ≥3:1 even after
 * dimming), not near-invisible — 0.6 was picked as the top of the task's
 * 0.5–0.6 range, since diff-colored unfocused lines have the least contrast
 * margin to begin with (see `code-colors.test.ts`).
 */
export const UNFOCUSED_OPACITY = 0.6;
/** Alpha of a diff line's background tint over the code panel's Foundry Ink 2. Subtle, never a loud fill. */
export const DIFF_TINT_ALPHA = 0.08;

export function lineRole(line: string): LineRole {
	if (line.startsWith("+")) return "addition";
	if (line.startsWith("-")) return "deletion";
	return "context";
}

/** The line's text color at full strength — the same color at every focus state; only opacity changes with focus (see {@link FOCUSED_OPACITY}/{@link UNFOCUSED_OPACITY}). */
export function lineTextColor(role: LineRole): string {
	if (role === "addition") return COLOR.patina;
	if (role === "deletion") return COLOR.rust;
	return COLOR.weatheredPaper;
}

/** The line's background tint (`rgba(...)` for CSS), or `undefined` for a context line (no tint, just the code panel's own background). */
export function lineBackground(role: LineRole): string | undefined {
	if (role === "addition") return hexToRgba(COLOR.patina, DIFF_TINT_ALPHA);
	if (role === "deletion") return hexToRgba(COLOR.rust, DIFF_TINT_ALPHA);
	return undefined;
}
