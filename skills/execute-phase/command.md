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

## Execution prerequisites

Validate plans before execution and honor pre-execute hook failures. Preserve unrelated work. An implementation blocker stops that task; a review blocker follows the bounded correction loop below.

## Steps

0. Run the pre-execute check:
   ```bash
   node "<PLUGIN_ROOT>/scripts/gsd-pre-execute.cjs" $1
   ```
   If it exits non-zero, STOP and report errors to the user. Do not proceed.

1. Run `draht-tools discover-plans $1` to find and order plans
2. Read each plan file yourself (from `.planning/phases/`) and analyze dependencies to identify which plans can run in parallel vs sequential. **Graph-impact:** run `draht-tools graph-impact <each plan's files>` and use dependency and impact information to avoid conflicting changes and shared mutable resources.
3. **Validate plans before dispatching:**
   ```bash
   node "<PLUGIN_ROOT>/bin/draht-tools.cjs" validate-plans $1
   ```
   If any plan reports placeholders or missing sections, STOP and fix the plan (or have the user re-run `/plan-phase`) before dispatching.

4. **Per-plan execution loop.** For each plan (parallel where independent, sequential where dependent):

   For each `<task>` in the plan, run a **three-stage** dispatch — implementer → spec-reviewer → reviewer — before moving to the next task. Do not pause for user input between tasks. Resolve missing context and review findings through the branches below; stop for an implementer blocker, unavailable required context, or the retry cap.

   ### Stage 1 — Implementer
   Dispatch the `implementer` subagent with the prompt from the template below. Read the final `STATUS:` line in the response.
   - `STATUS: DONE` → inspect the actual verification evidence and checked state. Reuse results only if the relevant inputs and environment are unchanged; run missing, stale, or insufficient verification before Stage 2.
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
   - `STATUS: NEEDS_CONTEXT` → supply the missing spec, diff, or context and repeat this review; do not advance.
   - `STATUS: BLOCKED` → re-dispatch the implementer with the "Required Fixes" list to address the gaps. Repeat Stage 1+2 until `DONE`. **Never proceed to Stage 3 with a non-compliant diff.** **Hard cap: 3 implementer re-dispatches per task (across Stage 2 and Stage 3 combined).** On the 3rd failed re-dispatch, record the task as failed via the post-task hook and STOP — report the disagreement to the user. Never negotiate past the cap.

   ### Stage 3 — Reviewer (code quality)
   Once spec compliance is ✅, dispatch the `reviewer` subagent with a prompt of the form:
   ```
   Code-quality review of the diff for task <task-name>. Focus on correctness, type safety, conventions, maintainability, and domain language compliance. Spec compliance has already been confirmed. Do not repeat the full spec audit; escalate any discovered mismatch as Must fix for spec re-review.

   Diff to review:
   <run `git diff <range>` and paste, or instruct the agent to run it>
   ```
   - `STATUS: DONE` → task is complete, run the post-task hook (below), then move to the next task.
   - `STATUS: DONE_WITH_CONCERNS` → log the `Should fix` items; if any are correctness-critical, re-dispatch implementer; otherwise log and move on.
   - `STATUS: NEEDS_CONTEXT` → supply the missing diff or context and repeat this review; do not advance.
   - `STATUS: BLOCKED` → `Must fix` issues exist; re-dispatch the implementer with the issue list. Repeat the three stages until `DONE` — subject to the same **hard cap of 3 implementer re-dispatches per task**; at the cap, record the task as failed and STOP.

   ### Post-task hook
   After Stage 3 passes for a task — or when a task hits the re-dispatch cap — record the result:
   ```bash
   node "<PLUGIN_ROOT>/scripts/gsd-post-task.cjs" <phase> <plan> <task-num> <status> <commit-hash>
   ```
   If the hook exits non-zero, do not advance to the next task; address the reported check failures within the existing retry cap. A **HARD STOP** (3 recorded failures) forbids another implementer dispatch: report to the user or create a fix plan.

5. After all plans complete, run `draht-tools verify-phase $1` yourself (not the subagent)
6. Run the post-phase hook to generate the phase report:
   ```bash
   node "<PLUGIN_ROOT>/scripts/gsd-post-phase.cjs" $1
   ```
7. Run `draht-tools update-state` yourself
8. If committing is authorized, final documentation commit: `draht-tools commit-docs "complete phase $1 execution"`
9. Identify `/verify-work $1` as the next step; a fresh session is optional

## Subagent Task Template (Stage 1: implementer)

```
Execute only task <task-name>. The full plan below is context; do not execute later tasks before the orchestrator completes this task's reviews:

<paste full plan XML here>

[Optional — orchestrator MAY paste a `draht-tools graph-context <task files>` slice here for orientation (pkg/layer/importers/imports/sinks). Subagents typically cannot run draht-tools themselves.]

For the assigned <task>, follow its test requirements and this TDD cycle where applicable. Commit the phases only when the user has authorized commits:
1. RED — Write failing tests from <test>. Run the test runner, confirm they FAIL for the right reason. Commit with: git add <test-files> && git commit -m "red: <description>"
2. GREEN — Write minimal implementation from <action> to make tests pass. Run tests, confirm PASS. Commit with: git add <files> && git commit -m "green: <task name>"
3. REFACTOR — Apply <refactor> improvements if any. Tests must stay green after each change. Commit with: git add <files> && git commit -m "refactor: <description>"
4. VERIFY — Run the <verify> step, confirm <done> criteria are met.

Use established project terms and documented boundaries; read relevant domain context when present.

Comments explain non-obvious constraints or rationale; avoid step narration and diff restatements.

Checkpoint handling:
- type="auto" → execute silently.
- type="checkpoint:human-verify" → stop and report back what was built.
- type="checkpoint:decision" → stop and report the options.

Evidence rule: report decisive commands, working directories, outcomes, and the code/configuration state checked. A bare success status is insufficient; missing or stale evidence must be verified. If a plan instruction contradicts what you find in the code, stop and report NEEDS_CONTEXT — do not silently obey either side.

End your response with `STATUS: DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED` per the agent contract.
```

## Parallelization Rules

- Plans sharing no files and having no dependency edges can run in parallel
- If plan B depends on output of plan A, plan B must wait for A to complete
- **Inside a plan, tasks run sequentially** — the three-stage review loop must complete before the next task starts (so each task gets clean review context)
- If a parallel subagent fails, report which plan failed and continue with independent plans

## Workflow

This is one step in the per-phase cycle:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N
```

After completing this command, identify `/verify-work $1` as the next step; a fresh session is optional. Do NOT suggest `/next-milestone`.

## Flags

- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
