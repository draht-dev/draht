# draht-codex

Draht's GSD workflow, multi-agent orchestration prompts, TDD discipline, DDD guidance, and planning framework as a Codex plugin.

Install:

```bash
npx draht-codex install
```

This creates a local Codex marketplace at `~/.draht/codex-marketplace`, installs the `draht` plugin, and bundles prompt command templates, specialist agent prompts, skills, hooks, scripts, and `draht-tools`.

## What you get

### Command templates

Project lifecycle:

- `/draht:new-project` - greenfield questioning, domain model, requirements, roadmap
- `/draht:init-project` - existing codebase mapping, domain extraction, roadmap
- `/draht:map-codebase` - standalone codebase map
- `/draht:next-milestone` - plan the next milestone after current phases are verified

Per-phase cycle:

- `/draht:discuss-phase N`
- `/draht:plan-phase N`
- `/draht:execute-phase N`
- `/draht:verify-work N`

Session continuity:

- `/draht:pause-work`
- `/draht:resume-work`
- `/draht:progress`

Ad-hoc:

- `/draht:quick <task>`
- `/draht:fix <bug>`
- `/draht:review [scope]`
- `/draht:atomic-commit`
- `/draht:orchestrate <task>`

Codex may display plugin slash commands with a namespace such as `/draht:<command>`.

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

### Additional skills

The GSD workflow itself is provided by the prompt commands above. The plugin also ships these supporting skills:

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

Command templates prefer the installed plugin path:

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
