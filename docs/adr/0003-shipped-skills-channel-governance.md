# Two skill channels: root skills/ is the portable public catalog; packages/coding-agent/skills/ ships runtime defaults

The shipped channel exists since "feat(coding-agent): add shipped builtin skills with hexagon-animation": `skills` sits in the package's `files` array, is copied into dist by the asset-copy scripts, and is loaded by `src/core/skills.ts` at lowest precedence — shipped (source tag `builtin`) skills load last, so user, project, and CLI skills win name collisions. `--no-skills` disables the channel. Occupants at time of writing: `hexagon-animation` (asset-bearing product default) and `atomic-reasoning` (shipped by "feat(coding-agent): ship atomic-reasoning as a builtin skill" so the pruned command prompts' skill pointer resolves out of the box).

## Decision: what belongs where

- **Root `skills/`** — provider-neutral portable discipline and command wrappers. Closed-key frontmatter (`name` + `description` only), generated into both plugin packages. The content source of truth.
- **`packages/coding-agent/skills/`** — only two kinds of content: skills the draht runtime must resolve by name because a shipped prompt points at them, and product defaults carrying executable assets that assume the draht runtime. NOT generated, NOT mirrored, NOT part of the plugin payloads.

A discipline may exist in both channels under one name. Root is the content source of truth; the shipped copy is the fallback so the name resolves with nothing installed. Both resolution orders already prefer the canonical copy: the runtime loads shipped skills last, and the skills CLI's dedup lets the root copy win (see ADR 0002).

## Empirically-tested constraints

- `packages/coding-agent/skills/<name>` sits at directory depth 4 — below the skills CLI's depth-5 fallback cap (skills@1.5.22) — so anything placed there appears in `--full-depth` public listings unless name-shadowed by an identically-named root skill. Nothing non-public may live in the shipped channel; shadowing is the mitigation for dual-channel names.
- The shipped `atomic-reasoning/SKILL.md` is byte-identical to `skills/atomic-reasoning/SKILL.md` (verified with `cmp` at time of writing). Dual-channel copies are byte-copies, not adaptations.

## Invariants this creates

- A shipped prompt may only point at a skill name that resolves with nothing installed — ship the skill in the builtin channel when it does not.
- New shipped skills are either runtime-referenced disciplines or asset-bearing product defaults; portable discipline alone goes to root `skills/`.

## Known gap

No check pins a dual-channel skill's shipped copy to its canonical root source — the pair drifts silently. Adding that gate is the first revisit trigger for this record.

## Update (2026-08-21)

`unslop` is admitted as a runtime-referenced dual-channel discipline: the shipped pause-work, verify-work, grill, and brainstorm prompts and the git-committer agent point at it by name, and the pointer must resolve with nothing installed. Dual-channel occupants as of this update: `atomic-reasoning`, `unslop`.

The Known gap above is closed by "feat(scripts): gate dual-channel skill byte-copies in check:draht": scripts/check-draht-customizations.mjs section 10b byte-compares each dual-channel skill's shipped copy against its root source over the `DUAL_CHANNEL_SKILLS` allowlist; the allowlist must be extended in the same change as any new dual-channel occupant. `hexagon-animation` stays outside the gate — it is an asset-bearing product default with no root twin.

## Update (2026-08-21): epistemics admitted

`epistemics` is admitted as a runtime-referenced dual-channel discipline: the shipped `prompts/commands/why.md` points at it by name for its synthesis step, and the pointer must resolve with nothing installed — the same admission test `atomic-reasoning` and `unslop` passed. The section-10b `DUAL_CHANNEL_SKILLS` allowlist is extended in the same change that creates the shipped copy. Dual-channel occupants as of this update: `atomic-reasoning`, `epistemics`, `unslop`.

## Update (2026-08-21): typescript-discipline admitted

`typescript-discipline` is admitted as a runtime-referenced dual-channel discipline: the shipped `agents/reviewer.md` points at it by name in its Type Safety criteria, and the pointer must resolve with nothing installed — the same admission test the prior occupants passed. It is the first dual-channel occupant with a file beyond SKILL.md: the shipped copy carries the skill's `references/patterns.md` alongside the byte-copied SKILL.md so the body's `./references/patterns.md` pointer resolves in the shipped channel too, and section 10b is widened in the same change from pinning the SKILL.md pair to pinning the whole skill dir (equal file sets, every file byte-equal), so a references file cannot drift while its SKILL.md stays pinned. Dual-channel occupants as of this update: `atomic-reasoning`, `epistemics`, `typescript-discipline`, `unslop`.

## Update (2026-08-21): blast-radius admitted

`blast-radius` is admitted as a runtime-referenced dual-channel discipline: the shipped `prompts/commands/review.md` points at it by name in its refutation step (a Critical finding whose refutation hinges on library or runtime behavior gets a rung-4 script), and the pointer must resolve with nothing installed — the same admission test the prior occupants passed. The section-10b `DUAL_CHANNEL_SKILLS` allowlist is extended in the same change that creates the shipped copy. Dual-channel occupants as of this update: `atomic-reasoning`, `blast-radius`, `epistemics`, `typescript-discipline`, `unslop`.
