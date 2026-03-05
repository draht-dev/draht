---
description: "Diagnose and fix a bug with TDD discipline"
---

# /fix

Diagnose and fix a specific bug or failing task with TDD discipline.

## Usage
```
/fix [description of what's broken]
```

Issue: $ARGUMENTS

## Steps
1. **Diagnose**: Read the relevant code and error output to identify the root cause
   - If a test is failing, run it first to see the actual error
   - If a runtime bug, reproduce it and capture the error
2. **Write a reproducing test**: Before touching any implementation:
   - Write a test that demonstrates the bug (it must fail)
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
