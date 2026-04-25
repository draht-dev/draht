---
description: "Decompose a task and dispatch the right mix of specialist subagents"
argument-hint: "<task description>"
---

# /orchestrate

Decompose a task and dispatch the right mix of specialist subagents.

Task: $ARGUMENTS

> **Tool note**: Use the `subagent` tool. Set `agent` to one of: `architect`, `implementer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`. Use `tasks: [...]` for parallel dispatch and `chain: [...]` for sequential pipelines.

## Atomic Reasoning

Before delegating, decompose the task into atomic work units:

1. **State the logical components** — What sub-tasks make up this work? Which are independent?
2. **Match agents to work** — Which specialist is right for each sub-task?
3. **Determine order** — What can run in parallel vs what must be sequential?
4. **Define success** — What does "done" look like for each sub-task, and for the whole?

## Agent Selection Guide

| Need | Agent |
|---|---|
| Plan structure before coding | `architect` |
| Write or change code | `implementer` |
| Find what's broken | `debugger` |
| Review for correctness / conventions / domain | `reviewer` |
| Audit for security issues | `security-auditor` |
| Run lint / typecheck / tests | `verifier` |
| Create atomic commits | `git-committer` |

## Orchestration Modes

### Parallel
Use the `subagent` tool with `tasks: [...]` when sub-tasks don't depend on each other. Example: review + security audit of the same change set.

### Chain
Use the `subagent` tool with `chain: [...]` when later work depends on earlier output. Earlier output is interpolated via `{previous}` in the next task. Example: architect produces plan → implementer executes plan → verifier runs tests → reviewer audits the diff.

### Fan-out / Fan-in
Architect decomposes into N independent plans → dispatch N implementers in parallel → collect all outputs → single verifier run → single reviewer audit. This is the standard pattern for `/execute-phase` work.

## Steps
1. Read the task description and identify sub-tasks
2. Map each sub-task to the right agent from the table above
3. Decide parallel vs chain vs fan-out based on dependencies
4. Dispatch via the `subagent` tool accordingly
5. Collect results, handle failures, report the final outcome to the user

## Rules
- Prefer parallel dispatch when possible — it's faster and each subagent has its own context
- Pass complete context to subagents — they cannot see the main conversation
- Do not nest delegations deeply — one level is usually enough
- If a subagent fails, report the failure and suggest next steps rather than retrying blindly
