# draht-claude

Draht's GSD (Get Shit Done) workflow, multi-agent orchestration, and TDD/DDD discipline as a [Claude Code](https://claude.com/claude-code) plugin.

One package, one install command:

```bash
npx draht-claude install
```

This bundles everything draht gives its own CLI — slash commands, specialist subagents, workflow hooks, and the planning framework — so you can run the same flows inside Claude Code.

## What you get

### 16 slash commands

**Project lifecycle**
- `/new-project` — greenfield: questioning → domain model → requirements → roadmap
- `/init-project` — existing codebase: map → extract domain → roadmap
- `/map-codebase` — standalone codebase analysis (parallel architect + verifier subagents)
- `/next-milestone` — plan the next milestone after all current phases are verified

**Per-phase cycle**
- `/discuss-phase N` — capture decisions and gray areas
- `/plan-phase N` — atomic execution plans (parallel architect subagents)
- `/execute-phase N` — TDD red→green→refactor (parallel implementer subagents)
- `/verify-work N` — parallel verifier + security-auditor + reviewer + quality gate

**Session continuity**
- `/pause-work` — create handoff document
- `/resume-work` — read handoff, verify state, continue
- `/progress` — show current position in the roadmap

**Ad-hoc**
- `/quick <task>` — small tracked task with TDD cycle
- `/fix <bug>` — diagnose → reproducing test → minimal fix (debugger + implementer subagents)
- `/review [scope]` — parallel code review + security audit
- `/atomic-commit` — analyze diff, split into atomic conventional commits
- `/orchestrate <task>` — decompose work and dispatch the right mix of specialist subagents

### 7 specialist subagents

All usable via Claude Code's `Task` tool (`subagent_type: <name>`):

| Agent | Use |
|---|---|
| `architect` | Reads codebase, produces structured implementation plans |
| `implementer` | Writes code following TDD cycle from plan tasks |
| `reviewer` | Reviews changes for correctness, types, conventions, domain language |
| `debugger` | Reproduces and diagnoses bugs to root cause |
| `verifier` | Runs lint + typecheck + tests, reports results without fixing |
| `git-committer` | Stages and commits with conventional commit messages |
| `security-auditor` | Scans for injection, auth, secrets, unsafe patterns |

### 3 workflow skills

- **`gsd-workflow`** — complete GSD methodology reference (directory structure, cycle, hooks, config)
- **`tdd-workflow`** — red→green→refactor discipline, commit conventions, cycle violations
- **`ddd-workflow`** — bounded contexts, ubiquitous language, aggregates, domain events

### 4 workflow hook scripts

Invoked from inside commands (not Claude Code lifecycle hooks):

- `gsd-pre-execute.cjs <phase>` — preconditions before execution
- `gsd-post-task.cjs <phase> <plan> <task> <status> [commit]` — record result + verify TDD cycle
- `gsd-post-phase.cjs <phase>` — generate phase report, update ROADMAP status
- `gsd-quality-gate.cjs [--strict]` — lint + typecheck + test + coverage enforcement

### 2 Claude Code lifecycle hooks

- **SessionStart** — surfaces current phase, status, and CONTINUE-HERE marker when a session opens in a draht project
- **UserPromptSubmit** — prepends a tiny `[draht]` reminder of phase/status before each prompt

### Bundled `draht-tools` CLI

All GSD file operations (`init`, `create-project`, `create-domain-model`, `create-plan`, `verify-phase`, `commit-docs`, ...) ship as a standalone Node CJS binary at `${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs`. No separate install required.

## Installation

The easiest way is the one-shot installer:

```bash
npx draht-claude install
```

That copies the plugin into `~/.claude/plugins/draht/`. Restart Claude Code and the commands appear in the slash command picker.

Other install options:

```bash
# Reinstall or refresh to latest
npx draht-claude update

# Install to a custom location
npx draht-claude install --path /path/to/plugins/draht

# Check install status
npx draht-claude status

# Configure subagent models
npx draht-claude configure --agent architect --model opus
npx draht-claude configure --agent implementer --model sonnet
npx draht-claude configure --list

# Remove
npx draht-claude uninstall
```

Or install manually:

```bash
mkdir -p ~/.claude/plugins/draht
cd ~/.claude/plugins/draht
npm pack draht-claude
tar -xzf draht-claude-*.tgz --strip-components=1
rm draht-claude-*.tgz package.json cli.mjs
```

## Quick Start

### Greenfield project

```
/new-project a team calendar with slot-based booking
```

Claude Code will question you through problem, audience, MVP scope, then generate `.planning/PROJECT.md`, `.planning/DOMAIN.md`, `.planning/TEST-STRATEGY.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md`.

### Existing project

```
/init-project refactor the billing module
```

Claude Code will map the codebase, extract the current domain model, and propose a roadmap that respects what already works.

### Per-phase cycle

```
/discuss-phase 1     # capture decisions
/clear               # fresh session

/plan-phase 1        # parallel architect subagents produce atomic plans
/clear

/execute-phase 1     # parallel implementer subagents run TDD cycles
/clear

/verify-work 1       # parallel verifier + security + reviewer + quality gate
```

Between every step, run `/clear` to start a fresh session. This is a feature — each cycle step is designed to run in a clean context.

### Pause and resume

```
/pause-work          # creates .planning/CONTINUE-HERE.md
# ... close laptop, go do other things ...

/resume-work         # reads handoff, checks state, continues
```

## Configuration

### Subagent models

Each specialist subagent ships with a default model tuned to its workload:

| Agent | Default | Used by |
|---|---|---|
| `architect` | `opus` | `/plan-phase` — deep reasoning for architectural plans |
| `implementer` | `sonnet` | `/execute-phase` — fast, reliable code changes |
| `verifier` | `sonnet` | `/verify-work` — lint, typecheck, test runs |
| `security-auditor` | `opus` | `/verify-work` — security audit and CVE analysis |
| `reviewer` | `inherit` | `/verify-work`, `/review` — code review |
| `debugger` | `inherit` | `/fix` — bug diagnosis |
| `git-committer` | `inherit` | `/atomic-commit` — commit staging |

You can override any agent with the `configure` command:

```bash
# Set architect (planning) to Opus and implementer to Sonnet
npx draht-claude configure --agent architect --model opus
npx draht-claude configure --agent implementer --model sonnet

# Use a full model ID
npx draht-claude configure --agent verifier --model claude-opus-4-7

# List current assignments
npx draht-claude configure --list

# Reset a single agent to default
npx draht-claude configure --agent architect --reset

# Reset all agents to defaults
npx draht-claude configure --reset
```

Supported values: `opus`, `sonnet`, `haiku`, a full model ID (e.g. `claude-sonnet-4-6`), or `inherit`.

### Hooks

Create `.planning/config.json` in your project to tune the hooks:

```json
{
  "hooks": {
    "coverageThreshold": 80,
    "tddMode": "advisory",
    "qualityGateStrict": false
  }
}
```

- `tddMode`: `"strict"` aborts on `green:` commits without a preceding `red:`; `"advisory"` logs a warning
- `qualityGateStrict`: `true` fails the gate on any lint/type/test/coverage miss
- `coverageThreshold`: minimum coverage percent required by the quality gate

## How It Differs From `@draht/coding-agent`

This package is a subset of draht packaged for Claude Code:

| Feature | `@draht/coding-agent` | `draht-claude` |
|---|---|---|
| Full TUI runtime | ✅ | — (runs inside Claude Code) |
| GSD slash commands | ✅ | ✅ |
| Specialist subagents | ✅ | ✅ |
| TDD / DDD hooks | ✅ | ✅ |
| `draht-tools` CLI | ✅ | ✅ (bundled) |
| Extensions / Skills / Themes | ✅ | Skills only |
| Multi-agent orchestration | ✅ (built-in subagent tool) | ✅ (via Claude Code Task tool) |
| MCP, custom providers | ✅ | — (use Claude Code's native support) |
| Self-installing CLI | — | ✅ (`npx draht-claude install`) |

Use `draht-claude` when you want draht's methodology inside Claude Code. Use `@draht/coding-agent` when you want draht as a standalone harness with your own providers, extensions, and TUI.

## License

MIT. See [LICENSE](./LICENSE).

Part of the [draht](https://draht.dev) project.
