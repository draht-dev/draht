#!/usr/bin/env node
/**
 * Allowlist of plugin skill directories that are hand-maintained as
 * byte-identical pairs in BOTH packages/draht-claude/skills/ and
 * packages/draht-codex/skills/ instead of being generated from the
 * canonical repo-root skills/ tree.
 *
 * A skill belongs here only when it cannot join the canonical tree
 * byte-preserved: cinematic-continuation's committed frontmatter carries
 * version/author/metadata keys, which the Agent Skills spec gate on
 * canonical skills (closed key set, exactly name + description) rejects.
 * Canonicalizing it would force a content change to a shipped plugin
 * payload; keeping it hand-mirrored preserves the bytes and moves the
 * drift gate to scripts/check-plugin-mirrors.mjs (byte-exact pair
 * identity — stricter than the retired dialect-tolerant skills check,
 * because a hand-mirrored skill has no host-specific spans at all).
 *
 * Consumed by:
 *   - scripts/check-plugin-mirrors.mjs  (pair identity across packages)
 *   - scripts/generate-skills-artifacts.mjs --check  (these dirs are
 *     exempt from unexpected-file detection under packages/<pkg>/skills/)
 *   - packages/install/test/skills/hand-mirrored.test.ts
 */

export const HAND_MIRRORED_SKILL_DIRS = ["cinematic-continuation"];
