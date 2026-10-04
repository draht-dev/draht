import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { CodeScene as CodeSceneData } from "../../contract.ts";
import { activeBeatIndex, framesSinceBeatStart } from "../beats.ts";
import {
	charsPerRow,
	CODE_LINE_HEIGHT_PX,
	CODE_PADDING_PX,
	layoutRows,
	normalizeFocusLines,
	scrollTargetPx,
} from "./code-scroll.ts";
import { CODE_FONT_FAMILY } from "../fonts.ts";
import { SAFE_ZONE_WIDTH, SCENE_CONTENT_HEIGHT } from "../props.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

function lineColor(line: string): { color: string; background?: string } {
	if (line.startsWith("+")) return { color: "#bbf7d0", background: "rgba(22,163,74,0.18)" };
	if (line.startsWith("-")) return { color: "#fecaca", background: "rgba(220,38,38,0.18)" };
	return { color: "#cbd5e1" };
}

const REVEAL_FRAMES_PER_LINE = 3;
const FOCUS_TRANSITION_FRAMES = 8;
const DIMMED_OPACITY = 0.35;
const PATH_ROW_HEIGHT_PX = 54; // fontSize 28 row plus its 20px bottom margin
const CODE_FONT_STACK = `"${CODE_FONT_FAMILY}", ui-monospace, Menlo, Consolas, monospace`;

/** 1 for a focused line, {@link DIMMED_OPACITY} for a line outside the focus range, 1 when there is no focus at all. */
function focusOpacity(lineNumber: number, focusLines: [number, number] | undefined): number {
	if (!focusLines) return 1;
	return lineNumber >= focusLines[0] && lineNumber <= focusLines[1] ? 1 : DIMMED_OPACITY;
}

export function CodeScene({ scene, beatStartFrames }: { scene: CodeSceneData; beatStartFrames?: number[] }) {
	const frame = useCurrentFrame();
	const beats = scene.beats;
	const beatIndex = activeBeatIndex(beatStartFrames, frame);
	const beatFrame = framesSinceBeatStart(beatStartFrames, beatIndex, frame);
	const progress = interpolate(beatFrame, [0, FOCUS_TRANSITION_FRAMES], [0, 1], { extrapolateRight: "clamp" });

	const currentFocusLines = normalizeFocusLines(
		beatIndex >= 0 ? beats?.[beatIndex]?.focus?.lines : undefined,
		scene.lines.length,
	);
	const previousFocusLines = normalizeFocusLines(
		beatIndex >= 1 ? beats?.[beatIndex - 1]?.focus?.lines : undefined,
		scene.lines.length,
	);

	const codeBoxWidthPx = SAFE_ZONE_WIDTH;
	const charsPerRowCount = charsPerRow(codeBoxWidthPx);
	const layout = layoutRows(scene.lines, charsPerRowCount);
	const visibleHeightPx = SCENE_CONTENT_HEIGHT - PATH_ROW_HEIGHT_PX;

	// Ease from the previous beat's *actual* rendered offset (which is 0/top when that beat
	// had no focus — scrollTargetPx already returns that for `undefined`), never from a
	// guessed stand-in, so the block never visibly jumps at a beat boundary.
	const previousOffsetPx = scrollTargetPx(previousFocusLines, layout, visibleHeightPx);
	const targetOffsetPx = scrollTargetPx(currentFocusLines, layout, visibleHeightPx);
	const scrollOffsetPx = interpolate(progress, [0, 1], [previousOffsetPx, targetOffsetPx]);

	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			<SafeZoneContent>
				<div
					style={{
						color: "#94a3b8",
						fontSize: 28,
						fontFamily: CODE_FONT_STACK,
						marginBottom: 20,
						flexShrink: 0,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{scene.path}
				</div>
				<div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 0 }}>
					<div
						style={{
							backgroundColor: "#111827",
							borderRadius: 16,
							padding: CODE_PADDING_PX,
							fontFamily: CODE_FONT_STACK,
							fontSize: 34,
							lineHeight: 1.5,
							maxHeight: "100%",
							overflow: "hidden",
						}}
					>
						<div style={{ transform: `translateY(${-scrollOffsetPx}px)` }}>
							{scene.lines.map((line, i) => {
								const reveal = interpolate(frame, [i * REVEAL_FRAMES_PER_LINE, i * REVEAL_FRAMES_PER_LINE + 8], [0, 1], {
									extrapolateRight: "clamp",
								});
								const lineNumber = i + 1;
								const dimOpacity = interpolate(
									progress,
									[0, 1],
									[focusOpacity(lineNumber, previousFocusLines), focusOpacity(lineNumber, currentFocusLines)],
								);
								const isFocused = currentFocusLines ? focusOpacity(lineNumber, currentFocusLines) === 1 : false;
								const marker = line.slice(0, 1) || " ";
								const code = line.slice(1);
								const { color, background } = lineColor(line);
								return (
									// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
									<div
										key={i}
										style={{
											display: "flex",
											color,
											background,
											opacity: reveal * dimOpacity,
											borderLeft: isFocused ? "4px solid #38bdf8" : "4px solid transparent",
											paddingLeft: 8,
											marginLeft: -12,
											lineHeight: `${CODE_LINE_HEIGHT_PX}px`,
										}}
									>
										<span style={{ flexShrink: 0, width: "1.5ch", whiteSpace: "pre" }}>{marker}</span>
										<span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{code}</span>
									</div>
								);
							})}
						</div>
					</div>
				</div>
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
