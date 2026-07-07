---
description: "Diagnose and fix a bug with a 4-phase systematic debugging protocol + TDD discipline"
---

# /fix

Diagnose and fix a bug using the **four-phase systematic debugging protocol**: root cause investigation → pattern analysis → hypothesis & testing → implementation with a reproducing test.

## Usage
```
/fix [description of what's broken]
```

Issue: $ARGUMENTS

## The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Symptom fixes are failure. If you find yourself proposing a "quick fix for now, investigate later", STOP and return to Phase 1.

## The Report Is a Symptom, Not a Diagnosis

**Procedure:** Restate the failure as observable behavior — "X happens when Y; expected Z" — before touching anything. If the user names a cause ("the cache is stale"), treat it as Hypothesis #0: it enters Phase 3 like any other hypothesis and does not skip Phase 1.

**Example:** "fix the stale cache bug" — Phase 1 traces the data flow and finds the cache is fine; the query behind it silently drops a filter. The fix lands in the query.

**Prevents:** shipping a correct fix to the wrong component.

## Red Flags — STOP

Stop immediately if you catch yourself:
- Proposing "quick fixes for now, investigate later"
- Attempting multiple changes simultaneously
- Skipping a reproducing test before fixing
- Proposing solutions before understanding data flow
- Making "one more fix attempt" after already trying 2+
- Watching each fix reveal new problems elsewhere

After **3 failed fix attempts**, STOP. This is an architectural problem, not a hypothesis problem. Report back to the user — do not try a 4th fix.

## Atomic Reasoning

1. **State the logical component** — What is the observed failure? What should happen vs what actually happens?
2. **Validate independence** — Which components/files are involved? Can we isolate the failure? Are there related bugs that should be fixed separately?
3. **Verify correctness** — What test will reproduce this bug reliably? What would prove it's fixed? What regressions could the fix introduce?

## The Four Phases

### Phase 1 — Root Cause Investigation (before ANY fix)

Use the `subagent` tool in **single mode** with the `debugger` agent. Prompt:

```
Investigate this issue using Phase 1 root-cause discipline. Do NOT fix anything — only diagnose.

Issue: $ARGUMENTS

Walk through these steps and report on each:
1. Read the error message / stack trace carefully — exact line numbers, exact file paths.
2. Reproduce consistently — exact steps. If you cannot reproduce, gather more data instead of guessing.
3. Check recent changes — `git log --oneline -20` and `git diff HEAD~5` against affected files.
4. Trace data flow upward until you find the source. Fix at source, not at symptom.
5. State the root cause as one sentence: "X happens because Y at <file:line>."
6. Label every statement in your report: observed (you ran it and saw it), derived (follows necessarily from evidence), or assumed (unchecked — say what would check it). A root cause resting on an assumption is a hypothesis, not a diagnosis.

End your response with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
Do NOT run draht, draht-tools, or pi commands.
```

If `BLOCKED` or `NEEDS_CONTEXT`: provide the missing info and re-dispatch.

### Phase 2 — Pattern Analysis

1. Find working examples in the codebase that do the same kind of thing correctly
2. Read those references completely — not skimmed
3. List every difference between the working code and the broken code
4. Note dependencies the working version assumes

If Phase 2 reveals a different root cause, go back to Phase 1.

### Phase 3 — Single Hypothesis Test

1. State ONE hypothesis: "I think the root cause is X because Y."
2. Apply the smallest possible change to test it — one variable.
3. Did it fix the issue?
   - Yes → proceed to Phase 4.
   - No → form a NEW hypothesis. Revert the test change. Do not pile changes.
4. After 3 hypotheses still failing: STOP. Question architecture, not hypothesis. Report to user.

### Phase 4 — Implementation

1. **Write the reproducing test FIRST.** Confirm it FAILS for the right reason.
   - Commit: `draht-tools commit-docs "red: reproduce <bug>"`

2. **Apply the single fix** from Phase 3. No other changes.
   - Failing test now PASSES.
   - Full test suite — no regressions.
   - Commit: `draht-tools commit-docs "green: fix <bug>"`

3. **Refactor (optional)** — only if clear improvement, no behaviour change. Tests stay green.
   - Commit: `draht-tools commit-docs "refactor: <description>"`

4. **Verify the original symptom is gone** — run the user-level reproduction.

5. **Update state**: `draht-tools update-state`

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "Simple bug, skip the process" | Simple bugs have root causes too. The process is fast. |
| "It's an emergency, no time" | Systematic debugging is *faster* than thrashing. |
| "I'll write the test after I confirm the fix" | Untested fixes don't stick. |
| "I'll just try things and see what works" | Can't isolate what worked. Creates new bugs. |
| "I already manually tested it" | A reproducing test is the only durable proof. |
| "The user already told me the cause" | The reporter saw the symptom. Their diagnosis is Hypothesis #0, not a finding. |
| "The fix passed, so my diagnosis was right" | Fixes can mask. Verify the causal chain, not just the symptom's absence. |

## Rules
- Always reproduce before fixing
- One bug, one fix, one commit series
- Fix at source, not symptom
- 3 failed attempts ⇒ architecture problem, stop and discuss
- If the root cause spans multiple files, explain the chain in the commit message
- Final report order: verdict first (fixed / not fixed, root cause in one sentence), then evidence (reproducing test red→green, suite results), then risk (what the fix could regress, what stays assumed)
