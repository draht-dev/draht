/**
 * Self-hosted fonts for reel rendering. Loaded from `public/fonts/` via
 * `staticFile()` so rendering never depends on network access (no Google
 * Fonts, no remote CSS). Geist Mono is vendored the same way
 * `packages/landing` already does; see `packages/landing/src/styles/fonts.css`
 * for the matching weight/unicode-range split.
 */

import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const CODE_FONT_FAMILY = "Geist Mono";

let loaded: Promise<void> | undefined;

/** Idempotent: safe to call from every scene that needs the monospace font. */
export function ensureCodeFontLoaded(): Promise<void> {
	if (!loaded) {
		loaded = Promise.all([
			loadFont({
				family: CODE_FONT_FAMILY,
				url: staticFile("fonts/geist-mono-latin.woff2"),
				weight: "300 600",
				style: "normal",
				unicodeRange:
					"U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
			}),
			loadFont({
				family: CODE_FONT_FAMILY,
				url: staticFile("fonts/geist-mono-latin-ext.woff2"),
				weight: "300 600",
				style: "normal",
				unicodeRange:
					"U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
			}),
		]).then(() => undefined);
	}
	return loaded;
}
