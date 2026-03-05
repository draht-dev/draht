---
description: "Execute all plans in a phase with atomic commits"
---

# /execute-phase

Execute all plans in a phase with atomic commits.

## Usage
```
/execute-phase [N] [--gaps-only]
```

Phase: $1
Arguments: $ARGUMENTS

## Steps
1. Run `draht-tools discover-plans $1` to find and order plans
2. For each plan in dependency order:
   a. Load plan: `draht-tools read-plan $1 P`
   b. Execute each task in strict TDD cycle:

      **🔴 RED — Write failing tests first**
      - Write the test cases from `<test>`
      - Run tests — confirm they FAIL (if they pass, the test is wrong)
      - Commit failing tests: `draht-tools commit-task $1 P T "red: test description"`

      **🟢 GREEN — Minimal implementation**
      - Write the minimum code from `<action>` to make tests pass
      - Use domain language from `<context>` and `<domain>` for all names
      - Run tests — confirm they PASS
      - Commit: `draht-tools commit-task $1 P T "green: task name"`

      **🔵 REFACTOR — Clean up with safety net**
      - Apply improvements from `<refactor>` (if any)
      - Run tests after each change — must stay green
      - Verify domain language compliance (names match DOMAIN.md)
      - Commit: `draht-tools commit-task $1 P T "refactor: description"`

      **✅ VERIFY**
      - Run the `<verify>` step
      - Confirm `<done>` criteria met

   c. Write summary: `draht-tools write-summary $1 P`
3. Phase verification: `draht-tools verify-phase $1`
4. Update state: `draht-tools update-state`
5. Final commit: `draht-tools commit-docs "complete phase $1 execution"`

## TDD Rules
- Never write implementation before a failing test exists
- If a test passes immediately after being written, it is not testing the right thing — fix it
- Red → Green → Refactor is not optional; skipping steps invalidates the safety net
- Each TDD phase gets its own commit so the history is auditable

## Domain Rules
- All identifiers (class names, method names, variables) must use the ubiquitous language from `.planning/DOMAIN.md`
- Do not import across bounded context boundaries directly — use domain events or ACL adapters
- If implementation reveals a missing domain term, stop and update DOMAIN.md before continuing

## Checkpoint Handling
- `type="auto"` → execute without pausing
- `type="checkpoint:human-verify"` → pause, show user, wait for confirmation
- `type="checkpoint:decision"` → pause, present options, wait for choice

## Flags
- `--gaps-only` → only execute FIX-PLAN.md files from failed verification
