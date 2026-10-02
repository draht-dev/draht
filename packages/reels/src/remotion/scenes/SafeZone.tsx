import type { CSSProperties, ReactNode } from "react";
import { SAFE_ZONE_WIDTH, SAFE_ZONE_X_MIN, SAFE_ZONE_Y_MIN, SCENE_CONTENT_HEIGHT } from "../props.ts";

/**
 * Positions scene content inside the safe zone, clear of the feed PWA's
 * title/meta/stats overlay (bottom) and button rail (right). The caption
 * (see `Caption.tsx`) occupies the strip directly below this box.
 */
export function SafeZoneContent({ children, style }: { children: ReactNode; style?: CSSProperties }) {
	return (
		<div
			style={{
				position: "absolute",
				left: SAFE_ZONE_X_MIN,
				top: SAFE_ZONE_Y_MIN,
				width: SAFE_ZONE_WIDTH,
				height: SCENE_CONTENT_HEIGHT,
				display: "flex",
				flexDirection: "column",
				...style,
			}}
		>
			{children}
		</div>
	);
}
