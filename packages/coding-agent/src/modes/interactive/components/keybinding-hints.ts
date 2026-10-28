/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@draht/tui";
import { theme } from "../theme/theme.js";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

/** Arrow glyphs for the four directional keys, matching the "↑↓ navigate" hints the app's other
 * selectors (`SelectList` callers such as `first-time-setup.ts`, `extension-selector.ts`) render. */
const ARROW_GLYPHS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

/** Formats several keybindings' keys as one group, e.g. "↑↓" for a combined select-up/select-down
 * hint whose keys are still each bound to a single directional key, or "up/down"-style `/`-joined
 * key names otherwise. Each keybinding still resolves through the configured bindings, so a
 * rebinding away from the defaults is reflected here exactly as it is in `keyText`, never hidden
 * behind a hardcoded glyph. */
export function combinedKeyText(keybindings: readonly Keybinding[]): string {
	const perBinding = keybindings.map((id) => getKeybindings().getKeys(id));
	if (perBinding.every((keys) => keys.length === 1 && keys[0] in ARROW_GLYPHS)) {
		return perBinding.map((keys) => ARROW_GLYPHS[keys[0]]).join("");
	}
	return keybindings.map((id) => keyText(id)).join("/");
}

export function combinedKeyHint(keybindings: readonly Keybinding[], description: string): string {
	return theme.fg("dim", combinedKeyText(keybindings)) + theme.fg("muted", ` ${description}`);
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
