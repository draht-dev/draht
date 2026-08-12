---
description: Execute all plans in a phase with atomic commits (parallel implementer subagents + per-task two-stage review + TDD cycle)
argument-hint: "<phase-number> [--gaps-only]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /execute-phase

Execute all plans in a phase with atomic commits, parallelizing independent plans via subagents. Each task is implemented, then **spec-reviewed**, then **quality-reviewed** before the next task begins.

Phase: $1
Arguments: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagent delegation, dispatch one subagent per role (`implementer`, `spec-reviewer`, `reviewer`). When your host supports concurrent subagent calls, dispatch multiple parallel roles in a single assistant turn.

## Red Flags — STOP

STOP and report to the user instead of proceeding if **any** of these is true:

- `gsd-pre-execute.cjs` exits non-zero (missing DOMAIN.md, missing plans, uncommitted changes blocking start)
- Any plan file contains placeholder text: `[TBD]`, `[files]`, `[description]`, "appropriate error handling", "similar to Task N", "..." in code positions, or empty `<test>` / `<action>` / `<verify>` / `<done>` sections — these are not executable
- A plan has zero `<task>` elements
- `.planning/DOMAIN.md` is absent on a non-greenfield project — implementers will guess at naming
- The working tree is dirty with changes unrelated to this phase
- An implementer subagent returns `STATUS: BLOCKED` — never retry blindly; report what blocked it and ask the user

## Atomic Reasoning

Before executing, decompose this phase execution into atomic reasoning units:

**For each plan in the phase:**
1. **State the logical component** — What is this plan's singular purpose? What observable outcome does it produce?
2. **Validate independence** — Can this plan execute in parallel with others, or does it depend on their outputs? Which files does it touch?
3. **Verify correctness** — What tests will prove this plan works? What failure modes exist?

**Synthesize execution strategy:**
- Identify parallel execution groups (plans with no shared files/dependencies)
- Order dependent plans (plan B depends on plan A's outputs)
- Within each group, dispatch the riskiest plan first (highest uncertainty × blast radius) — its failure invalidates the rest of the phase most cheaply, before effort has been sunk into work it would obsolete
- Map each plan to a subagent task with clear success criteria

## Steps

0. Run the pre-execute check:
   ```bash
   node "<PLUGIN_ROOT>/scripts/gsd-pre-execute.cjs" $1
   ```
   If it exits non-zero, STOP and report errors to the user. Do not proceed.

1. Run `draht-tools discover-plans $1` to find and order plans
2. Read each plan file yourself (from `.planning/phases/`) and analyze dependencies to identify which plans can run in parallel vs sequential. **Graph-impact:** run `draht-tools graph-impact <each plan's files>` and parallelize ONLY plans whose blast-radius/sink sets are disjoint; serialize any plans with overlapping reverse-dependents.
3. **Validate plans before dispatching:**
   ```bash
   node "<PLUGIN_ROOT>/bin/draht-tools.cjs" validate-plans $1
   ```
   If any plan reports placeholders or missing sections, STOP and fix the plan (or have the user re-run `/plan-phase`) before dispatching.

4. **Per-plan execution loop.** For each plan (parallel where independent, sequential where dependent):

   For each `<task>` in the plan, run a **three-stage** dispatch — implementer → spec-reviewer → reviewer — before moving to the next task. Do not pause for user input between tasks; only stop when a stage returns `STATUS: BLOCKED` or `STATUS: NEEDS_CONTEXT`.

   ### Stage 1 — Implementer
   Dispatch the `implementer` subagent with the prompt from the template below. Read the final `STATUS:` line in the response.
   - `STATUS: DONE` → **re-derive before trusting**: a `DONE` that does not quote its verification output (test counts, command output) is treated as `DONE_WITH_CONCERNS` — run the task's `<verify>` step yourself and read the result before Stage 2. Subagent claims are inputs, not verdicts.
   - `STATUS: DONE_WITH_CONCERNS` → note the concerns; if any are correctness issues, instruct the implementer to fix and re-dispatch; otherwise go to Stage 2.
   - `STATUS: NEEDS_CONTEXT` → provide the missing context (paste the relevant file content or decision) and re-dispatch. Do not skip.
   - `STATUS: BLOCKED` → STOP. Report the blocker to the user. Do not move on.

   ### Stage 2 — Spec-reviewer
   Once the implementer is DONE, dispatch the `spec-reviewer` subagent with a prompt of the form:
   ```
   Review the diff for task <task-name> in plan <plan-file> against the spec below. ONLY check spec compliance — does the diff implement exactly what the spec asked for, no more, no less?
   
   Task spec:
   <paste the <task>...</task> XML>
   
   Diff to review:
   <run `git diff <range>` and paste, or instruct the agent to run it>
   ```
   - `STATUS: DONE` → go to Stage 3.
   - `STATUS: DONE_WITH_CONCERNS` → note, go to Stage 3.
   - `STATUS: BLOCKED` → re-dispatch the implementer with the "Required Fixes" list to address the gaps. Repeat Stage 1+2 until `DONE`. **Never proceed to Stage 3 with a non-compliant diff.** **Hard cap: 3 implementer re-dispatches per task (across Stage 2 and Stage 3 combined).** On the 3rd failed re-dispatch, record the task as failed via the post-task hook and STOP — report the disagreement to the user. Never negotiate past the cap.

   ### Stage 3 — Reviewer (code quality)
   Once spec compliance is ✅, dispatch the `reviewer` subagent with a prompt of the form:
   ```
   Code-quality review of the diff for task <task-name>. Focus on correctness, type safety, conventions, maintainability, and domain language compliance. Spec compliance has already been confirmed — do NOT re-check spec.
   
   Diff to review:
   <run `git diff <range>` and paste, or instruct the agent to run it>
   ```
   - `STATUS: DONE` → task is complete, run the post-task hook (below), then move to the next task.
   - `STATUS: DONE_WITH_CONCERNS` → log the `Should fix` items; if any are correctness-critical, re-dispatch implementer; otherwise log and move on.
   - `STATUS: BLOCKED` → `Must fix` issues exist; re-dispatch the implementer with the issue list. Repeat the three stages until `DONE` — subject to the same **hard cap of 3 implementer re-dispatches per task**; at the cap, record the task as failed and STOP.

   ### Post-task hook
   After Stage 3 passes for a task — or when a task hits the re-dispatch cap — record the result:
   ```bash
   node "<PLUGIN_ROOT>/scripts/gsd-post-task.cjs" <phase> <plan> <task-num> <status> <commit-hash>
   ```
   If the hook exits non-zero (3+ recorded failures for the task), that is a **harness-enforced hard stop**: do not dispatch any further implementer runs for this task; report to the user or create a fix plan.

5. After all plans complete, run `draht-tools verify-phase $1` yourself (not the subagent)
6. Run the post-phase hook to generate the phase report:
   ```bash
   node "<PLUGIN_ROOT>/scripts/gsd-post-phase.cjs" $1
   ```
7. Run `draht-tools update-state` yourself
8. Final commit: `draht-tools commit-docs "complete phase $1 execution"`
9. Tell the user to start a fresh session (`/clear`) and run `/verify-work $1`

## Subagent Task Template (Stage 1: implementer)

```
Execute this plan. Here is the full plan content:

<paste full plan XML here>

[Optional — orchestrator MAY paste a `draht-tools graph-context <task files>` slice here for orientation (pkg/layer/importers/imports/sinks). Subagents typically cannot run draht-tools themselves.]

For each <task> in the plan, follow this TDD cycle:
1. RED — Write failing tests from <test>. Run the test runner, confirm they FAIL for the right reason. Commit with: git add <test-files> && git commit -m "red: <description>"
2. GREEN — Write minimal implementation from <action> to make tests pass. Run tests, confirm PASS. Commit with: git add <files> && git commit -m "green: <task name>"
3. REFACTOR — Apply <refactor> improvements if any. Tests must stay green after each change. Commit with: git add <files> && git commit -m "refactor: <description>"
4. VERIFY — Run the <verify> step, confirm <done> criteria are met.

Domain rules: Use ubiquitous language from .planning/DOMAIN.md (read it). Do not import across bounded context boundaries.

Checkpoint handling:
- type="auto" → execute silently.
- type="checkpoint:human-verify" → stop and report back what was built.
- type="checkpoint:decision" → stop and report the options.

Evidence rule: quote the decisive output of every test run and <verify> step in your report (pass/fail counts, exit codes, error text). Unquoted claims will be re-run by the orchestrator. If a plan instruction contradicts what you find in the code, stop and report NEEDS_CONTEXT — do not silently obey either side.

End your response with `STATUS: DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED` per the agent contract.
```

## Two-Stage Review Rationale

- **Spec compliance prevents over/under-building.** Implementers can drift — adding "helpful" extras or skipping pieces they think are obvious. The spec-reviewer catches this with fresh eyes.
- **Code quality runs only after spec ✅.** Mixing the two reviews lets quality concerns mask spec gaps. Keep them ordered.
- **Never accept "close enough" on spec compliance.** A `BLOCKED` from spec-reviewer means re-dispatch implementer, not move on.

## Parallelization Rules

- Plans sharing no files and having no dependency edges can run in parallel
- If plan B depends on output of plan A, plan B must wait for A to complete
- **Inside a plan, tasks run sequentially** — the three-stage review loop must complete before the next task starts (so each task gets clean review context)
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

This is one step in the per-phase cycle:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N
```

After completing this command, tell the user to start a fresh session (`/clear`) and run `/verify-work $1`. Do NOT suggest `/next-milestone`.

## Flags

- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
