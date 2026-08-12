---
name: draht
description: Router and catalog for the draht skill family — what draht is, the .planning/ state model, a situation-to-skill map covering every sibling skill, host-invocation guidance, and install/upgrade pointers. Use when the user asks what draht is, which draht skill fits their situation, how to invoke a draht skill on the current host, or how to install or upgrade the draht skill bundle.
---

# Draht

Draht is a methodology for running agentic coding work through a milestone → phase → plan → task hierarchy, backed by strict TDD/DDD discipline, a living codebase knowledge graph, and evidence-before-claims verification at every step. A project's state lives on disk in its `.planning/` directory rather than in any one conversation: `PROJECT.md` and `REQUIREMENTS.md` capture what is being built and its v1/v2 scope, `ROADMAP.md` groups phases into milestones, `DOMAIN.md` holds the bounded contexts and ubiquitous language, `STATE.md` and `CONTINUE-HERE.md` track current position and handoffs, `codebase/MAP.json` is the queryable knowledge graph, and `phases/NN-slug/` holds the plan and summary files for each phase — so progress, decisions, and domain model all survive across sessions, context resets, and even different agents. This skill is pure navigation: it does not restate any workflow's content, it routes to the sibling skill that owns it — see `gsd-workflow` for the full cycle mechanics and the complete `.planning/` schema.

## Two Kinds of Sibling Skills

- **9 discipline skills** — transversal habits that apply regardless of which command is running: `atomic-reasoning`, `brainstorming`, `ddd-workflow`, `debugging-workflow`, `gsd-workflow`, `loop-workflow`, `model-tiering`, `tdd-workflow`, `verification-gate`.
- **17 command skills** — one per stage of the GSD lifecycle, from greenfield questioning through milestone completion: `new-project`, `init-project`, `map-codebase`, `discuss-phase`, `plan-phase`, `execute-phase`, `verify-work`, `next-milestone`, `pause-work`, `resume-work`, `progress`, `quick`, `fix`, `review`, `atomic-commit`, `orchestrate`, `orchestrate-loop`.

Every skill's frontmatter `name` matches its directory name, so `skills/<name>/` and the name you invoke are always the same string.

## Repository Layout

- `skills/<name>/SKILL.md` — every skill has one; frontmatter (`name`, `description`) plus instructions.
- `skills/<name>/command.md` — the 17 command skills only. This is the full prompt template; the command skill's `SKILL.md` is a thin wrapper that reads it.
- The 9 discipline skills have no `command.md` — their `SKILL.md` is self-contained.
- This file, `skills/draht/SKILL.md`, is itself a plain skill (no `command.md`) — it is discovered and loaded the same way any discipline skill is.

## How the Catalog Composes

Command skills and discipline skills are not independent choices — most command skills lean on two or three disciplines while they run. `plan-phase` and `execute-phase` both assume `atomic-reasoning` and `tdd-workflow`; every command that ends with a completion claim assumes `verification-gate`; `fix` is a tracked wrapper around the `debugging-workflow` protocol; `orchestrate-loop` is `loop-workflow` applied to one goal. When in doubt about which disciplines a command skill pulls in, open that command skill's `command.md` — the disciplines it expects are named in its own text.

## Situation → Skill

### Project lifecycle and phase cycle

| Situation | Skill |
|---|---|
| Fuzzy idea, "what should I build" — before any planning starts | `brainstorming` |
| Starting a greenfield project from questioning through roadmap | `new-project` |
| Bringing draht's GSD workflow onto an existing codebase | `init-project` |
| Standalone architecture / domain / test-strategy extraction | `map-codebase` |
| Understanding the whole milestone → phase → plan → task cycle | `gsd-workflow` |
| Capturing decisions and gray areas before planning a phase | `discuss-phase` |
| Turning discussed decisions into atomic execution plans | `plan-phase` |
| Executing a planned phase, task by task, with TDD and review gates | `execute-phase` |
| Phase-level UAT: verifier + security-auditor + reviewer + spec-reviewer | `verify-work` |
| Planning the next milestone once the current one is fully verified | `next-milestone` |

### Session continuity and ad-hoc work

| Situation | Skill |
|---|---|
| Pausing work and writing a handoff document | `pause-work` |
| Resuming a paused project from its handoff document | `resume-work` |
| Checking current position in the roadmap | `progress` |
| A small ad-hoc tracked task, lighter than a full phase | `quick` |
| Diagnosing and fixing one specific bug end to end | `fix` |
| Code review and security audit of recent changes | `review` |
| Splitting a diff into atomic conventional commits | `atomic-commit` |
| Decomposing a task and dispatching the right mix of specialists | `orchestrate` |
| Running one goal in a deterministic-check-gated loop until it passes | `orchestrate-loop` |

### Transversal disciplines

| Situation | Skill |
|---|---|
| Decomposing work into atomic, independently-verifiable units | `atomic-reasoning` |
| Domain modelling — bounded contexts, ubiquitous language, naming | `ddd-workflow` |
| Investigating any failure transversally (the protocol behind `fix`) | `debugging-workflow` |
| Designing or reasoning about iterate-until-a-check-passes loops | `loop-workflow` |
| Choosing which model tier should run a session vs its subagents | `model-tiering` |
| Writing testable code — the red → green → refactor cycle | `tdd-workflow` |
| About to claim "done", "fixed", "passing", "ready", or "complete" | `verification-gate` |

## Disambiguation

A few sibling pairs are easy to reach for incorrectly:

- `fix` vs `debugging-workflow` — `fix` is the tracked command (creates a plan entry, stops after 3 failed attempts, commits the result); `debugging-workflow` is the four-phase protocol it runs internally, usable on its own mid-conversation without any tracking.
- `quick` vs `execute-phase` — `quick` is for a task with no roadmap phase behind it; `execute-phase` assumes a phase was already planned by `plan-phase` and has plan files to execute.
- `orchestrate` vs `orchestrate-loop` — `orchestrate` fans a task out to specialists once; `orchestrate-loop` re-runs one worker against a deterministic check until it passes or a bound is hit.
- `review` vs `verify-work` — `review` is ad hoc, any time; `verify-work` is the phase-level acceptance gate and additionally checks the diff against the phase's plan files.

## Host Invocation

| Host | How to invoke a draht skill |
|---|---|
| Claude Code | `/draht:<command>` slash commands for the 17 command skills (for example `/draht:plan-phase`); the 9 discipline skills load automatically by description match or on request |
| Codex | `$draht:<command>` prompts, or `/skills` and pick the wrapper, for the 17 command skills; discipline skills load automatically or by name |
| Any Agent-Skills-compatible host | invoke the sibling skill directly by name — every `SKILL.md` in this tree is self-contained and portable |
| draht CLI (`@draht/coding-agent`) | runs the GSD workflow natively; no skill indirection needed |

Once loaded, a skill behaves the same regardless of host — only the invocation surface differs. Skill bodies never hardcode a host name or a plugin-root path for this reason: the same `skills/` tree renders into both plugin packages, and could render into a future host's package the same way.

## Install and Upgrade

- `npx skills add draht-dev/draht` — generic Agent Skills install, works on any compatible host
- `npx draht-claude install` / `npx draht-claude update` — installs the command skills, specialist subagents, hooks, and discipline skills as a native plugin (see the Host Invocation table above)
- `npx draht-codex install` / `npx draht-codex update` — installs the command-wrapper skills, agent prompts, hooks, and discipline skills as a native plugin (see the Host Invocation table above)
- `npx draht-claude status` / `npx draht-codex status` — check what is currently installed
- `npx draht-claude configure --list` / `npx draht-codex configure --list` — inspect or override subagent model assignments
- `npx draht-claude uninstall` / `npx draht-codex uninstall` — remove a plugin install

## See Also

For the workflow content itself, do not read this file further — load the sibling skill named in the tables above. `gsd-workflow` is the best starting point for anyone who has not used draht before; it explains the full cycle that the command skills in this catalog each implement one step of.
