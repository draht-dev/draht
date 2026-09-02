# Place logic in the lowest tier that can hold it: TS enforcement, SKILL.md discipline, thin command prompts

Draht ships behavior through three vehicles:

1. **Enforcement tier** — TypeScript builtins in `packages/coding-agent/src/core/` (process isolation, worktree merge-back, exit semantics) and deterministic gates wired into `npm run check` (the `check:*` script family, `draht-tools validate-plans`).
2. **Discipline tier** — `SKILL.md` files under root `skills/`, generated into both plugin packages, portable to any Agent-Skills host.
3. **Command tier** — command prompts (`skills/<cmd>/command.md` and `packages/coding-agent/prompts/commands/*.md`) that name the situation, dispatch agents, and point at skills.

Without a placement rule, logic accretes in whichever surface an author touched last. Observed failure: the Atomic Reasoning preamble was duplicated into 17 of 18 command prompts and sedimented until it contradicted the commands carrying it — in `/progress` it instructed analysis the command's own "display the result as-is" step forbids. Removed by "refactor(coding-agent): prune the Atomic Reasoning stamp from command prompts" and its skills-source twin.

## Decision

Apply the **wrong-vs-fuzzy test**: ask what happens when the mechanism is absent or ignored.

- **Output becomes WRONG** — an unmerged worktree silently dropped, a nonexistent agent dispatched, DONE claimed on red checks — the logic goes in the enforcement tier, where prose cannot be ignored: a TS builtin or a deterministic check in `npm run check`. Anchors: `src/core/builtins/subagent.ts` hard-fails unknown agent names (`Unknown agent "<name>". Available: …`); `scripts/check-draht-customizations.mjs` gates command↔roster drift bidirectionally ("feat(scripts): gate command-agent roster drift bidirectionally in check:draht").
- **Output becomes FUZZY** — weaker decomposition, vaguer questions, sloppier commits — the logic goes in a `SKILL.md`: portable, generated to every host, cheap to revise.
- Command prompts carry only situation-naming, agent dispatch, and pointers to the skills that own the discipline. They never restate a discipline a skill owns.

## Invariants this creates

- New enforcement lands as TypeScript plus a check wired into `npm run check` — never as prose alone.
- New portable discipline lands under root `skills/` and the artifacts are regenerated (`scripts/generate-skills-artifacts.mjs`).
- A command prompt that needs a discipline points at the skill that owns it; duplicated discipline text in a command prompt is a defect.

## Known gap

`packages/coding-agent/prompts/commands/*.md` (native CLI) and `skills/<cmd>/command.md` (canonical catalog) are two hand-maintained command-template copies with no equality gate between them.
