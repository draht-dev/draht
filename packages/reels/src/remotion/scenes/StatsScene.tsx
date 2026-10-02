import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { StatsScene as StatsSceneData } from "../../contract.ts";
import { SafeZoneContent } from "./SafeZone.tsx";
import { CODE_FONT_FAMILY } from "../fonts.ts";

const STATUS_COLOR: Record<StatsSceneData["files"][number]["status"], string> = {
	added: "#16a34a",
	modified: "#2563eb",
	deleted: "#dc2626",
	renamed: "#9333ea",
};

const MAX_ROWS = 8;

export function StatsScene({ scene }: { scene: StatsSceneData }) {
	const frame = useCurrentFrame();
	const rows = scene.files.slice(0, MAX_ROWS);
	const maxChurn = Math.max(1, ...rows.map((r) => r.additions + r.deletions));

	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			<SafeZoneContent style={{ justifyContent: "center" }}>
				<div style={{ color: "#f8fafc", fontSize: 44, fontWeight: 700, marginBottom: 48, fontFamily: "sans-serif" }}>
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
									color: "#e2e8f0",
									fontSize: 28,
									fontFamily: `"${CODE_FONT_FAMILY}", monospace`,
									marginBottom: 6,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{file.path}
							</div>
							<div style={{ height: 14, background: "#1e293b", borderRadius: 7, overflow: "hidden" }}>
								<div
									style={{
										height: "100%",
										width: `${widthPct}%`,
										background: STATUS_COLOR[file.status],
										borderRadius: 7,
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
