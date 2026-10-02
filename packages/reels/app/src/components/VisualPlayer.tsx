import { useEffect, useRef, useState } from "react";
import type { ReelEntry } from "../../../src/contract.js";
import { resolveAutoplayGesture } from "../lib/autoplayFallback.js";
import { cacheMediaInBackground } from "../lib/mediaCache.js";

export function VisualPlayer({
	reel,
	active,
	muted,
	preload,
	onEnded,
	onProgress,
}: {
	reel: ReelEntry;
	active: boolean;
	muted: boolean;
	preload: "auto" | "metadata" | "none";
	onEnded: () => void;
	onProgress: (fraction: number) => void;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [gesture, setGesture] = useState<"play" | "unmute" | null>(null);
	const cacheAbortRef = useRef<AbortController | null>(null);

	// The background "cache this reel" fetch may only run while the card is
	// actually active, and must be cancelled the moment it stops being
	// active — otherwise it is an uncancellable download racing a user who
	// already scrolled away.
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
		const video = videoRef.current;
		if (!video) return;

		if (!active) {
			video.pause();
			video.currentTime = 0;
			setGesture(null);
			return;
		}

		video.muted = muted;
		video.play().then(
			() => setGesture(null),
			() => {
				if (muted) {
					// Even muted autoplay was blocked; only a real tap can start it.
					setGesture(resolveAutoplayGesture(muted, false));
					return;
				}
				video.muted = true;
				video.play().then(
					() => setGesture(resolveAutoplayGesture(muted, true)),
					() => setGesture(resolveAutoplayGesture(muted, false)),
				);
			},
		);
	}, [active, muted]);

	const handleGestureTap = () => {
		const video = videoRef.current;
		if (!video) return;
		if (gesture === "unmute") {
			video.muted = false;
			setGesture(null);
		} else if (gesture === "play") {
			video.play().then(
				() => setGesture(null),
				() => {},
			);
		}
	};

	const handleTimeUpdate = () => {
		const video = videoRef.current;
		if (!video || !video.duration) return;
		onProgress(video.currentTime / video.duration);
	};

	// `canplaythrough` fires once the browser judges it can play to the end
	// at the current download rate without further buffering stalls — a
	// reasonable "this is basically fully loaded" signal that fires while
	// still active, well before `ended` (which only fires after an auto-
	// advancing reel has already started deactivating, too late to let a
	// background fetch finish).
	const handleCanPlayThrough = () => {
		cacheMediaInBackground(reel.video, cacheAbortRef.current?.signal);
	};

	return (
		<div className="visual-player">
			{reel.video && (
				<video
					ref={videoRef}
					className="visual-player-video"
					src={reel.video}
					poster={reel.poster}
					muted={muted}
					playsInline
					onTimeUpdate={handleTimeUpdate}
					onCanPlayThrough={handleCanPlayThrough}
					onEnded={onEnded}
					preload={preload}
				>
					<track kind="captions" />
				</video>
			)}
			{gesture && (
				<button type="button" className="visual-player-gesture" onClick={handleGestureTap}>
					{gesture === "unmute" ? "Tap to unmute" : "Tap to play"}
				</button>
			)}
		</div>
	);
}
