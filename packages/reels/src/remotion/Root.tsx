import { Composition } from "remotion";
import { ensureCodeFontLoaded } from "./fonts.ts";
import {
	DEFAULT_REEL_PROPS,
	msToFrames,
	REEL_COMPOSITION_ID,
	REEL_FPS,
	REEL_HEIGHT,
	REEL_WIDTH,
	type ReelFrameProps,
	transcriptDurationMs,
} from "./props.ts";
import { Reel } from "./Reel.tsx";

// Starts loading immediately so delayRender blocks the first frame until the
// self-hosted font is ready, instead of each scene racing its own load. Safe
// here because Root.tsx is only evaluated inside the browser bundle, never
// imported by the Node-side CLI/render code (which imports REEL_COMPOSITION_ID
// from props.ts instead).
void ensureCodeFontLoaded();

export function RemotionRoot() {
	return (
		<Composition
			id={REEL_COMPOSITION_ID}
			component={Reel}
			width={REEL_WIDTH}
			height={REEL_HEIGHT}
			fps={REEL_FPS}
			durationInFrames={Math.max(1, msToFrames(transcriptDurationMs(DEFAULT_REEL_PROPS.transcript), REEL_FPS))}
			defaultProps={DEFAULT_REEL_PROPS}
			calculateMetadata={({ props }: { props: ReelFrameProps }) => ({
				durationInFrames: Math.max(1, msToFrames(transcriptDurationMs(props.transcript), REEL_FPS)),
			})}
		/>
	);
}
