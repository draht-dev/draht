---
name: draht
description: Router and catalog for Draht coding, verification, review, and optional project workflows. Use when the user asks what Draht is, which skill to select, how to invoke it, or how to install or upgrade the bundle.
---

# Draht

Draht provides coding tools, specialist agents, and verification workflows. Start from the user's task: inspect the code, choose a suitable approach, make the change, and run the relevant checks. Models can structure ordinary work without a prescribed planning ceremony. Load a skill when its specific capability helps or the user requests it.

GSD milestone → phase → plan → task tracking is optional. Use it only when the user chooses that project-management workflow; ordinary coding does not require `.planning/`, XML plans, roadmap updates, or session resets. Existing planning documents may supply relevant context without making their lifecycle the active task. The codebase graph and deterministic checks are useful independently of GSD.

This catalog routes to sibling skills; it does not activate them all.

## Two Kinds of Sibling Skills

- **16 support skills** — load the relevant discipline or explicitly chosen workflow: `atomic-reasoning`, `blast-radius`, `brainstorming`, `ddd-workflow`, `debugging-workflow`, `epistemics`, `explainers`, `gsd-workflow`, `judge`, `loop-workflow`, `model-tiering`, `saga-spawner`, `tdd-workflow`, `typescript-discipline`, `unslop`, `verification-gate`.
- **23 command skills** — explicit actions, including ad-hoc work and optional GSD lifecycle stages: `new-project`, `init-project`, `map-codebase`, `discuss-phase`, `plan-phase`, `execute-phase`, `verify-work`, `next-milestone`, `pause-work`, `resume-work`, `progress`, `quick`, `fix`, `review`, `atomic-commit`, `orchestrate`, `orchestrate-loop`, `resolve-conflicts`, `grill`, `why`, `create-verification-skill`, `triage`, `speak`.

Every skill's frontmatter `name` matches its directory name, so `skills/<name>/` and the name you invoke are always the same string.

## Repository Layout

- `skills/<name>/SKILL.md` — every skill has one; frontmatter (`name`, `description`) plus instructions.
- `skills/<name>/command.md` — the 23 command skills only. This is the full prompt template; the command skill's `SKILL.md` is a thin wrapper that reads it.
- The 16 support skills have no `command.md` — their `SKILL.md` is self-contained.
- This file, `skills/draht/SKILL.md`, is itself a plain skill (no `command.md`) — it is discovered and loaded the same way any discipline skill is.

## How the Catalog Composes

An explicitly selected command may use supporting disciplines; ordinary requests do not need a command workflow. `plan-phase` and `execute-phase` both assume `atomic-reasoning` and `tdd-workflow`; every command that ends with a completion claim assumes `verification-gate`; `fix` applies the `debugging-workflow` protocol; `orchestrate-loop` is `loop-workflow` applied to one goal; `why` leans on `epistemics` for every claim it reports; `triage` borrows `debugging-workflow`'s cause-first discipline for its bounded trace and `epistemics` for labeling what it carries into a ticket; `create-verification-skill` generates the project-local harness whose evidence `verification-gate` demands and `verify-work`'s verifier drives; `review`'s refutation step escalates to `blast-radius`'s rung-4 script when a Critical finding hinges on library or runtime behavior; `why`, `review`, `plan-phase`, `verify-work`, and `blast-radius` reach for `explainers` when their output is a graph. When in doubt about which disciplines a command skill pulls in, open that command skill's `command.md` — the disciplines it expects are named in its own text.

## Situation → Skill

### Optional project lifecycle and phase cycle

| Situation | Skill |
|---|---|
| User requests project brainstorming or help resolving goals and scope | `brainstorming` |
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
| Complete an ad-hoc task directly with relevant verification | `quick` |
| Diagnosing and fixing one specific bug end to end | `fix` |
| Code review and security audit of recent changes | `review` |
| Splitting a diff into atomic conventional commits | `atomic-commit` |
| Decomposing a task and dispatching the right mix of specialists | `orchestrate` |
| Running one goal in a deterministic-check-gated loop until it passes | `orchestrate-loop` |
| Resolving an in-progress merge/rebase conflict — including a failed `agent/<taskId>` worktree merge-back | `resolve-conflicts` |
| Stress-testing any subject — an idea, a spec, tickets, a decision — in whole-frontier question rounds | `grill` |
| Recovering why code is the way it is — design rationale, decision history, rejected alternatives | `why` |
| Generating a committed project-local `verify-<app>` skill that drives the real app as a user and captures proof artifacts | `create-verification-skill` |
| Classifying an external issue report — dedupe, file, reroute, or answer — without fixing it | `triage` |

### Supporting disciplines and optional workflows

| Situation | Skill |
|---|---|
| Decomposing work into atomic, independently-verifiable units | `atomic-reasoning` |
| Finding what a change breaks beyond the diff and proving the one fact it's safe because of | `blast-radius` |
| Domain modelling — bounded contexts, ubiquitous language, naming | `ddd-workflow` |
| Investigating any failure transversally (the protocol behind `fix`) | `debugging-workflow` |
| Calibrating confidence, citations, and gaps when reporting investigation findings | `epistemics` |
| Showing structure as an evidence-built diagram or HTML explainer instead of prose | `explainers` |
| Designing or reasoning about iterate-until-a-check-passes loops | `loop-workflow` |
| Choosing which model tier should run a session vs its subagents | `model-tiering` |
| Putting a human in the loop — permission prompts and finished turns queued as cards to swipe through | `judge` |
| Advancing a repo unattended — saga graph, beats, scheduled or cloud routines | `saga-spawner` |
| Writing testable code — the red → green → refactor cycle | `tdd-workflow` |
| Writing or editing TypeScript — modelling state, narrowing, casts, exhaustiveness | `typescript-discipline` |
| Editing prose deliverables — cutting AI tells from docs, reports, handoffs, commit bodies | `unslop` |
| About to claim "done", "fixed", "passing", "ready", or "complete" | `verification-gate` |

## Disambiguation

A few sibling pairs are easy to reach for incorrectly:

- `fix` vs `debugging-workflow` — `fix` is an explicitly selected bug-fixing workflow with reproduction and retry limits; `debugging-workflow` supplies investigation discipline without requiring project tracking.
- `quick` vs `execute-phase` — `quick` completes an ad-hoc task without planning artifacts; `execute-phase` explicitly selects execution of existing phase plans and their review gates.
- `orchestrate` vs `orchestrate-loop` — `orchestrate` fans a task out to specialists once; `orchestrate-loop` re-runs one worker against a deterministic check until it passes or a bound is hit.
- `review` vs `verify-work` — `review` is ad hoc, any time; `verify-work` is the phase-level acceptance gate and additionally checks the diff against the phase's plan files.
- `grill` vs `brainstorming` — `brainstorming` is the project-creation gate: it ends in a written spec and a handoff to `/new-project` or `/init-project`; `grill` interrogates any subject with no presumed outcome — the artifact (spec, tickets, decision record, notes, or nothing) is chosen only when the frontier is empty.
- `why` vs `fix`/`debugging-workflow` — `why` reconstructs intent and history when nothing is misbehaving ("why is it built this way"); `fix` and the debugging protocol answer defects ("why is it doing the wrong thing right now"). A `why` run that uncovers a live defect hands off to `fix`; a `fix` that needs design intent consults `why`.
- `blast-radius` vs `review` — `review` audits a diff for defects across the board and merges subagent findings; `blast-radius` investigates one change's impact beyond the diff, reducing its safety to a single fact proven by running real code. `review`'s refutation step borrows blast-radius's rung-4 bar for Critical findings; the phrase "uncertainty × blast radius" in the planning commands is a risk-ordering heuristic, not this skill.
- `create-verification-skill` vs `verify-work` — `verify-work` is the recurring phase acceptance gate; `create-verification-skill` is the one-time generator of the committed `verify-<app>` skill that `verify-work`'s verifier then drives. Generate once, drive every phase.
- `triage` vs `fix` — `fix` starts from a bug you already own and ends in a landed fix; `triage` starts from someone else's report and ends in one verdict: a classification, a typed dedupe outcome, and at most one tracker issue. A `[triage:bug]` marker with its tracker link is a ready entry into `fix`; `triage` never fixes, and `fix` never files tickets.

## Host Invocation

| Host | How to invoke a draht skill |
|---|---|
| Claude Code | `/draht:<command>` slash commands for the 23 command skills (for example `/draht:plan-phase`); the 16 discipline skills load automatically by description match or on request |
| Codex | `$draht:<command>` prompts, or `/skills` and pick the wrapper, for the 23 command skills; discipline skills load automatically or by name |
| Any Agent-Skills-compatible host | invoke the sibling skill directly by name — every `SKILL.md` in this tree is self-contained and portable |
| draht CLI (`@draht/coding-agent`) | work directly with the coding tools, or explicitly invoke a bundled command |

Once loaded, a skill behaves the same regardless of host — only the invocation surface differs. Skill bodies never hardcode a host name or a plugin-root path for this reason: the same `skills/` tree renders into both plugin packages, and could render into a future host's package the same way.

## Install and Upgrade

- `npx skills add draht-dev/draht` — generic Agent Skills install, works on any compatible host
- `npx draht-claude install` / `npx draht-claude update` — installs the command skills, specialist subagents, hooks, and discipline skills as a native plugin (see the Host Invocation table above)
- `npx draht-codex install` / `npx draht-codex update` — installs the command-wrapper skills, agent prompts, hooks, and discipline skills as a native plugin (see the Host Invocation table above)
- `npx draht-claude status` / `npx draht-codex status` — check what is currently installed
- `npx draht-claude configure --list` / `npx draht-codex configure --list` — inspect or override subagent model assignments
- `npx draht-claude uninstall` / `npx draht-codex uninstall` — remove a plugin install

## See Also

For the workflow content itself, do not read this file further — load the sibling skill named in the tables above. Start with the task itself. Load `gsd-workflow` only for its optional milestone and phase tracking; use the other skills independently when they help.
