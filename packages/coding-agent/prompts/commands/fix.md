---
description: "Diagnose and fix a bug with TDD discipline"
---

# /fix

Diagnose and fix a specific bug or failing task with TDD discipline, using a subagent for diagnosis.

## Usage
```
/fix [description of what's broken]
```

Issue: $ARGUMENTS

## Steps
1. **Diagnose via subagent**: Use the `subagent` tool in **single mode** with the `debugger` agent:
   "Diagnose this issue: $ARGUMENTS. Reproduce the bug, trace the root cause, identify the exact files and lines involved. Do NOT fix it yet — only report the diagnosis with: root cause, affected files, and a recommended fix approach."

2. **Write a reproducing test**: Based on the diagnosis, write a test that demonstrates the bug (it must fail)
   - Commit: `draht-tools commit-docs "red: reproduce bug"`

3. **Minimal fix**: Write the smallest change that makes the test pass
   - Do not refactor or add features — just fix the bug
   - Run the full test suite to check for regressions
   - Commit: `draht-tools commit-docs "green: fix description"`

4. **Refactor** (if needed): Clean up without changing behavior
   - Tests must stay green after every change
   - Commit: `draht-tools commit-docs "refactor: description"`

5. **Update state**: `draht-tools update-state`

## Rules
- Always reproduce before fixing — a fix without a test is a guess
- One bug, one fix, one commit. Do not bundle unrelated changes.
- If the root cause spans multiple files, explain the chain in the commit message
