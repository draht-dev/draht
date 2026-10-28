import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { TitleScene as TitleSceneData } from "../../contract.ts";
import { COLOR, FONT } from "../theme.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

/** DESIGN.md: "The `.` period is the copper accent" on the `draht.` wordmark — the only place a title's trailing full stop gets picked out in Solder Copper rather than reading as plain punctuation. */
function TitleText({ title }: { title: string }) {
	if (!title.endsWith(".") || title.length < 2) return <>{title}</>;
	return (
		<>
			{title.slice(0, -1)}
			<span style={{ color: COLOR.solderCopper }}>.</span>
		</>
	);
}

export function TitleScene({ scene, beatStartFrames }: { scene: TitleSceneData; beatStartFrames?: number[] }) {
	const frame = useCurrentFrame();
	const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

	// Beats split the title scene's narration into steps; when there are at least two, the
	// subtitle (a second line of context) only appears once the second step starts.
	const hasMultipleBeats = (beatStartFrames?.length ?? 0) >= 2;
	const subtitleOpacity = hasMultipleBeats
		? interpolate(frame, [beatStartFrames?.[1] ?? 0, (beatStartFrames?.[1] ?? 0) + 15], [0, 1], {
				extrapolateLeft: "clamp",
				extrapolateRight: "clamp",
			})
		: 1;

	return (
		<AbsoluteFill style={{ backgroundColor: COLOR.foundryInk }}>
			<SafeZoneContent style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
				<div style={{ opacity }}>
					<div
						style={{
							color: COLOR.workshopPaper,
							fontSize: 72,
							fontWeight: 300,
							fontStyle: "italic",
							lineHeight: 0.98,
							letterSpacing: "-0.02em",
							fontFamily: FONT.serif,
						}}
					>
						<TitleText title={scene.title} />
					</div>
					{scene.subtitle ? (
						<div
							style={{
								color: COLOR.weatheredPaper,
								fontSize: 30,
								fontWeight: 400,
								lineHeight: 1.45,
								marginTop: 24,
								fontFamily: FONT.sans,
								opacity: subtitleOpacity,
							}}
						>
							{scene.subtitle}
						</div>
					) : null}
				</div>
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
