/**
 * Hand-written type declarations for ./version-stamp.mjs.
 *
 * Identical to the sibling version-stamp.d.ts. Both files must exist:
 * Node16/NodeNext module resolution maps a relative "./version-stamp.mjs"
 * import specifier to this ".d.mts" file, never to the plain ".d.ts" one.
 * The ".d.ts" file is kept alongside it because it is the file named in the
 * task spec and is what a non-extension-specific consumer would look for.
 * Keep both in sync if the exported signatures change.
 */

/**
 * Rewrites the `version` field of both plugin manifests
 * (packages/draht-claude/.claude-plugin/plugin.json and
 * packages/draht-codex/.codex-plugin/plugin.json) found under `rootDir`,
 * preserving each file's existing JSON formatting. A manifest already at
 * `version` is left untouched.
 */
export declare function stampPluginManifests(version: string, rootDir: string): void;

/**
 * Pure function: compute the next always-suffixed CalVer version
 * (`YYYY.M.D-N`) for `date`, given the existing version strings (no leading
 * "v") observed so far. See version-stamp.mjs for full semantics, including
 * the legacy bare-version transition rule.
 */
export declare function computeNextVersion(existingVersions: string[], date: Date): string;
