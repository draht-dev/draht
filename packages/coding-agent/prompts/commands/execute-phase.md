---
description: "Execute all plans in a phase with atomic commits + per-task two-stage review"
---

# /execute-phase

Execute all plans in a phase with atomic commits, parallelizing independent plans via subagents. Each task is implemented, then **spec-reviewed**, then **quality-reviewed** before the next task begins.

## Usage
```
/execute-phase [N] [--gaps-only]
```

Phase: $1
Arguments: $ARGUMENTS

## Red Flags — STOP

STOP and report to the user instead of proceeding if **any** of these is true:

- Any plan file contains placeholder text: `[TBD]`, `[files]`, `[description]`, "appropriate error handling", "similar to Task N", or empty `<test>` / `<action>` / `<verify>` / `<done>` sections
- A plan has zero `<task>` elements
- `.planning/DOMAIN.md` is absent on a non-greenfield project
- The working tree is dirty with changes unrelated to this phase
- A subagent returns `STATUS: BLOCKED` — never retry blindly; report and ask the user

## Atomic Reasoning

Before executing, decompose this phase execution into atomic reasoning units:

**For each plan in the phase:**
1. **State the logical component** — What is this plan's singular purpose? What observable outcome does it produce?
2. **Validate independence** — Can this plan execute in parallel with others, or does it depend on their outputs? Which files does it touch?
3. **Verify correctness** — What tests will prove this plan works? What failure modes exist?

**Synthesize execution strategy:**
- Identify parallel execution groups (plans with no shared files/dependencies)
- Order dependent plans (plan B depends on plan A's outputs)
- Map each plan to a subagent task with clear success criteria

## Steps
1. Run `draht-tools discover-plans $1` to find and order plans
2. Run `draht-tools validate-plans $1` — if any plan has placeholders or missing sections, STOP and fix the plan first
3. Read each plan file yourself (from `.planning/phases/`) and analyze dependencies to identify which plans can run in parallel vs sequential
4. **Per-plan execution loop.** For each plan (parallel where independent, sequential where dependent), iterate over its `<task>` elements with a **three-stage** dispatch:

   ### Stage 1 — Implementer
   Use the `subagent` tool in **single mode** with the `implementer` agent. Prompt includes the full plan content + the TDD cycle instructions (template below). Read the final `STATUS:` line:
   - `DONE` → go to Stage 2.
   - `DONE_WITH_CONCERNS` → if concerns are correctness-related, re-dispatch with a fix instruction; otherwise note and proceed.
   - `NEEDS_CONTEXT` → provide the missing info and re-dispatch.
   - `BLOCKED` → STOP, report to the user.

   ### Stage 2 — Spec-reviewer
   Use the `subagent` tool with the `spec-reviewer` agent. ONLY checks "does the diff cover exactly what the spec asked for". Prompt includes the task XML and the diff range.
   - `DONE` → go to Stage 3.
   - `DONE_WITH_CONCERNS` → note and proceed.
   - `BLOCKED` → re-dispatch implementer with the "Required Fixes" list; repeat Stage 1+2 until `DONE`. Never proceed to Stage 3 with a non-compliant diff.

   ### Stage 3 — Reviewer (code quality)
   Use the `subagent` tool with the `reviewer` agent for code-quality review. Spec compliance is already ✅.
   - `DONE` → task complete; move to next task.
   - `DONE_WITH_CONCERNS` → log `Should fix` items; if any are correctness-critical, re-dispatch implementer.
   - `BLOCKED` → `Must fix` issues exist; re-dispatch implementer with the issue list. Repeat until `DONE`.

5. After all plans complete, run `draht-tools verify-phase $1` yourself (not the subagent)
6. Run `draht-tools update-state` yourself
7. Final commit: `draht-tools commit-docs "complete phase $1 execution"`
8. After execution, tell the user to start a new session and run `/verify-work $1`.

## Subagent Task Template (Stage 1: implementer)

Each implementer subagent receives a task like:

```
Execute this plan. Here is the full plan content:

<paste full plan XML here>

For each <task> in the plan, follow this TDD cycle:
1. RED — Write failing tests from <test>. Run the test runner, confirm they FAIL. Commit with: git add <test-files> && git commit -m "red: <description>"
2. GREEN — Write minimal implementation from <action> to make tests pass. Run tests, confirm PASS. Commit with: git add <files> && git commit -m "green: <task name>"
3. REFACTOR — Apply <refactor> improvements if any. Tests must stay green after each change. Commit with: git add <files> && git commit -m "refactor: <description>"
4. VERIFY — Run the <verify> step, confirm <done> criteria are met.

Domain rules: Use ubiquitous language from .planning/DOMAIN.md (read it). Do not import across bounded context boundaries.
Checkpoint handling: type="auto" → execute silently. type="checkpoint:human-verify" → stop and report back what was built. type="checkpoint:decision" → stop and report the options.

End your response with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` per the agent contract.

Important: Do NOT run draht, draht-tools, draht help, or pi commands. Use only standard tools (read, bash, edit, write, grep, find, ls).
```

## Two-Stage Review Rationale

- **Spec compliance prevents over/under-building.** The spec-reviewer catches drift before quality review masks it.
- **Code quality runs only after spec ✅.** Never accept "close enough" on spec compliance.
- **Tasks within a plan are sequential** — review loop completes before next task starts.

## Parallelization Rules
- Plans sharing no files and having no dependency edges can run in parallel
- Inside a plan, tasks run sequentially with the three-stage loop
- Maximum parallel subagents: follow the subagent tool limits (max 8 tasks, 4 concurrent)
- If a parallel subagent fails, report which plan failed and continue with independent plans

## TDD Rules
- Never write implementation before a failing test exists
- If a test passes immediately after being written, it is not testing the right thing — fix it
- Red → Green → Refactor is not optional; skipping steps invalidates the safety net
- Each TDD phase gets its own commit so the history is auditable

## Domain Rules
- All identifiers (class names, method names, variables) must use the ubiquitous language from `.planning/DOMAIN.md`
- Do not import across bounded context boundaries directly — use domain events or ACL adapters
- If implementation reveals a missing domain term, stop and update DOMAIN.md before continuing

## Workflow
This is one step in the per-phase cycle. Each step runs in its own session (`/new` between steps):

```
/discuss-phase N → /new → /plan-phase N → /new → /execute-phase N → /new → /verify-work N → /new → /discuss-phase N+1 → ...
```

After completing this command, tell the user to start a new session and run `/verify-work $1`.
Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Flags
- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
