---
description: Decompose a task and orchestrate multiple specialist subagents in parallel and chain modes
argument-hint: "<task description>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /orchestrate

Decompose a task and dispatch the right mix of specialist subagents.

Task: $ARGUMENTS

> **Tool note**: Dispatch subagents using the matching Draht agent role: `architect`, `implementer`, `spec-reviewer`, `reviewer`, `debugger`, `verifier`, `git-committer`, `security-auditor`, `advisor`. Dispatch multiple tasks in the same assistant turn for parallel execution.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

1. **State the logical components** — What sub-tasks make up this work? Which are independent? A sub-task is well-cut only if its success can be checked without reference to the others.
2. **Match agents to work** — Which specialist is right for each sub-task?
3. **Determine order** — What can run in parallel vs what must be sequential? For **code-touching** sub-tasks (skip for doc-only work), run `draht-tools graph-impact <files>` on each sub-task's targets: disjoint impact sets parallelize, overlapping ones sequence. The orchestrator runs it and pastes the summary into each subagent's prompt. Among independent sub-tasks, dispatch the riskiest first (highest uncertainty × blast radius): its failure invalidates the rest of the graph most cheaply, before effort is sunk into work it would obsolete.
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

`spec-reviewer` and `reviewer` are distinct on purpose. Spec-reviewer ONLY checks "did the diff implement what the spec asked, no more no less". Reviewer evaluates quality (naming, structure, type safety). When both reviews are required, run spec-reviewer before reviewer. Select reviews for the task’s risk and acceptance criteria.

## Effort Scaling

Match orchestration weight to the task — over-orchestration burns tokens without adding verification value:

| Task shape | Dispatch |
|---|---|
| Single question or trivial fix | One agent, or handle it directly — no orchestration |
| One change set to evaluate | Only the reviewers needed to resolve material risks or acceptance gaps |
| Multi-part feature with known decomposition | Fan-out / fan-in |
| Goal needing iteration until a measurable criterion holds | `/orchestrate-loop` |

## Model Tiering

Choose available models from the current provider catalog and measure quality, latency, and cost on the workload — see the `model-tiering` skill:

- **Orchestrator pattern** — use a capable model for decomposition and assign bounded worker tasks to models that pass the relevant checks. Keep the same model when a cheaper or faster worker has not demonstrated acceptable results.
- **Advisor pattern** — consult `advisor` when a concrete unresolved decision benefits from another model. Provide the question and evidence; no fixed consultation count is required.

## Orchestration Modes

### Parallel
Dispatch several subagent calls in a single assistant turn when the sub-tasks don't depend on each other. Example: review + security audit of the same change set.

### Chain
Dispatch subagent calls sequentially when later work depends on earlier output. Example: architect produces plan → implementer executes plan → verifier runs tests → reviewer audits the diff.

### Fan-out / Fan-in
Architect decomposes independent work → dispatch implementers in parallel → collect results for verification and review. When both reviews are selected, spec review precedes quality review; `/execute-phase` keeps its explicit per-task sequence.

### Two-Stage Review (spec → quality)
When the requested workflow needs separate spec and quality review, use this order:

```
implementer → spec-reviewer → reviewer
                   ↓ BLOCKED
              re-dispatch implementer with required fixes
```

Never run quality review on a spec-non-compliant diff. This is the standard pattern inside `/execute-phase`'s per-task loop.

### Loop (iterate until a check passes)
When the work cannot land in one dispatch but success is provable by a deterministic check, do not improvise retries here — hand off to `/orchestrate-loop`. It runs fresh worker iterations gated by an independent re-run of the check, with max-iteration and stall bounds. See the `loop-workflow` skill for the discipline.

## Reading Subagent Status

Require each dispatched agent to end its response with exactly one of these status lines, then branch on it:

- `STATUS: DONE` — check the evidence before proceeding: a `DONE` that quotes no verification output (test counts, command results) is treated as `DONE_WITH_CONCERNS` — re-run the decisive check yourself. Subagent claims are inputs, not verdicts.
- `STATUS: DONE_WITH_CONCERNS` — note the concerns. If they're correctness-related, address before moving on; otherwise log and continue.
- `STATUS: NEEDS_CONTEXT` — provide the missing information and re-dispatch the same agent. Do NOT skip ahead with a guess.
- `STATUS: BLOCKED` from a review agent (`spec-reviewer`, `reviewer`, or `security-auditor`) — send actionable required fixes to the implementer, then repeat the required reviews. Allow at most 3 implementer re-dispatches per task across review stages, or the active workflow's stricter cap. At the cap, stop and report the unresolved findings.
- `STATUS: BLOCKED` from an implementer or another non-review agent — stop and report the blocker to the user. Do not retry unchanged inputs.

## Steps
1. Read the task description and identify sub-tasks
2. Map each sub-task to the right agent from the table above
3. Decide parallel vs chain vs fan-out vs two-stage based on dependencies
4. Dispatch subagent calls accordingly
5. Read each subagent's final `STATUS:` line and branch per the protocol above
6. Collect results, handle failures, report to the user — outcome first (what happened, in one line), evidence second (what each agent verified, quoted), risk last (what remains unverified or assumed)

## Rules
- Prefer parallel dispatch when possible — it's faster and each subagent has its own context
- Every dispatch is a complete brief: objective, expected output format, tool guidance, and task boundaries — subagents cannot see the main conversation
- Do not nest delegations deeply — one level is usually enough
- Never retry the same agent on the same input after `BLOCKED` — change something
- If both spec and quality review are required, spec-reviewer runs first
- Use a fresh reviewer for unresolved semantic risks. Reuse auditable check results for unchanged inputs; rerun when state changed or evidence cannot be verified. Required failed checks block completion.
