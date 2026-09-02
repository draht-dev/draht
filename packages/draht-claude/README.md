# draht-claude

Draht's GSD (Get Shit Done) workflow, multi-agent orchestration, and TDD/DDD discipline as a [Claude Code](https://claude.com/claude-code) plugin.

One package, one install command:

```bash
npx draht-claude install
```

This bundles everything draht gives its own CLI — slash commands, specialist subagents, workflow hooks, and the planning framework — so you can run the same flows inside Claude Code.

## What you get

### 23 slash commands

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
- `/orchestrate-loop <goal>` — verification-gated loop of fresh worker iterations until a deterministic check passes
- `/resolve-conflicts` — resolve an in-progress merge/rebase by reconstructing both sides' intent
- `/grill <subject>` — whole-frontier interrogation of any idea, spec, ticket list, or decision; output form chosen at the end
- `/why <question>` — code archaeology: parallel `investigator` subagents gather evidence per category, synthesized into a confidence-tiered, citation-backed answer
- `/triage <report>` — classify an external issue report after a bounded cause trace, dedupe against GitHub Issues, create a ticket only behind a fail-closed gate
- `/create-verification-skill [app]` — generate a committed project-local `verify-<app>` skill that drives the real app the way a user does and captures proof artifacts
- `/speak [text]` — speak text aloud via the ElevenLabs text-to-speech helper; with no text, voices a short summary of the latest result

### 11 specialist subagents

All usable via Claude Code's `Task` tool (`subagent_type: <name>`):

| Agent | Use |
|---|---|
| `advisor` | Strategic guidance on the strongest tier — consulted rarely, steers, never implements |
| `architect` | Reads codebase, produces structured implementation plans |
| `implementer` | Writes code following TDD cycle from plan tasks |
| `reviewer` | Reviews changes for correctness, types, conventions, domain language |
| `spec-reviewer` | Checks a completed task's diff against its spec — no more, no less |
| `debugger` | Reproduces and diagnoses bugs to root cause |
| `verifier` | Runs lint + typecheck + tests, reports results without fixing |
| `investigator` | Searches one assigned evidence category (git history, review/planning/decision records) and returns verbatim-cited findings for `/why` |
| `speaker` | Voices a summary or message aloud via the ElevenLabs helper; degrades to a text report without an API key or audio device |
| `git-committer` | Stages and commits with conventional commit messages |
| `security-auditor` | Scans for injection, auth, secrets, unsafe patterns |
| `advisor` | Strongest-tier strategic steer, consulted rarely when stuck or before committing to an approach |

### 17 bundled skills

- **`draht`** — router and catalog for the skill family: what draht is, which skill fits which situation
- **`gsd-workflow`** — complete GSD methodology reference (directory structure, cycle, hooks, config)
- **`tdd-workflow`** — red→green→refactor discipline, commit conventions, cycle violations
- **`ddd-workflow`** — bounded contexts, ubiquitous language, aggregates, domain events
- **`debugging-workflow`** — the four-phase systematic debugging protocol `/fix` enforces, available transversally
- **`atomic-reasoning`** — decompose work into independently verifiable units before acting
- **`brainstorming`** — Socratic ideation gate before any project work begins
- **`loop-workflow`** — cycles of work gated by deterministic checks until a stop condition holds
- **`model-tiering`** — advisor and orchestrator patterns for cost-efficient model selection
- **`verification-gate`** — evidence before claims: run the proving command before saying "done"
- **`saga-spawner`** — unattended repo advancement as a cloud routine reconciling a saga graph of beats
- **`cinematic-continuation`** — provider-neutral, time-coded video continuation from bundled distilled style and continuity references
- **`unslop`** — cut AI tells from prose deliverables, then add voice back so the result is neither slop nor sterile
- **`epistemics`** — confidence calibration for investigation findings: five tiers, cite-or-label-as-inference, null results as evidence
- **`typescript-discipline`** — make illegal states unrepresentable: discriminated unions, branded primitives, boundary parsing, exhaustiveness
- **`blast-radius`** — impact analysis beyond the diff: reduce the safety argument to one falsifiable fact and prove it on the evidence ladder
- **`judge`** — the human-judgment queue: how permission prompts and finished turns become cards, and how a reviewer's comment comes back into the session

### 4 workflow hook scripts

Invoked from inside commands (not Claude Code lifecycle hooks):

- `gsd-pre-execute.cjs <phase>` — preconditions before execution
- `gsd-post-task.cjs <phase> <plan> <task> <status> [commit]` — record result + verify TDD cycle
- `gsd-post-phase.cjs <phase>` — generate phase report, update ROADMAP status
- `gsd-quality-gate.cjs [--strict]` — lint + typecheck + test + coverage enforcement

### 5 Claude Code lifecycle hooks

- **SessionStart** — surfaces current phase, status, and CONTINUE-HERE marker when a session opens in a draht project (`session-start.cjs`)
- **UserPromptSubmit** — prepends a tiny `[draht]` reminder of phase/status before each prompt (`prompt-context.cjs`), then delivers any pending judge feedback (`judge-hook.cjs`)
- **PostToolUse** — after `Edit`/`Write`/`MultiEdit`, runs a fast check over the touched files (`post-edit-check.cjs`)
- **Stop** — runs the quality gate when a session ends (`stop-quality-gate.cjs`), then files the finished turn as a judge review card (`judge-hook.cjs`)
- **PermissionRequest** — while the judge TUI is running, parks the prompt as a card and waits for the human swipe (`judge-hook.cjs`)

The judge hooks are inert unless you run the TUI, and inert again where no Python interpreter is available — the normal permission dialog appears exactly as before.

### The judge queue

`judge` is a tinder-style TUI over the decisions every session on this machine is waiting on: permission prompts (→ allow, ← deny, with the comment delivered as the denial message) and finished turns (a ← reject reaches the session as a `[judge]` block it must address first). It runs in its own terminal pane, never inside a session:

```bash
npx draht-claude install-judge   # symlink into ~/.local/bin
judge                            # or: judge open, to pop a cmux split
```

State lives in `~/.claude/judge/`. `judge list` prints the queue, `judge clear` expires it.

### The draht status line

`statusline/statusline.py` renders `dir · model · context% · 5h · 7d · token burn · judge queue` in the draht foundry palette, sheds detail rather than letting the terminal chop it, and aggregates token burn incrementally from the transcripts under `~/.claude/projects/`:

```bash
npx draht-claude install-statusline    # writes settings.json (previous line saved)
npx draht-claude uninstall-statusline  # and restores it
```

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

# Opt into the status line and the judge TUI (also available as install flags:
# npx draht-claude install --statusline --judge)
npx draht-claude install-statusline
npx draht-claude install-judge

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
| `advisor` | `fable` | any command — rare, high-leverage course correction |
| `architect` | `opus` | `/plan-phase` — deep reasoning for architectural plans |
| `implementer` | `sonnet` | `/execute-phase` — fast, reliable code changes |
| `verifier` | `sonnet` | `/verify-work` — lint, typecheck, test runs |
| `security-auditor` | `opus` | `/verify-work` — security audit and CVE analysis |
| `reviewer` | `opus` | `/verify-work`, `/review` — code review |
| `spec-reviewer` | `opus` | `/execute-phase`, `/verify-work`, `/review`, `/quick` — spec compliance |
| `debugger` | `inherit` | `/fix` — bug diagnosis |
| `investigator` | `sonnet` | `/why` — parallel single-category evidence gathering |
| `speaker` | `haiku` | `/speak` — voice output via ElevenLabs |
| `git-committer` | `inherit` | `/atomic-commit` — commit staging |
| `advisor` | `fable` | any command — rare high-leverage strategic consults |

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
