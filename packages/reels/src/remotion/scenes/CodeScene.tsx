import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { CodeScene as CodeSceneData } from "../../contract.ts";
import { activeBeatIndex, framesSinceBeatStart } from "../beats.ts";
import { FOCUSED_OPACITY, lineBackground, lineRole, lineTextColor, UNFOCUSED_OPACITY } from "./code-colors.ts";
import {
	charsPerRow,
	CODE_LINE_HEIGHT_PX,
	CODE_PADDING_PX,
	layoutRows,
	normalizeFocusLines,
	scrollTargetPx,
} from "./code-scroll.ts";
import { SAFE_ZONE_WIDTH, SCENE_CONTENT_HEIGHT } from "../props.ts";
import { COLOR, FONT } from "../theme.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

const REVEAL_FRAMES_PER_LINE = 3;
const FOCUS_TRANSITION_FRAMES = 8;
const PATH_ROW_HEIGHT_PX = 54; // fontSize 28 row plus its 20px bottom margin
const CODE_FONT_STACK = FONT.mono;

/** {@link FOCUSED_OPACITY} for a focused line, {@link UNFOCUSED_OPACITY} outside the focus range, {@link FOCUSED_OPACITY} when there is no focus at all. */
function focusOpacity(lineNumber: number, focusLines: [number, number] | undefined): number {
	if (!focusLines) return FOCUSED_OPACITY;
	return lineNumber >= focusLines[0] && lineNumber <= focusLines[1] ? FOCUSED_OPACITY : UNFOCUSED_OPACITY;
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
		<AbsoluteFill style={{ backgroundColor: COLOR.foundryInk }}>
			<SafeZoneContent>
				<div
					style={{
						color: COLOR.foxedPage,
						fontSize: 24,
						fontFamily: CODE_FONT_STACK,
						textTransform: "uppercase",
						letterSpacing: "0.1em",
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
							backgroundColor: COLOR.foundryInk2,
							border: `1px solid ${COLOR.ruleStrong}`,
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
								const isFocused = currentFocusLines
									? focusOpacity(lineNumber, currentFocusLines) === FOCUSED_OPACITY
									: false;
								const marker = line.slice(0, 1) || " ";
								const code = line.slice(1);
								const role = lineRole(line);
								const color = lineTextColor(role);
								const background = lineBackground(role);
								return (
									// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
									<div
										key={i}
										style={{
											display: "flex",
											color,
											background,
											opacity: reveal * dimOpacity,
											borderLeft: isFocused ? `4px solid ${COLOR.solderCopper}` : "4px solid transparent",
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
