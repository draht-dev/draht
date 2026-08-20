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
