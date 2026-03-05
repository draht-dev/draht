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
2. Analyze plan dependencies to identify which plans can run in parallel vs which must be sequential
3. **Delegate execution to subagents:**
   - For independent plans (no shared files, no dependency chain): use the `subagent` tool in **parallel mode** with `implementer` agents, one per plan. Each task should include the full plan content and the TDD instructions below.
   - For dependent plans: execute them sequentially, each via a **single** `subagent` call to `implementer`, waiting for the previous to complete before starting the next.
   - Each subagent task must include:
     - The plan content (from `draht-tools read-plan $1 P`)
     - The TDD cycle instructions (red/green/refactor)
     - The commit command: `draht-tools commit-task $1 P T "description"`
     - The summary command: `draht-tools write-summary $1 P`

4. After all plans complete, collect results and check for failures
5. Phase verification: `draht-tools verify-phase $1`
6. Update state: `draht-tools update-state`
7. Final commit: `draht-tools commit-docs "complete phase $1 execution"`

## Subagent Task Template

Each implementer subagent receives a task like:

```
Execute this plan for phase N, plan P.

Plan content:
<paste plan content here>

TDD Cycle for each task:
1. RED — Write failing tests from <test>. Run tests, confirm FAIL. Commit: draht-tools commit-task N P T "red: description"
2. GREEN — Minimal implementation from <action>. Run tests, confirm PASS. Commit: draht-tools commit-task N P T "green: task name"
3. REFACTOR — Apply <refactor> improvements. Tests must stay green. Commit: draht-tools commit-task N P T "refactor: description"
4. VERIFY — Run <verify>, confirm <done> criteria met.

After all tasks: draht-tools write-summary N P

Domain rules: Use ubiquitous language from .planning/DOMAIN.md. Do not import across bounded context boundaries.
Checkpoint handling: type="auto" → execute silently. type="checkpoint:human-verify" → stop and report back. type="checkpoint:decision" → stop and report options.
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
