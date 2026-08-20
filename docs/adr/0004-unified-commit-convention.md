# One TDD commit convention: plain git with red:/green:/refactor: prefixes; commit-docs only for .planning/ commits

Three contradictory commit conventions coexisted across the prompt surfaces, and one was a functional bug:

- `/fix` Phase 4 routed TDD commits through `draht-tools commit-docs "red: …"`. `commit-docs` stages only `.planning/` and prefixes the message with `docs:` — so /fix's red/green commits contained no source files at all, and their `docs: red: …` messages could never match the gsd-post-task hook's `/^red:/i` cycle check.
- `execute-phase` used plain `git add <files> && git commit -m "red: …"`, matching the skills and the hooks.
- The legacy `prompts/agents/{build,plan,verify}.md` carried a dead third convention (`draht commit-task N P T`) and were referenced nowhere in src, commands, hooks, tests, or docs.
- The plugin implementer agents instructed `test:`/`feat:` prefixes for RED/GREEN, contradicting their own shipped gsd-post-task hook.

## Decision

Draht's single TDD commit convention is plain git: `git add <files> && git commit -m "red: …"` / `"green: …"` / `"refactor: …"` — the form execute-phase, `skills/fix/command.md`, `skills/tdd-workflow`, and the gsd hooks already enforced. `draht-tools commit-docs` is reserved for genuine `.planning/` documentation commits (e.g. the phase-completion docs commit in execute-phase). The legacy agent prompts were deleted, retiring their `/build`, `/plan`, `/verify` slash templates at runtime; build.md's Competence Mimics table was relocated into the builtin implementer agent.

Landed as three commits on this branch:

- "fix(coding-agent): commit /fix TDD cycle with plain git, not commit-docs"
- "fix(plugins): align implementer TDD commit prefixes with red:/green:"
- "refactor(coding-agent): retire legacy build/plan/verify agent prompts"

## Constraints and enforcement surface

- `packages/coding-agent/prompts/commands/fix.md` and the plugin implementer agents now carry the unified form; the shipped gsd-post-task hook detects cycle violations via the `red:`/`green:` message prefixes, so a divergent prompt is caught at runtime, not just in review.
- `scripts/check-draht-customizations.mjs` guards that the retired `prompts/agents/` templates stay retired — an upstream rebase cannot silently resurrect them.
- The TDD prefixes sit inside the repo's standing git rules (AGENTS.md): conventional-commit style, atomic per logical change.

## Invariants this creates

- Any new prompt that instructs a commit uses the unified plain-git form.
- TDD phase commits are never routed through docs-only tooling.
