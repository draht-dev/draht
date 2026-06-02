# draht-codex

Draht's GSD workflow, multi-agent orchestration prompts, TDD discipline, DDD guidance, and planning framework as a Codex plugin.

Install:

```bash
npx draht-codex install
```

This creates a local Codex marketplace at `~/.draht/codex-marketplace`, installs the `draht` plugin, and bundles Draht command prompt wrappers, reference prompt templates, specialist agent prompts, support skills, hooks, scripts, and `draht-tools`.

## What you get

### Reference prompt templates

The plugin bundles Draht workflow prompt templates under `commands/`. Codex CLI currently does not expose plugin `commands/` files as TUI slash commands, so Claude Code-style syntax such as `/draht:new-project` or `/draht:orchestrate` will not work in Codex.

For Codex, each command prompt is exposed through a thin skill wrapper named after the command. Use `$draht:<command>` or `/skills` and select the wrapper, for example `$draht:new-project`, `$draht:plan-phase`, or `$draht:orchestrate`. The wrapper reads the matching `commands/*.md` file and runs it as the active workflow.

Project lifecycle:

- `commands/new-project.md` - greenfield questioning, domain model, requirements, roadmap
- `commands/init-project.md` - existing codebase mapping, domain extraction, roadmap
- `commands/map-codebase.md` - standalone codebase map
- `commands/next-milestone.md` - plan the next milestone after current phases are verified

Per-phase cycle:

- `commands/discuss-phase.md`
- `commands/plan-phase.md`
- `commands/execute-phase.md`
- `commands/verify-work.md`

Session continuity:

- `commands/pause-work.md`
- `commands/resume-work.md`
- `commands/progress.md`

Ad-hoc:

- `commands/quick.md`
- `commands/fix.md`
- `commands/review.md`
- `commands/atomic-commit.md`
- `commands/orchestrate.md`

Use the wrappers for picker-driven invocation, and keep the `commands/*.md` files as the source prompt templates.

### Specialist agent prompts

The plugin ships reference prompts in `agents/`:

- `architect`
- `implementer`
- `reviewer`
- `debugger`
- `verifier`
- `git-committer`
- `security-auditor`
- `spec-reviewer`

Codex subagent availability depends on the active Codex feature/configuration. When named Draht agent roles are not registered directly, the command templates can still use generic Codex subagents by pasting the relevant Draht agent prompt into the delegated task.

### Command prompt wrappers

The command prompt wrappers are:

- `new-project`
- `init-project`
- `map-codebase`
- `next-milestone`
- `discuss-phase`
- `plan-phase`
- `execute-phase`
- `verify-work`
- `pause-work`
- `resume-work`
- `progress`
- `quick`
- `fix`
- `review`
- `atomic-commit`
- `orchestrate`

### Support skills

The GSD workflow templates live in `commands/`. The plugin also ships these supporting skills:

- `tdd-workflow`
- `ddd-workflow`
- `verification-gate`
- `brainstorming`
- `debugging-workflow`
- `atomic-reasoning`

### Hooks and scripts

The plugin includes `hooks/hooks.json` plus these scripts:

- `gsd-pre-execute.cjs`
- `gsd-post-task.cjs`
- `gsd-post-phase.cjs`
- `gsd-quality-gate.cjs`
- `session-start.cjs`
- `prompt-context.cjs`

Codex loads plugin-bundled hooks only after the user reviews and trusts them.

## Installation

```bash
# Install
npx draht-codex install

# Reinstall or refresh
npx draht-codex update

# Install to a custom local marketplace
npx draht-codex install --path /path/to/codex-marketplace

# Status
npx draht-codex status

# Remove
npx draht-codex uninstall
```

After installation, restart Codex and check:

```bash
codex plugin list
```

## draht-tools

The plugin bundles `draht-tools` at `bin/draht-tools.cjs`. You can also run it through the package CLI:

```bash
npx draht-codex draht-tools help
```

Reference prompt templates prefer the installed plugin path:

```bash
node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" help
```

`PLUGIN_ROOT` is the Codex plugin root when available. `CLAUDE_PLUGIN_ROOT` is kept as a compatibility fallback. The default installer path is used as the last fallback.

## Configuration

Reference agent model metadata can be edited in the installed plugin copy:

```bash
npx draht-codex configure --agent architect --model gpt-5.5
npx draht-codex configure --list
npx draht-codex configure --agent architect --reset
npx draht-codex configure --reset
```

This updates the bundled Markdown frontmatter. Codex-native custom agent routing may require user-level `~/.codex/config.toml` agent role configuration.

## Relationship to draht-claude

`draht-codex` is the Codex plugin sibling of `draht-claude`. The workflow content is intentionally close, but the package uses Codex plugin metadata, marketplace layout, hooks behavior, and install commands.

Use `draht-codex` when you want Draht inside Codex. Use `draht-claude` when you want the same workflows inside Claude Code.

## License

MIT. See [LICENSE](./LICENSE).
