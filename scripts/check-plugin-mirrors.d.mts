/**
 * Hand-written type declarations for ./check-plugin-mirrors.mjs.
 *
 * Under Node16/NodeNext module resolution, a relative "./check-plugin-mirrors.mjs"
 * import specifier resolves its declarations from this ".d.mts" file. Keep in
 * sync with the exported signatures in the .mjs file.
 */

/**
 * Enforce byte-exact pair identity for every allowlisted hand-mirrored skill
 * dir under <root>/packages/{draht-claude,draht-codex}/skills/. Returns a
 * list of precise problems (empty when in sync). Pure: reads only, never
 * exits, so tests can drive it against fixture roots.
 */
export declare function checkHandMirroredSkills(root: string): string[];
