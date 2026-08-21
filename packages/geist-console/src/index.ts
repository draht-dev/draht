// The React app now ships here — see `App.tsx` (mounted by `main.tsx`), M1, Phase 33.

/**
 * Absolute path to geist-glass's design tokens stylesheet (spec §13). Kept as a
 * public export so `@draht/geist` can locate the tokens when serving the built
 * console; the dev/build path links it directly from `index.html`.
 */
export const TOKENS_CSS_PATH = new URL("./tokens.css", import.meta.url).pathname;

/**
 * Absolute path to the daemon-served bundle (R32-FLEET.10).
 *
 * Decision record: `.planning/specs/2026-08-19-geist-served-surface-decision.md`.
 * Three files, no build step, no framework, no dependency — so the bytes the
 * daemon serves are the bytes in the tree, and the browser acceptance proves the
 * file that ships rather than a `dist/` regenerated for the occasion.
 */
export const CONSOLE_BUNDLE_DIR = new URL("../bundle/", import.meta.url).pathname;

/**
 * What `/ui` is allowed to serve, keyed by the name it is served under.
 *
 * The list lives here, in the package that owns the renderer, rather than in the
 * daemon: the daemon's job is to hand bytes over an authenticated boundary, not
 * to know what a console is made of. It also makes traversal structurally
 * impossible — a request names a key, never a path.
 *
 * `tokens.css` points at `src/tokens.css`, the same file the geist-picker overlay
 * uses. It is deliberately not copied into `bundle/`: two token files is exactly
 * how a design system stops being one.
 */
export const CONSOLE_BUNDLE_ASSETS: Readonly<Record<string, string>> = Object.freeze({
	"index.html": `${CONSOLE_BUNDLE_DIR}index.html`,
	"console.css": `${CONSOLE_BUNDLE_DIR}console.css`,
	"console.js": `${CONSOLE_BUNDLE_DIR}console.js`,
	"tokens.css": TOKENS_CSS_PATH,
});
