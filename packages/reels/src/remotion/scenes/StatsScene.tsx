import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { StatsScene as StatsSceneData } from "../../contract.ts";
import { COLOR, FONT } from "../theme.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

/** Patina for additions, Rust for deletions (see theme.ts); modified/renamed stay neutral so Solder Copper stays reserved for signal, not a status legend. */
const STATUS_COLOR: Record<StatsSceneData["files"][number]["status"], string> = {
	added: COLOR.patina,
	modified: COLOR.workshopPaper,
	deleted: COLOR.rust,
	renamed: COLOR.oxidizedCopper,
};

const MAX_ROWS = 8;

export function StatsScene({ scene }: { scene: StatsSceneData }) {
	const frame = useCurrentFrame();
	const rows = scene.files.slice(0, MAX_ROWS);
	const maxChurn = Math.max(1, ...rows.map((r) => r.additions + r.deletions));

	return (
		<AbsoluteFill style={{ backgroundColor: COLOR.foundryInk }}>
			<SafeZoneContent style={{ justifyContent: "center" }}>
				<div
					style={{
						color: COLOR.workshopPaper,
						fontSize: 40,
						fontWeight: 300,
						fontStyle: "italic",
						letterSpacing: "-0.01em",
						marginBottom: 48,
						fontFamily: FONT.serif,
					}}
				>
					{scene.files.length} file{scene.files.length === 1 ? "" : "s"} changed
				</div>
				{rows.map((file, i) => {
					const reveal = interpolate(frame, [i * 4, i * 4 + 10], [0, 1], { extrapolateRight: "clamp" });
					const churn = file.additions + file.deletions;
					const widthPct = (churn / maxChurn) * 100;
					return (
						<div key={file.path} style={{ opacity: reveal, marginBottom: 28 }}>
							<div
								style={{
									color: COLOR.weatheredPaper,
									fontSize: 26,
									fontFamily: FONT.mono,
									marginBottom: 6,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{file.path}
							</div>
							<div style={{ height: 10, background: COLOR.foundryInk2, border: `1px solid ${COLOR.rule}` }}>
								<div
									style={{
										height: "100%",
										width: `${widthPct}%`,
										background: STATUS_COLOR[file.status],
									}}
								/>
							</div>
						</div>
					);
				})}
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
