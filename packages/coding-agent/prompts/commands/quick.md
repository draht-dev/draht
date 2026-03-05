---
description: "Execute a small ad-hoc task with tracking"
---

# /quick

Execute a small ad-hoc task with tracking.

## Usage
```
/quick [description]
```

Task: $ARGUMENTS

## Steps
1. Run `draht-tools next-quick-number` to get task number
2. Create quick plan: `draht-tools create-quick-plan NNN "$ARGUMENTS"`
3. **Delegate execution to subagent**: Use the `subagent` tool in **single mode** with the `implementer` agent:
   "Execute this task: $ARGUMENTS

   Follow the TDD cycle:
   - RED — Write a failing test that describes the desired behaviour
   - GREEN — Write the minimum implementation to make it pass
   - REFACTOR — Clean up while keeping the test green
   Exception: skip the TDD cycle only for pure config or documentation-only tasks that have no testable behaviour.

   After completion, report: files changed, tests written, and verification results.
   Do NOT run draht, draht-tools, draht help, or pi commands — use only standard tools."

4. Write summary: `draht-tools write-quick-summary NNN`
5. Update state: `draht-tools update-state`
