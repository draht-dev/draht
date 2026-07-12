// @draht/rlm-agent — coding-agent extension surface for @draht/rlm.
//
// See ./extension.ts for the `/rlm` slash command + `rlm_query` tool
// registration and the shared `runRlmQuery` load-and-run path. Re-exported
// here (rather than only under the package's `./extension` subpath) so
// tests and other consumers of `@draht/rlm-agent` can import the pieces
// directly from the package root.

export { default as rlmAgentExtension, formatRlmResult, runRlmQuery } from "./extension.js";
