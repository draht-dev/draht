import { useCallback, useState } from "react";
import type { PlaybackPreference } from "../lib/mode.js";

const MODE_KEY = "reels:mode";
const MUTE_KEY = "reels:muted";

function readStoredMode(): PlaybackPreference {
	const stored = localStorage.getItem(MODE_KEY);
	return stored === "audio" ? "audio" : "visual";
}

function readStoredMuted(): boolean {
	return localStorage.getItem(MUTE_KEY) !== "false";
}

/** Visual/audio mode and mute state, persisted to localStorage across reels and sessions. */
export function usePlaybackPreference() {
	const [preference, setPreferenceState] = useState<PlaybackPreference>(readStoredMode);
	const [muted, setMutedState] = useState<boolean>(readStoredMuted);

	const setPreference = useCallback((next: PlaybackPreference) => {
		localStorage.setItem(MODE_KEY, next);
		setPreferenceState(next);
	}, []);

	const setMuted = useCallback((next: boolean) => {
		localStorage.setItem(MUTE_KEY, String(next));
		setMutedState(next);
	}, []);

	const toggleMode = useCallback(() => {
		setPreference(preference === "visual" ? "audio" : "visual");
	}, [preference, setPreference]);

	return { preference, setPreference, toggleMode, muted, setMuted };
}
