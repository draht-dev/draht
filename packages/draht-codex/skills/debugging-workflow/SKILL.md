---
name: debugging-workflow
description: Four-phase systematic debugging — root cause investigation → pattern analysis → single-hypothesis testing → reproducing-test-first implementation. Use whenever investigating a bug, test failure, error, stack trace, regression, build break, or unexpected behaviour. Auto-triggers on phrases like "broken", "doesn't work", "failing", "error", "bug", "regression", "why is X", "what's wrong with". The same protocol that `/fix` enforces, available transversally.
---

# Debugging Workflow

Random fixes create new bugs. This skill enforces the four-phase systematic debugging protocol whenever Codex is investigating any technical failure — independent of whether the user invoked `/fix`.

## The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

A symptom fix is a failure. If you patch the visible error without understanding why it occurred, you've created the next bug.

## When to Apply

Any time you encounter:
- Failing tests
- Production errors
- Unexpected behaviour
- Performance regressions
- Build failures
- Integration issues
- "Why is X doing Y?"

**Especially** when under time pressure, when a "quick fix" seems obvious, after multiple failed attempts, or when you don't fully understand the issue.

## Phase 1 — Root Cause Investigation (before ANY fix)

1. **Read error messages carefully.** Don't skip past the trace — read line numbers and file paths. Stack traces often contain the exact answer.
2. **Reproduce consistently.** What are the exact steps? If you can't reproduce, gather more data — do not guess.
3. **Check recent changes.** `git log --oneline -20`, `git diff HEAD~N` on the affected paths. What was the last thing that touched this?
4. **Trace data flow.** Where does the bad value originate? What called the function with that value? Keep tracing **upward** until you find the source. Fix at source, not at the symptom site.
5. **State the root cause in one sentence:** "X happens because Y at <file:line>."

If you cannot state the root cause clearly, you do not understand the bug yet. Do not proceed.

## Phase 2 — Pattern Analysis

1. **Find working examples.** Other code in this repo that does the same kind of thing correctly.
2. **Read references completely.** Not skimmed — read every line of the working version.
3. **List every difference** between working and broken, however small.
4. **Note dependencies.** What config / env / call-order does the working version assume?

If Phase 2 contradicts Phase 1, go back to Phase 1. Don't paper over disagreement.

## Phase 3 — Single Hypothesis Test

1. State ONE hypothesis: "I think X is the root cause because Y."
2. Design the **smallest possible change** to test it — one variable, ideally one line.
3. Apply it. Did it fix the issue?
   - Yes → proceed to Phase 4.
   - No → form a NEW hypothesis. Revert. Do not pile changes on top.
4. **After 3 failed hypotheses, STOP.** This is an architectural problem, not a hypothesis problem. Discuss before continuing.

## Phase 4 — Implementation

1. **Write the reproducing test FIRST.** Confirm it FAILS for the right reason (not syntax, not missing import).
   - Commit: `red: reproduce <bug>`
2. **Apply the single fix** from Phase 3. No other changes.
   - Failing test now PASSES.
   - Full test suite — no regressions.
   - Commit: `green: fix <bug>`
3. **Refactor (optional)** — only if clear improvement. Tests stay green.
   - Commit: `refactor: <description>`
4. **Verify the original symptom is gone** — run the user-level reproduction, not just the unit test.

## Red Flags — STOP

Stop immediately if you catch yourself:
- "Quick fix for now, investigate later"
- Multiple changes simultaneously
- Skipping the reproducing test
- Proposing solutions before understanding data flow
- "One more attempt" after 2+ failures
- Each fix revealing new problems elsewhere
- Proposing solutions before you can state the root cause in one sentence

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "Simple bug, skip the process" | Simple bugs have root causes too. The process is fast for them. |
| "Emergency, no time for process" | Systematic debugging is *faster* than thrashing. |
| "I'll write the test after I confirm the fix" | Untested fixes don't stick. Test-first proves the bug existed. |
| "Let me try a few things" | Can't isolate what worked. Creates new bugs. |
| "I already manually tested it" | A reproducing test is the only durable proof. |
| "I can see what's wrong, I don't need Phase 1" | "See" is not "understand". Trace it. |

## Relationship to /fix

This skill is the *protocol*. `/fix` is the *command* that runs it with subagent delegation, commit conventions, and state updates. Use the skill transversally; use `/fix` when you want the full workflow with tracking.

## Relationship to verification-gate

After Phase 4, verification-gate kicks in: don't claim "bug fixed" without running the proving command and seeing the output.
