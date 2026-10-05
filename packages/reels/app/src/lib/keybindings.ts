/** A single key chord a `KeyboardEvent` must match. */
export interface KeyChord {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
}

export interface AppKeybindings {
	nextReel: KeyChord[];
	previousReel: KeyChord[];
	openDeepDive: KeyChord[];
}

/** Feed navigation keybindings. Up/down mirror TikTok-style vertical feeds; j/k mirror vim, for desktop users. */
export const DEFAULT_APP_KEYBINDINGS: AppKeybindings = {
	nextReel: [{ key: "ArrowDown" }, { key: "j" }],
	previousReel: [{ key: "ArrowUp" }, { key: "k" }],
	openDeepDive: [{ key: "d" }],
};
