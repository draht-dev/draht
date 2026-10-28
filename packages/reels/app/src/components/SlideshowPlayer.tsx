import { useEffect, useRef, useState } from "react";
import type { ReelMedia } from "../../../src/contract.js";
import { SceneView } from "./SceneView.js";

/** Silent fallback for reels with neither video nor audio: advances scenes by transcript timing. */
export function SlideshowPlayer({
	reel,
	active,
	onEnded,
	onProgress,
}: {
	reel: ReelMedia;
	active: boolean;
	onEnded: () => void;
	onProgress: (fraction: number) => void;
}) {
	const [sceneIndex, setSceneIndex] = useState(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		if (!active) {
			setSceneIndex(0);
			clearTimeout(timerRef.current);
			return;
		}

		const segment = reel.transcript[sceneIndex];
		if (!segment) {
			onEnded();
			return;
		}

		onProgress(segment.endMs / reel.durationMs);
		const remaining = Math.max(segment.endMs - segment.startMs, 400);
		timerRef.current = setTimeout(() => {
			if (sceneIndex + 1 < reel.scenes.length) {
				setSceneIndex(sceneIndex + 1);
			} else {
				onEnded();
			}
		}, remaining);

		return () => clearTimeout(timerRef.current);
	}, [active, sceneIndex, reel, onEnded, onProgress]);

	const scene = reel.scenes[sceneIndex];
	// The title scene's narration is the reel title verbatim, which the overlay
	// already shows; skip both the scene body and the caption for it so the
	// title isn't rendered twice on screen at once.
	const isTitleScene = scene?.kind === "title";

	return (
		<div className="slideshow-player">
			{scene && !isTitleScene && <SceneView scene={scene} />}
			{!isTitleScene && <p className="slideshow-caption">{reel.transcript[sceneIndex]?.text}</p>}
		</div>
	);
}
