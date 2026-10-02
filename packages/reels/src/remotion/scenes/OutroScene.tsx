import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { OutroScene as OutroSceneData } from "../../contract.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

export function OutroScene({ scene }: { scene: OutroSceneData }) {
	const frame = useCurrentFrame();
	const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			<SafeZoneContent style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
				<div style={{ opacity, color: "#f8fafc", fontSize: 44, fontFamily: "sans-serif" }}>{scene.narration}</div>
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
