---
description: Execute a small ad-hoc task with tracking (implementer subagent + TDD cycle + optional spec-reviewer pass)
argument-hint: "<description>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /quick

Execute a small ad-hoc task with tracking.

Task: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "implementer" | "spec-reviewer" | "reviewer"`.

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
   ```bash
   echo 'plan content here' | node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" create-quick-plan NNN "$ARGUMENTS"
   ```
   The plan content must include: a `# Quick Task NNN: title` heading, a `## Tasks` section with one or more `<task>` XML blocks containing real file paths, real actions, and real verification steps — NOT placeholders like `[files]`.

3. **Stage 1 — Implementer.** _Optional scoping (multi-file tasks):_ run `draht-tools graph-context <files>` and paste the pkg/layer/importers summary into the implementer prompt. Then dispatch via the Task tool with `subagent_type: "implementer"` and prompt:
   ```
   Execute this task: $ARGUMENTS

   Follow the TDD cycle:
   - RED — Write a failing test that describes the desired behaviour
   - GREEN — Write the minimum implementation to make it pass
   - REFACTOR — Clean up while keeping the test green

   Exception: skip the TDD cycle only for pure config or documentation-only tasks that have no testable behaviour.

   After completion, report: files changed, tests written, and verification results.

   End your response with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` per the agent contract.
   ```

   Read the final `STATUS:` line:
   - `DONE` → go to Stage 2 (or skip Stage 2 for pure-config / pure-docs tasks).
   - `DONE_WITH_CONCERNS` → log concerns; correctness issues → re-dispatch; otherwise continue.
   - `NEEDS_CONTEXT` → provide missing info and re-dispatch.
   - `BLOCKED` → STOP, report to user.

4. **Stage 2 — Spec-reviewer (skip for pure-config / pure-docs).** Dispatch with `subagent_type: "spec-reviewer"` and prompt:
   ```
   Review the diff for this quick task against the plan written in `.planning/quick/NNN-*-PLAN.md`. ONLY check spec compliance — does the diff implement exactly what the plan's <test>/<action>/<done> sections asked, no more, no less?

   Plan path: <plan file>
   Diff: <run `git diff` on the commits since plan creation, or instruct the agent to>

   End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
   ```

   - `DONE` → go to Stage 3.
   - `BLOCKED` → re-dispatch implementer with the "Required Fixes" list. Repeat Stage 1+2 until `DONE`. **Hard cap: 3 implementer re-dispatches total (across Stage 2 and Stage 3).** At the cap, STOP and report the disagreement to the user.

5. **Stage 3 — Reviewer (optional code-quality pass).** For non-trivial quick tasks (touches more than one file or modifies domain code), _optionally_ run `draht-tools graph-impact <changed files>` and paste its reverse-dependents + boundary warnings into the reviewer prompt. Then dispatch with `subagent_type: "reviewer"`:
   ```
   Code-quality review of the diff for quick task NNN. Spec compliance already confirmed — focus on correctness, type safety, conventions, domain language. Report Must fix / Should fix / Consider.

   End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
   ```

   - `DONE` → quick task complete.
   - `BLOCKED` → re-dispatch implementer with the Must-fix list — subject to the same **hard cap of 3 re-dispatches**; at the cap, STOP and report.

6. Write summary: `draht-tools write-quick-summary NNN`
7. Update state: `draht-tools update-state`

## When to skip Stage 3

Stage 3 (quality review) is optional for `/quick` since these are by definition small tasks. Run it when:
- The diff touches more than one file
- The diff modifies code in `.planning/DOMAIN.md`'s bounded contexts
- The task is non-trivial behaviour, not pure mechanical change

Skip it when:
- Pure config (tsconfig, biome, formatter changes)
- Docs-only edits
- Single-line, obvious changes (typo fix, version bump)
