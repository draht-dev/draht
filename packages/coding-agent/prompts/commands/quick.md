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
