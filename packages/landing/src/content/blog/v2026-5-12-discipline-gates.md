---
title: "v2026.5.12 — Discipline Gates for AI Coding Agents"
description: "Draht's May release adds a STATUS protocol on every subagent, a spec-reviewer that gates code-quality review, a four-phase /fix debugging protocol, and Red Flag stops across the workflow."
date: "2026-05-12"
author: "Oskar Freye"
tags: ["release", "workflow", "agents", "debugging", "tdd"]
---

Draft AI agents are happy to skip ahead. They will propose a fix before understanding the bug, mark a task complete before reading the diff, and claim a test passes without running it. Most of v2026.5.12 is a single answer to that pattern: install **gates** the agent cannot fast-forward past.

This release ships four of them — STATUS protocol, spec-reviewer, the four-phase `/fix`, and Red Flag stops — plus a handful of skills that make the discipline transversal.

## STATUS protocol on every subagent

Every subagent in `draht-claude` now ends its response with exactly one line:

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

The parent orchestrator reads that line and decides what to do next. The four values aren't decorative — they encode a handoff contract:

- **DONE** — work complete, downstream may proceed
- **DONE_WITH_CONCERNS** — work complete, but the caller should know about something before proceeding
- **NEEDS_CONTEXT** — could not evaluate; lists what's missing
- **BLOCKED** — non-compliant or unsafe to continue; downstream must NOT run until a re-dispatch returns DONE

The point is that "agent finished" and "downstream may proceed" are no longer the same event. A `BLOCKED` debugger result halts the fix. A `BLOCKED` spec-reviewer halts the quality review. The orchestrator stops guessing whether to continue.

## spec-reviewer — a new agent between implementer and reviewer

Two reviewers now run per task inside `/execute-phase`, in order:

1. **`spec-reviewer`** — does the diff implement exactly what the task spec asked for? No omissions, no over-builds.
2. **`reviewer`** — is the code well-written? Names, structure, abstractions, style.

These are deliberately separate jobs. The spec-reviewer's verdict is binary: `✅ COMPLIANT` or `❌ NON-COMPLIANT`. If non-compliant, quality review never runs — there's no point reviewing the prose of code that doesn't do what the plan asked for.

The Iron Rule the spec-reviewer enforces:

> A spec-compliant diff implements every `<test>` case the task lists, every behaviour the `<action>` describes, satisfies every assertion in `<done>`, touches only the files in `<files>`, and adds no features the task did not request.

"Close enough" returns `STATUS: BLOCKED` with the specific gaps. The implementer re-runs. Only then does the quality reviewer get a turn.

## `/fix` rewritten as a four-phase debugging protocol

The old `/fix` was a single shot at the bug. The new one enforces four phases with hard stops between them.

### The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

### Phase 1 — Root cause investigation

A `debugger` subagent reads the error, reproduces consistently, checks recent changes, traces data flow upward to the source, and states the root cause in one sentence: *"X happens because Y at file:line."* No fix yet.

### Phase 2 — Pattern analysis

Find working examples in the codebase that do the same thing correctly. Read them completely — not skimmed. List every difference between the working code and the broken code. If Phase 2 reveals a different root cause than Phase 1, return to Phase 1 — don't paper over the disagreement.

### Phase 3 — Single hypothesis test

State **one** hypothesis. Design the smallest possible change that would prove it. Apply, observe. If it doesn't fix the issue, form a new hypothesis — do not pile changes on top. **After three failed hypotheses, stop and report to the user. It's an architectural problem, not a hypothesis problem.**

### Phase 4 — Implementation, test-first

```
red:     reproduce <bug>       # failing test, committed
green:   fix <bug>              # minimal fix, full suite green, committed
refactor: <description>         # optional, behaviour-preserving
```

Untested fixes don't stick. A test-first proves the bug existed and proves the fix solved it.

## Red Flag gates across commands

Most workflow commands now carry a **Red Flags — STOP** section. These are not warnings — they are tripwires. The agent is instructed to stop the moment it notices any of:

- Proposing "quick fixes for now, investigate later"
- Attempting multiple changes simultaneously
- Skipping a reproducing test before fixing
- Making "one more fix attempt" after already trying two
- Marking work complete without running the verifying command

Combined with the verification-gate skill, the agent now has to provide evidence — a passing test run, a typecheck output — before saying "done", "fixed", "passing", or "ready to ship".

## New transversal skills

Four skills land that apply across commands, not inside any single one:

- **`atomic-reasoning`** — decompose work into independently-verifiable units before acting. The discipline that opens every workflow command. ([deeper write-up here](/blog/atomic-reasoning))
- **`debugging-workflow`** — the four-phase protocol from `/fix`, available transversally so the same discipline kicks in whenever the user reports a bug, not only when they type `/fix`.
- **`verification-gate`** — evidence before claims. Triggers on "done", "fixed", "should work", "passing", "ready". Forces the agent to run the proving command before asserting positive state.
- **`brainstorming`** — Socratic ideation gate before any project work begins. Refuses to plan or code on a fuzzy idea until the design has been refined and written to `.planning/specs/`.

These are skills rather than commands so they auto-trigger on language patterns ("broken", "doesn't work", "should I build", "ready to ship") rather than waiting for the user to type a slash command.

## Smaller but useful

- **`validate-plans`** now flags placeholder text and empty sections in `.planning/` files. Plans full of `<TODO>` or empty `<action>` blocks fail validation before they reach `/execute-phase`.
- **`configure` subcommand + agent model defaults** — pick which model each subagent runs on (e.g. `architect` on Opus, `verifier` on Haiku) without editing agent files by hand.
- **`workflow` skill refreshed** with the new subagent roster and the STATUS protocol so the workflow doc matches the agents that actually exist.

## Why all this at once

The four big pieces — STATUS, spec-reviewer, four-phase `/fix`, Red Flags — share a single shape: **a checkpoint that the agent cannot silently pass through**. Each one converts a soft expectation ("the agent will probably investigate first", "the agent should run the test") into a hard contract ("the parent waits for `STATUS: DONE`", "the next phase does not run until the reproducing test is committed").

The next milestone continues in this direction: tighter handoffs between subagents, and a verification corpus the agent has to point at — not just claim — before declaring work complete.

Install or upgrade:

```bash
# Claude Code plugin (workflow, subagents, skills, /fix, etc.)
npx draht-claude install

# Coding agent CLI
bun add -g @draht/coding-agent@latest
```

Full changelog in [`packages/draht-claude/CHANGELOG.md`](https://github.com/draht-dev/draht/blob/main/packages/draht-claude/CHANGELOG.md).
