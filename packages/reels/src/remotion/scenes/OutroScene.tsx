import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { OutroScene as OutroSceneData } from "../../contract.ts";
import { COLOR, FONT } from "../theme.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

export function OutroScene({ scene }: { scene: OutroSceneData }) {
	const frame = useCurrentFrame();
	const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

	return (
		<AbsoluteFill style={{ backgroundColor: COLOR.foundryInk }}>
			<SafeZoneContent style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
				<div
					style={{
						opacity,
						color: COLOR.workshopPaper,
						fontSize: 44,
						fontWeight: 300,
						fontStyle: "italic",
						lineHeight: 1.2,
						letterSpacing: "-0.01em",
						fontFamily: FONT.serif,
					}}
				>
					{scene.narration}
				</div>
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
