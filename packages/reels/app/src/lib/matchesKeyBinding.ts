import type { KeyChord } from "./keybindings.js";

export type KeyEventLike = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">;

function matchesChord(event: KeyEventLike, chord: KeyChord): boolean {
	return (
		event.key === chord.key &&
		Boolean(event.shiftKey) === Boolean(chord.shiftKey) &&
		Boolean(event.ctrlKey) === Boolean(chord.ctrlKey) &&
		Boolean(event.altKey) === Boolean(chord.altKey) &&
		Boolean(event.metaKey) === Boolean(chord.metaKey)
	);
}

export function matchesKeyBinding(event: KeyEventLike, chords: KeyChord[]): boolean {
	return chords.some((chord) => matchesChord(event, chord));
}
