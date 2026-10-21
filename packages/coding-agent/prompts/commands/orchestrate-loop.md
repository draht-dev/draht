---
description: "Run a verification-gated loop of fresh subagent iterations until a deterministic check passes"
argument-hint: "<goal with a measurable success criterion> [--max-iterations N]"
---

# /orchestrate-loop

Run fresh-context worker iterations against a fixed goal until an independent check passes — or a hard stop fires. The loop closes on a deterministic check, never on an agent's claim of completion.

Goal: $ARGUMENTS

> **Tool note**: Use the `subagent` tool. Workers are `implementer` (or `debugger` for pure-diagnosis goals); use `spec-reviewer` for acceptance criteria the check cannot establish. One worker per iteration — never parallel workers inside the loop.

## When to Loop vs Orchestrate

| Situation | Command |
|---|---|
| Decomposition is known, sub-tasks dispatch once | `/orchestrate` |
| Phase plans exist in `.planning/phases/` | `/execute-phase` |
| Goal needs iteration until a measurable criterion holds | `/orchestrate-loop` |

Loops trade tokens for persistence: use one when the work is too large or too uncertain for a single pass AND success is checkable without human judgment.

## The Loop Contract — no check, no loop

A loop is only as good as its check. Before iterating, establish all four:

1. **GOAL** — one measurable end state, stated in one sentence.
2. **CHECK** — a command that proves the goal, pass/fail by exit code (test suite, typecheck + lint, a script comparing against a known-good oracle). Prefer terse output: failures only.
3. **STOP CONDITIONS** — check passes (verified independently), max iterations reached (default 10; `--max-iterations N` overrides), stall detected, or `STATUS: BLOCKED`.
4. **CONSTRAINTS** — what no iteration may touch: existing tests and the check itself are immutable (weakening either to "make it pass" is a hard-stop violation), plus anything out of scope.

If no deterministic check can be derived from the goal, STOP and ask the user to define one (or fall back to `/orchestrate`). Never start a loop whose only stop signal is "looks done" — without a check, you become the verification loop and it never closes.

Write the contract to `.planning/loop/LOOP.md`:

```markdown
# Loop: <slug>
Started: <date> | Max iterations: <N>

## Goal
<one sentence>

## Check
`<command>` — passes when <what the output proves>

## Constraints
- <immutables and out-of-scope items>
```

Create `.planning/loop/PROGRESS.md` alongside it (append-only iteration log).

## Iteration Protocol

Each iteration dispatches ONE fresh worker whose prompt contains, in full (workers cannot see this conversation):

1. The loop contract verbatim
2. The last 3 entries of `PROGRESS.md` and the last 5 `git log --oneline` lines — the recoverable state
3. The previous iteration's failure evidence, terse: the failing assertions or error lines, not full output
4. Standing orders:
   - **Orient** — read the progress log and current check evidence; rerun if the evidence is missing or its inputs changed
   - **One increment** — the smallest change that moves the check toward passing; do not batch
   - **Preserve the increment** in the working tree and progress log; commit only when authorized
   - **Append one `PROGRESS.md` entry** — what changed / check result observed / suggested next step
   - Never edit or delete tests or the check to make it pass; never claim completion without quoting check output

## Independent Verification — the gate

After each iteration, inspect the CHECK’s exit status, output, and input state. Reuse auditable successful evidence when the inputs are unchanged; otherwise run the CHECK. A worker’s unsupported completion claim is insufficient.

- **Check passes** → compare the full diff with the contract. Use `spec-reviewer` when semantic acceptance criteria remain outside the check. Required findings trigger a targeted iteration within the existing cap.
- **Check fails** → extract the terse failure evidence and feed it into the next iteration's prompt as guidance.

## Stall Detection

Stop early when the loop is running but not progressing:

- Two consecutive iterations with the identical failure signature, or
- An iteration that produced no relevant change or new diagnostic evidence

On stall, do not dispatch the same input again — change something: decompose the goal, add context the workers were missing, switch worker (`implementer` → `debugger`), consult `advisor` for a course correction, or surface to the user with the evidence so far.

## Steps

1. Parse `$ARGUMENTS` into GOAL and flags; derive the CHECK; refuse to loop without one
2. Write `.planning/loop/LOOP.md` and `.planning/loop/PROGRESS.md`
3. Iterate: dispatch worker → validate current CHECK evidence → branch (pass → gate, fail → next iteration, stall / max / BLOCKED → hard stop)
4. On success: resolve any required spec review, then report — outcome first, check output quoted, iterations used
5. On any hard stop: append a handoff entry to `PROGRESS.md` (state observed, failure evidence, recommended next step) and report with observed / derived / assumed labels
6. Leave `.planning/loop/` in place as the loop's record

## Rules

- One worker and one verifiable increment per iteration; commits require authorization
- Choose available worker models that meet the task’s checks; change tiers only when evidence supports the tradeoff
- Completion requires current passing check evidence and any required review; an agent’s confidence is not a check
- Never raise max iterations mid-loop without asking the user
- Tests and the check are immutable inside the loop; tampering means stop and report the affected changes; do not discard unrelated work
- Evidence discipline applies to the loop verdict: label results observed / derived / assumed
