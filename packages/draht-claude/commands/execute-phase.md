---
description: Execute all plans in a phase with atomic commits (parallel implementer subagents + TDD cycle)
argument-hint: "<phase-number> [--gaps-only]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /execute-phase

Execute all plans in a phase with atomic commits, parallelizing independent plans via subagents.

Phase: $1
Arguments: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagent delegation, use the **Task tool** with `subagent_type: "implementer"`. Dispatch multiple parallel tasks in a single assistant turn by making multiple Task tool calls at once.

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
0. Run the pre-execute check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd-pre-execute.cjs" $1
   ```
   If it exits non-zero, STOP and report errors to the user. Do not proceed.

1. Run `draht-tools discover-plans $1` to find and order plans
2. Read each plan file yourself (from `.planning/phases/`) and analyze dependencies to identify which plans can run in parallel vs sequential

3. **Delegate execution to subagents via the Task tool:**
   - For **independent plans** (no shared files, no dependency chain): dispatch multiple `Task` tool calls in parallel (single assistant turn), each with `subagent_type: "implementer"`, one per plan.
   - For **dependent plans**: dispatch sequentially — one `Task` call at a time, waiting for the previous to complete before starting the next.
   - Each implementer prompt must include:
     - The full plan content (paste it inline — the subagent cannot run draht-tools)
     - The TDD cycle instructions (see template below)
     - Instructions to commit with `git add <files> && git commit -m "description"`

4. After all subagents complete, collect results and check for failures
5. For each completed task, run the post-task hook (record results + type check + test run):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd-post-task.cjs" <phase> <plan> <task-num> <status> <commit-hash>
   ```
6. Run `draht-tools verify-phase $1` yourself (not the subagent)
7. Run the post-phase hook to generate the phase report:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gsd-post-phase.cjs" $1
   ```
8. Run `draht-tools update-state` yourself
9. Final commit: `draht-tools commit-docs "complete phase $1 execution"`
10. Tell the user to start a fresh session (`/clear`) and run `/verify-work $1`

## Subagent Task Template

Each implementer Task call receives a prompt like:

```
Execute this plan. Here is the full plan content:

<paste full plan XML here>

For each <task> in the plan, follow this TDD cycle:
1. RED — Write failing tests from <test>. Run the test runner, confirm they FAIL. Commit with: git add <test-files> && git commit -m "red: <description>"
2. GREEN — Write minimal implementation from <action> to make tests pass. Run tests, confirm PASS. Commit with: git add <files> && git commit -m "green: <task name>"
3. REFACTOR — Apply <refactor> improvements if any. Tests must stay green after each change. Commit with: git add <files> && git commit -m "refactor: <description>"
4. VERIFY — Run the <verify> step, confirm <done> criteria are met.

Domain rules: Use ubiquitous language from .planning/DOMAIN.md (read it). Do not import across bounded context boundaries.

Checkpoint handling:
- type="auto" → execute silently.
- type="checkpoint:human-verify" → stop and report back what was built.
- type="checkpoint:decision" → stop and report the options.
```

## Parallelization Rules
- Plans sharing no files and having no dependency edges can run in parallel
- If plan B depends on output of plan A, plan B must wait for A to complete
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
