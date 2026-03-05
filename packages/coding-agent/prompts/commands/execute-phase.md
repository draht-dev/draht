---
description: "Execute all plans in a phase with atomic commits"
---

# /execute-phase

Execute all plans in a phase with atomic commits, parallelizing independent plans via subagents.

## Usage
```
/execute-phase [N] [--gaps-only]
```

Phase: $1
Arguments: $ARGUMENTS

## Steps
1. Run `draht-tools discover-plans $1` to find and order plans
2. Read each plan file yourself (from `.planning/phases/`) and analyze dependencies to identify which plans can run in parallel vs sequential
3. **Delegate execution to subagents:**
   - For independent plans (no shared files, no dependency chain): use the `subagent` tool in **parallel mode** with `implementer` agents, one per plan.
   - For dependent plans: execute them sequentially, each via a **single** `subagent` call to `implementer`, waiting for the previous to complete before starting the next.
   - Each subagent task must include:
     - The full plan content (paste it into the task — the subagent cannot run draht-tools)
     - The TDD cycle instructions (see template below)
     - Instructions to commit with `git add <files> && git commit -m "description"`

4. After all subagents complete, collect results and check for failures
5. Run `draht-tools verify-phase $1` yourself (not the subagent)
6. Run `draht-tools update-state` yourself
7. Final commit: `draht-tools commit-docs "complete phase $1 execution"`

## Subagent Task Template

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

Important: Do NOT run draht, draht-tools, draht help, or pi commands. Use only standard tools (read, bash, edit, write, grep, find, ls).
```

## Parallelization Rules
- Plans sharing no files and having no dependency edges can run in parallel
- If plan B depends on output of plan A, plan B must wait for A to complete
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

## Flags
- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
