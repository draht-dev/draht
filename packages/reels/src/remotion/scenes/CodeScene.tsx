import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { CodeScene as CodeSceneData } from "../../contract.ts";
import { CODE_FONT_FAMILY } from "../fonts.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

function lineColor(line: string): { color: string; background?: string } {
	if (line.startsWith("+")) return { color: "#bbf7d0", background: "rgba(22,163,74,0.18)" };
	if (line.startsWith("-")) return { color: "#fecaca", background: "rgba(220,38,38,0.18)" };
	return { color: "#cbd5e1" };
}

const REVEAL_FRAMES_PER_LINE = 3;
const CODE_FONT_STACK = `"${CODE_FONT_FAMILY}", ui-monospace, Menlo, Consolas, monospace`;

export function CodeScene({ scene }: { scene: CodeSceneData }) {
	const frame = useCurrentFrame();

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
							padding: 32,
							fontFamily: CODE_FONT_STACK,
							fontSize: 34,
							lineHeight: 1.5,
							maxHeight: "100%",
							overflow: "hidden",
						}}
					>
						{scene.lines.map((line, i) => {
							const reveal = interpolate(frame, [i * REVEAL_FRAMES_PER_LINE, i * REVEAL_FRAMES_PER_LINE + 8], [0, 1], {
								extrapolateRight: "clamp",
							});
							const marker = line.slice(0, 1) || " ";
							const code = line.slice(1);
							const { color, background } = lineColor(line);
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
								<div key={i} style={{ display: "flex", color, background, opacity: reveal }}>
									<span style={{ flexShrink: 0, width: "1.5ch", whiteSpace: "pre" }}>{marker}</span>
									<span style={{ flex: 1, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{code}</span>
								</div>
							);
						})}
					</div>
				</div>
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
