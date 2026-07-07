---
description: "Execute a small ad-hoc task with tracking (implementer + TDD + optional spec-reviewer pass)"
---

# /quick

Execute a small ad-hoc task with tracking.

## Usage
```
/quick [description]
```

Task: $ARGUMENTS

## "Small" Is a Claim, Not a Fact

Before planning, verify the task is actually quick: grep the blast radius (callers, imports, tests touching the target). If the change reaches further than the description implies, say so and recommend `/plan-phase`-level treatment instead of forcing it through. And if the description names a solution ("add a flag"), confirm the problem it solves — a smaller fix may exist. A "quick task" that silently grows is how untracked complexity enters a codebase.

## Atomic Reasoning

Before executing, decompose this task into atomic reasoning units:

1. **State the logical component** — What is the single, concrete outcome? What files need to change? What behavior needs to work?
2. **Validate independence** — Can this be done without touching other features? What dependencies exist? What could break?
3. **Verify correctness** — What test proves this works? What edge cases matter? Is this testable behavior or pure config?

**Synthesize execution plan:**
- Define specific files to modify
- Write failing test (if testable behavior)
- Implement minimal solution
- Verify and document

## Steps
1. Run `draht-tools next-quick-number` to get task number
2. Analyze the task and write a concrete plan with actual task details (files, actions, verification). Pipe it into `draht-tools create-quick-plan`:
   ```
   echo 'plan content here' | draht-tools create-quick-plan NNN "$ARGUMENTS"
   ```
   The plan content must include: a `# Quick Task NNN: title` heading, a `## Tasks` section with one or more `<task>` XML blocks containing real file paths, real actions, and real verification steps — NOT placeholders like `[files]`.

3. **Stage 1 — Implementer.** Use the `subagent` tool in **single mode** with the `implementer` agent:
   ```
   Execute this task: $ARGUMENTS

   Follow the TDD cycle:
   - RED — Write a failing test that describes the desired behaviour
   - GREEN — Write the minimum implementation to make it pass
   - REFACTOR — Clean up while keeping the test green
   Exception: skip the TDD cycle only for pure config or documentation-only tasks that have no testable behaviour.

   After completion, report: files changed, tests written, and verification results.

   End your response with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` per the agent contract.

   Do NOT run draht, draht-tools, draht help, or pi commands — use only standard tools.
   ```

   Read the final `STATUS:` line:
   - `DONE` → go to Stage 2 (or skip Stage 2 for pure-config / pure-docs).
   - `DONE_WITH_CONCERNS` → log; if correctness, re-dispatch; otherwise continue.
   - `NEEDS_CONTEXT` → provide missing info and re-dispatch.
   - `BLOCKED` → STOP, report.

4. **Stage 2 — Spec-reviewer (skip for pure-config / pure-docs).** Use the `subagent` tool with the `spec-reviewer` agent. Prompt:
   ```
   Review the diff for quick task NNN against `.planning/quick/NNN-*-PLAN.md`. ONLY check spec compliance — does the diff implement exactly what the plan's <test>/<action>/<done> sections asked, no more, no less?

   End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
   ```
   - `DONE` → go to Stage 3.
   - `BLOCKED` → re-dispatch implementer with Required Fixes. Repeat until `DONE`.

5. **Stage 3 — Reviewer (optional code-quality pass).** For non-trivial quick tasks (more than one file, or domain code), use the `subagent` tool with the `reviewer` agent. Otherwise skip.
   - `DONE` → task complete.
   - `BLOCKED` → re-dispatch implementer with Must-fix list.

6. Write summary: `draht-tools write-quick-summary NNN`
7. Update state: `draht-tools update-state`

## When to skip Stage 3
- Pure config (tsconfig, biome, formatter)
- Docs-only edits
- Single-line obvious changes (typo, version bump)
