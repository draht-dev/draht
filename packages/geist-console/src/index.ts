// The React app now ships here — see `App.tsx` (mounted by `main.tsx`), M1, Phase 33.

/**
 * Absolute path to geist-glass's design tokens stylesheet (spec §13). Kept as a
 * public export so `@draht/geist` can locate the tokens when serving the built
 * console; the dev/build path links it directly from `index.html`.
 */
export const TOKENS_CSS_PATH = new URL("./tokens.css", import.meta.url).pathname;
