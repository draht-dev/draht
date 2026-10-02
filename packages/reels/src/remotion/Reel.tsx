import { AbsoluteFill, Audio, Sequence } from "remotion";
import type { Scene } from "../contract.ts";
import { Caption } from "./scenes/Caption.tsx";
import { CodeScene } from "./scenes/CodeScene.tsx";
import { DiagramScene } from "./scenes/DiagramScene.tsx";
import { OutroScene } from "./scenes/OutroScene.tsx";
import { StatsScene } from "./scenes/StatsScene.tsx";
import { TitleScene } from "./scenes/TitleScene.tsx";
import { type ReelFrameProps, REEL_FPS, msToFrames } from "./props.ts";

function renderScene(scene: Scene) {
	switch (scene.kind) {
		case "title":
			return <TitleScene scene={scene} />;
		case "stats":
			return <StatsScene scene={scene} />;
		case "code":
			return <CodeScene scene={scene} />;
		case "diagram":
			return <DiagramScene scene={scene} />;
		case "outro":
			return <OutroScene scene={scene} />;
	}
}

export function Reel({ scenes, transcript, audioSrc }: ReelFrameProps) {
	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			{audioSrc ? <Audio src={audioSrc} /> : null}
			{scenes.map((scene, index) => {
				const segment = transcript.find((t) => t.sceneIndex === index);
				const startFrame = segment ? msToFrames(segment.startMs, REEL_FPS) : 0;
				const endFrame = segment ? msToFrames(segment.endMs, REEL_FPS) : startFrame + REEL_FPS * 2;
				const durationInFrames = Math.max(1, endFrame - startFrame);
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: scenes are a fixed, ordered script
					<Sequence key={index} from={startFrame} durationInFrames={durationInFrames}>
						<AbsoluteFill>
							{renderScene(scene)}
							<Caption text={scene.narration} />
						</AbsoluteFill>
					</Sequence>
				);
			})}
		</AbsoluteFill>
	);
}
