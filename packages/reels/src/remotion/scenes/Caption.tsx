import { CAPTION_HEIGHT, CAPTION_Y_MIN, SAFE_ZONE_WIDTH, SAFE_ZONE_X_MIN } from "../props.ts";

const MAX_LINES = 2;

export function Caption({ text }: { text: string }) {
	if (!text) return null;
	return (
		<div
			style={{
				position: "absolute",
				left: SAFE_ZONE_X_MIN,
				top: CAPTION_Y_MIN,
				width: SAFE_ZONE_WIDTH,
				height: CAPTION_HEIGHT,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<div
				style={{
					maxWidth: "100%",
					padding: "14px 24px",
					borderRadius: 16,
					backgroundColor: "rgba(0,0,0,0.45)",
					textAlign: "center",
					color: "#f8fafc",
					fontSize: 44,
					fontFamily: "sans-serif",
					fontWeight: 600,
					lineHeight: 1.25,
					overflow: "hidden",
					display: "-webkit-box",
					WebkitBoxOrient: "vertical",
					WebkitLineClamp: MAX_LINES,
				}}
			>
				{text}
			</div>
		</div>
	);
}
