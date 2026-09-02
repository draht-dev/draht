---
description: "Decompose a task and dispatch the right mix of specialist subagents"
argument-hint: "<task description>"
---

# /orchestrate

Decompose a task and dispatch the right mix of specialist subagents.

Task: $ARGUMENTS

> **Tool note**: Use the `subagent` tool. Set `agent` to one of: `architect`, `implementer`, `spec-reviewer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`, `advisor`. Use `tasks: [...]` for parallel dispatch and `chain: [...]` for sequential pipelines.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

1. **State the logical components** — What sub-tasks make up this work? Which are independent? A sub-task is well-cut only if its success can be checked without reference to the others.
2. **Match agents to work** — Which specialist is right for each sub-task?
3. **Determine order** — What can run in parallel vs what must be sequential? Among independent sub-tasks, dispatch the riskiest first (highest uncertainty × blast radius): its failure invalidates the rest of the graph most cheaply, before effort is sunk into work it would obsolete.
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
| Strategic steer at a decision point — rare, high-leverage | `advisor` |

`spec-reviewer` and `reviewer` are distinct on purpose. Spec-reviewer ONLY checks "did the diff implement what the spec asked, no more no less". Reviewer evaluates quality. For any task with a written spec, run spec-reviewer **before** reviewer.

## Effort Scaling

Match orchestration weight to the task — over-orchestration burns tokens without adding verification value:

| Task shape | Dispatch |
|---|---|
| Single question or trivial fix | One agent, or handle it directly — no orchestration |
| One change set to evaluate | 2–4 parallel evaluators (reviewer, security-auditor, verifier) |
| Multi-part feature with known decomposition | Fan-out / fan-in |
| Goal needing iteration until a measurable criterion holds | `/orchestrate-loop` |

## Model Tiering

Bill volume tokens at the cheaper rate:

- **Orchestrator pattern** — run this command on the strongest tier (e.g. Claude Fable 5) and let workers execute on the executor tier (e.g. Claude Sonnet 5): planning quality where it matters, volume tokens at worker rates.
- **Advisor pattern** — when the session runs on the executor tier, dispatch `advisor` sparingly: once after orientation before committing to an approach, again when stuck or before declaring a hard task done. ~1–3 consults per task; treat its guidance with serious weight.

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

### Loop (iterate until a check passes)
When the work cannot land in one dispatch but success is provable by a deterministic check, do not improvise retries here — hand off to `/orchestrate-loop`. It runs fresh worker iterations gated by an independent re-run of the check, with max-iteration and stall bounds.

## Reading Subagent Status

Every draht agent ends its response with one of four status lines. Branch on it:

- `STATUS: DONE` — check the evidence before proceeding: a `DONE` that quotes no verification output (test counts, command results) is treated as `DONE_WITH_CONCERNS` — re-run the decisive check yourself. Subagent claims are inputs, not verdicts.
- `STATUS: DONE_WITH_CONCERNS` — note the concerns. If correctness-related, address before moving on; otherwise log and continue.
- `STATUS: NEEDS_CONTEXT` — provide the missing info and re-dispatch the same agent. Do NOT skip ahead with a guess.
- `STATUS: BLOCKED` — STOP. Report the blocker. Do not retry the same agent on the same input — adjust inputs (more context, decompose further, different agent) or surface to the user.

## Steps
1. Read the task description and identify sub-tasks
2. Map each sub-task to the right agent from the table above
3. Decide parallel vs chain vs fan-out vs two-stage based on dependencies
4. Dispatch via the `subagent` tool accordingly
5. Read each subagent's final `STATUS:` line and branch per the protocol above
6. Collect results, handle failures, report to the user — outcome first (what happened, in one line), evidence second (what each agent verified, quoted), risk last (what remains unverified or assumed)

## Rules
- Prefer parallel dispatch when possible — it's faster and each subagent has its own context
- Every dispatch is a complete brief: objective, expected output format, tool guidance, and task boundaries — subagents cannot see the main conversation
- Do not nest delegations deeply — one level is usually enough
- Never retry the same agent on the same input after `BLOCKED` — change something
- For any spec-driven work, spec-reviewer runs before quality reviewer
- The agent that produced work never evaluates it — completion verdicts come from a fresh-context evaluator plus your own re-run of the decisive check
