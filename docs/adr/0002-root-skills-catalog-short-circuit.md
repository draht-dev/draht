# Serve the public Agent Skills catalog from repo-root skills/ — the skills CLI's priority walk short-circuits there

Distribution to Agent-Skills hosts rides the vercel-labs `skills` CLI (`npx skills add draht-dev/draht`). Before the root tree existed, discovery fell through to an exhaustive repo walk that produced an accidental catalog: a leaked example skill, Claude-dialect mirrors silently shadowing their Codex twins, and 17 wrapper skills that break when installed standalone.

## Decision

Repo-root `skills/` is the canonical provider-neutral tree and the only public catalog surface. `packages/draht-claude/` and `packages/draht-codex/` are committed GENERATED consumers, produced by `scripts/generate-skills-artifacts.mjs` (dialect via `scripts/skills-dialect-table.mjs`); its byte-exact `--check` mode, including unexpected-file detection, is wired into `npm run check` as `check:skills-artifacts`. The only exception is the hand-mirrored allowlist (`scripts/hand-mirrored-skills.mjs`, currently `cinematic-continuation`), pair-gated byte-exact by `scripts/check-plugin-mirrors.mjs`.

## Empirically-tested constraints, pinned to skills@1.5.22

Evidence from the 2026-08-11 distribution audit (skills@1.5.22, skills-ref@0.1.5, Agent Skills spec as of 2026-08-04 / agentskills#479), against the unpacked `dist/cli.mjs`:

- Discovery walks a fixed priority list — repo-root `SKILL.md` → root's direct children → `skills/` → 27 hardcoded agent dirs → Claude plugin-manifest paths — each to depth 3 (`dist/cli.mjs:1103-1186`, `999-1027`).
- The exhaustive fallback walk (depth-5 cap; `findSkillDirs`, `dist/cli.mjs:1087-1097`, `1174-1184`) runs only when the priority pass finds zero skills, or under `--full-depth`.
- Dedup is by frontmatter name, first-found-wins, silent (`dist/cli.mjs:1155`, `1178`). Traversal is raw `readdir` with no sort — winner order among same-depth siblings is not contractual.
- The skip list is only `node_modules`, `.git`, `dist`, `build`, `__pycache__` (`dist/cli.mjs:992-998`). There is no ignore-file support.
- Synthetic-layout experiment (reproduced twice): with root `skills/alpha` plus package mirrors, default discovery lists root alpha ONLY (the short-circuit); `--full-depth` lists more but the root copy wins dedup; a depth-6 skill is invisible in both modes.

## Invariants this creates

- Everything under root `skills/` is public. Nothing lands there that is not meant for every host.
- Test-fixture skills stay at directory depth >= 6 — their exclusion is a depth-cap artifact, not an ignore rule.
- Content under `packages/*/skills/` leaks into `--full-depth` listings unless name-shadowed by a root skill of the same name.

## Revisit triggers

- Any new skills CLI release that changes the priority list, the dedup rule, or the depth caps.
- The CLI adding sorted traversal or ignore-file support.
- The Agent Skills spec defining catalog semantics.
- Any release where `npx -y skills@latest add draht-dev/draht --list` shows an entry not present under root `skills/`.

## Update, 2026-08-12

The implementation diverged from the audited plan in three recorded ways: the generator lives at `scripts/generate-skills-artifacts.mjs`, not in a dedicated package; `saga-spawner` joined the canonical tree as an additional discipline; and the hand-mirrored allowlist above was introduced for frontmatter the canonical closed-key gate rejects. The mechanism and constraints stand unchanged.
