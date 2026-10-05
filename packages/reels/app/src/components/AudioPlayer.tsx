import { useEffect, useRef, useState } from "react";
import type { Beat, ReelMedia } from "../../../src/contract.js";
import { resolveAutoplayGesture } from "../lib/autoplayFallback.js";
import { type CaptionChunk, currentCaptionChunk } from "../lib/captions.js";
import { cacheMediaInBackground } from "../lib/mediaCache.js";
import { activeBeatIndex, activeSegment } from "../lib/transcript.js";
import { SceneView } from "./SceneView.js";

export function AudioPlayer({
	reel,
	active,
	muted,
	preload,
	onEnded,
	onProgress,
	onActiveBeatChange,
}: {
	reel: ReelMedia;
	active: boolean;
	muted: boolean;
	preload: "auto" | "metadata" | "none";
	onEnded: () => void;
	onProgress: (fraction: number) => void;
	/** Lifted for the sources sheet, which highlights the beat's cited sources. */
	onActiveBeatChange?: (beat: Beat | undefined) => void;
}) {
	const audioRef = useRef<HTMLAudioElement>(null);
	const [sceneIndex, setSceneIndex] = useState(0);
	const [beatIndex, setBeatIndex] = useState(-1);
	const [captionChunk, setCaptionChunk] = useState<CaptionChunk | undefined>(undefined);
	const [gesture, setGesture] = useState<"play" | "unmute" | null>(null);
	const cacheAbortRef = useRef<AbortController | null>(null);

	// See VisualPlayer: the background "cache this reel" fetch may only run
	// while active, and must be cancelled the moment it stops being active.
	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		cacheAbortRef.current = controller;
		return () => {
			controller.abort();
			cacheAbortRef.current = null;
		};
	}, [active]);

	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;
		if (!active) {
			audio.pause();
			audio.currentTime = 0;
			setGesture(null);
			return;
		}

		audio.muted = muted;
		audio.play().then(
			() => setGesture(null),
			() => {
				if (muted) {
					setGesture(resolveAutoplayGesture(muted, false));
					return;
				}
				audio.muted = true;
				audio.play().then(
					() => setGesture(resolveAutoplayGesture(muted, true)),
					() => setGesture(resolveAutoplayGesture(muted, false)),
				);
			},
		);
	}, [active, muted]);

	const handleGestureTap = () => {
		const audio = audioRef.current;
		if (!audio) return;
		if (gesture === "unmute") {
			audio.muted = false;
			setGesture(null);
		} else if (gesture === "play") {
			audio.play().then(
				() => setGesture(null),
				() => {},
			);
		}
	};

	const handleCanPlayThrough = () => {
		cacheMediaInBackground(reel.audio, cacheAbortRef.current?.signal);
	};

	const handleTimeUpdate = () => {
		const audio = audioRef.current;
		if (!audio) return;
		const currentMs = audio.currentTime * 1000;
		const segment = activeSegment(reel.transcript, currentMs);
		if (segment) {
			setSceneIndex(segment.sceneIndex);
			const beat = activeBeatIndex(segment, currentMs);
			setBeatIndex(beat);
			setCaptionChunk(currentCaptionChunk(segment, currentMs));
			onActiveBeatChange?.(beat >= 0 ? reel.scenes[segment.sceneIndex]?.beats?.[beat] : undefined);
		}
		if (audio.duration > 0) onProgress(audio.currentTime / audio.duration);
	};

	const activeScene = reel.scenes[sceneIndex];
	// The title scene's narration is the reel title verbatim, which the overlay
	// already shows; skip both the scene body and the caption for it so the
	// title isn't rendered twice on screen at once.
	const isTitleScene = activeScene?.kind === "title";

	return (
		<div className="audio-player">
			{reel.audio && (
				// biome-ignore lint/a11y/useMediaCaption: narration captions are rendered separately from the transcript, synced below.
				<audio
					ref={audioRef}
					src={reel.audio}
					muted={muted}
					onTimeUpdate={handleTimeUpdate}
					onCanPlayThrough={handleCanPlayThrough}
					onEnded={onEnded}
					preload={preload}
				/>
			)}
			<div className="audio-scene">{activeScene && !isTitleScene && <SceneView scene={activeScene} beatIndex={beatIndex} />}</div>
			{!isTitleScene &&
				(captionChunk ? (
					<p className="audio-caption">
						{captionChunk.words.map((word, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a caption chunk's words have no stable identity beyond position
							<span
								key={index}
								className={index === captionChunk.activeIndexInChunk ? "caption-word caption-word-active" : "caption-word"}
							>
								{word.text}
								{index < captionChunk.words.length - 1 ? " " : ""}
							</span>
						))}
					</p>
				) : (
					<p className="audio-caption">{reel.transcript[sceneIndex]?.text}</p>
				))}
			{gesture && (
				<button type="button" className="audio-player-gesture" onClick={handleGestureTap}>
					{gesture === "unmute" ? "Tap to unmute" : "Tap to play"}
				</button>
			)}
		</div>
	);
}
