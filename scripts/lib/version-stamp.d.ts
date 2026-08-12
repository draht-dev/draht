/**
 * Hand-written type declarations for ./version-stamp.mjs.
 *
 * A sibling version-stamp.d.mts (identical content) also exists: under
 * Node16/NodeNext module resolution, TypeScript resolves a relative
 * "./version-stamp.mjs" specifier to a ".d.mts" declaration file, not a
 * plain ".d.ts" one — this file alone does not satisfy that import. Keep
 * both in sync if the exported signatures change.
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
