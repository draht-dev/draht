---
description: Execute a small ad-hoc task with tracking (implementer subagent + TDD cycle)
argument-hint: "<description>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /quick

Execute a small ad-hoc task with tracking.

Task: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "implementer"`.

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

3. **Delegate execution via the Task tool** with `subagent_type: "implementer"` and prompt:
   "Execute this task: $ARGUMENTS

   Follow the TDD cycle:
   - RED — Write a failing test that describes the desired behaviour
   - GREEN — Write the minimum implementation to make it pass
   - REFACTOR — Clean up while keeping the test green

   Exception: skip the TDD cycle only for pure config or documentation-only tasks that have no testable behaviour.

   After completion, report: files changed, tests written, and verification results."

4. Write summary: `draht-tools write-quick-summary NNN`
5. Update state: `draht-tools update-state`
