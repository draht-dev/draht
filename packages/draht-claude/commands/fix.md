---
description: Diagnose and fix a bug with TDD discipline (debugger subagent → reproducing test → minimal fix)
argument-hint: "<description of what's broken>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /fix

Diagnose and fix a specific bug or failing task with TDD discipline, using a subagent for diagnosis.

Issue: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type: "debugger"` or `"implementer"`.

## Atomic Reasoning

Before diagnosing, decompose this bug into atomic reasoning units:

1. **State the logical component** — What is the observed failure? What should happen vs what actually happens?
2. **Validate independence** — Which components/files are involved? Can we isolate the failure? Are there related bugs that should be fixed separately?
3. **Verify correctness** — What test will reproduce this bug reliably? What would prove it's fixed? What regressions could the fix introduce?

**Synthesize fix strategy:**
- Trace the failure to root cause
- Write a minimal reproducing test
- Identify the smallest change that makes the test pass
- Plan regression checks

## Steps
1. **Diagnose via Task tool** with `subagent_type: "debugger"` and prompt:
   "Diagnose this issue: $ARGUMENTS. Reproduce the bug by running the relevant test or command. Trace the root cause by reading the code. Identify the exact files and lines involved. Do NOT fix it yet — only report the diagnosis with: root cause, affected files, and a recommended fix approach."

2. **Write a reproducing test**: Based on the diagnosis, write a test that demonstrates the bug (it must fail)
   - Commit: `git add <test-files> && git commit -m "red: reproduce <bug description>"`

3. **Minimal fix**: Write the smallest change that makes the test pass
   - Do not refactor or add features — just fix the bug
   - Run the full test suite to check for regressions
   - Commit: `git add <files> && git commit -m "green: fix <bug description>"`

4. **Refactor** (if needed): Clean up without changing behavior
   - Tests must stay green after every change
   - Commit: `git add <files> && git commit -m "refactor: <description>"`

5. **Update state**: `draht-tools update-state`

## Rules
- Always reproduce before fixing — a fix without a test is a guess
- One bug, one fix, one commit series. Do not bundle unrelated changes.
- If the root cause spans multiple files, explain the chain in the commit message body
