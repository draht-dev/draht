import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { TitleScene as TitleSceneData } from "../../contract.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

export function TitleScene({ scene }: { scene: TitleSceneData }) {
	const frame = useCurrentFrame();
	const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			<SafeZoneContent style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
				<div style={{ opacity }}>
					<div style={{ color: "#f8fafc", fontSize: 72, fontWeight: 700, lineHeight: 1.2, fontFamily: "sans-serif" }}>
						{scene.title}
					</div>
					{scene.subtitle ? (
						<div style={{ color: "#94a3b8", fontSize: 36, marginTop: 24, fontFamily: "sans-serif" }}>{scene.subtitle}</div>
					) : null}
				</div>
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
