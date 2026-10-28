import type { Focus } from "../../../src/contract.js";
import { normalizeFocusLines } from "../../../src/remotion/scenes/code-scroll.ts";

export type CodeLineState = "focused" | "dimmed" | "normal";

/**
 * Per-line highlight state for a code scene's `lines`, mirroring the video
 * engine's `CodeScene.tsx` semantics (via `code-scroll.ts`'s
 * `normalizeFocusLines`): with no focus every line is `normal`; with a
 * focus, lines inside the (clamped, order-independent) range are `focused`
 * and the rest `dimmed`.
 */
export function codeLineStates(lineCount: number, focus: Focus | undefined): CodeLineState[] {
	const range = normalizeFocusLines(focus?.lines, lineCount);
	return Array.from({ length: lineCount }, (_, index): CodeLineState => {
		if (!range) return "normal";
		const lineNumber = index + 1;
		return lineNumber >= range[0] && lineNumber <= range[1] ? "focused" : "dimmed";
	});
}
