---
description: "Decompose a task and dispatch the right mix of specialist subagents"
argument-hint: "<task description>"
---

# /orchestrate

Decompose a task and dispatch the right mix of specialist subagents.

Task: $ARGUMENTS

> **Tool note**: Use the `subagent` tool. Set `agent` to one of: `architect`, `implementer`, `spec-reviewer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`. Use `tasks: [...]` for parallel dispatch and `chain: [...]` for sequential pipelines.

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
| Check that a diff covers exactly the spec — no more, no less | `spec-reviewer` |
| Review code quality (correctness, conventions, domain language) | `reviewer` |
| Find what's broken (root-cause diagnosis) | `debugger` |
| Audit for security issues | `security-auditor` |
| Run lint / typecheck / tests | `verifier` |
| Create atomic commits | `git-committer` |

`spec-reviewer` and `reviewer` are distinct on purpose. Spec-reviewer ONLY checks "did the diff implement what the spec asked, no more no less". Reviewer evaluates quality. For any task with a written spec, run spec-reviewer **before** reviewer.

## Orchestration Modes

### Parallel
Use the `subagent` tool with `tasks: [...]` when sub-tasks don't depend on each other. Example: review + security audit of the same change set.

### Chain
Use the `subagent` tool with `chain: [...]` when later work depends on earlier output. Earlier output is interpolated via `{previous}` in the next task. Example: architect produces plan → implementer executes plan → verifier runs tests → reviewer audits the diff.

### Fan-out / Fan-in
Architect decomposes into N independent plans → dispatch N implementers in parallel → collect all outputs → single verifier run → single reviewer audit. This is the standard pattern for `/execute-phase` work.

### Two-Stage Review (spec → quality)
For any task that has a written spec, follow implementer with **spec-reviewer first, then reviewer**:

```
implementer → spec-reviewer → reviewer
                   ↓ BLOCKED
              re-dispatch implementer with required fixes
```

Never run quality review on a spec-non-compliant diff. This is the per-task loop inside `/execute-phase`.

## Reading Subagent Status

Every draht agent ends its response with one of four status lines. Branch on it:

- `STATUS: DONE` — proceed to the next step in the chain.
- `STATUS: DONE_WITH_CONCERNS` — note the concerns. If correctness-related, address before moving on; otherwise log and continue.
- `STATUS: NEEDS_CONTEXT` — provide the missing info and re-dispatch the same agent. Do NOT skip ahead with a guess.
- `STATUS: BLOCKED` — STOP. Report the blocker. Do not retry the same agent on the same input — adjust inputs (more context, decompose further, different agent) or surface to the user.

## Steps
1. Read the task description and identify sub-tasks
2. Map each sub-task to the right agent from the table above
3. Decide parallel vs chain vs fan-out vs two-stage based on dependencies
4. Dispatch via the `subagent` tool accordingly
5. Read each subagent's final `STATUS:` line and branch per the protocol above
6. Collect results, handle failures, report the final outcome to the user

## Rules
- Prefer parallel dispatch when possible — it's faster and each subagent has its own context
- Pass complete context to subagents — they cannot see the main conversation
- Do not nest delegations deeply — one level is usually enough
- Never retry the same agent on the same input after `BLOCKED` — change something
- For any spec-driven work, spec-reviewer runs before quality reviewer
