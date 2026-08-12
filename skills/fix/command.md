---
description: Diagnose and fix a bug using a 4-phase systematic debugging protocol with TDD discipline
argument-hint: "<description of what's broken>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /fix

Diagnose and fix a bug using the **four-phase systematic debugging protocol**: root cause investigation → pattern analysis → hypothesis & testing → implementation with a reproducing test.

Issue: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch the `debugger` or `implementer` role.

## The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Symptom fixes are failure — they create new bugs in different places. If you find yourself proposing a "quick fix for now, investigate later", STOP and return to Phase 1.

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
- Implementing before a failing test exists for the bug

When you've tried **3 fix attempts and still failing**, STOP. This is a **hard cap**, not advice — an architectural problem, not a hypothesis problem. Report back to the user — do not try a 4th fix. Before reporting, append one line to `.planning/STATE.md` under `## Lessons`: what was tried, why it failed, dated — so the next session doesn't repeat the same three attempts.

## Atomic Reasoning

Before diagnosing, decompose this bug into atomic reasoning units:

1. **State the logical component** — What is the observed failure? What should happen vs what actually happens?
2. **Validate independence** — Which components/files are involved? Can we isolate the failure? Are there related bugs that should be fixed separately?
3. **Verify correctness** — What test will reproduce this bug reliably? What would prove it's fixed? What regressions could the fix introduce?

## The Four Phases

### Phase 1 — Root Cause Investigation (before ANY fix)

Once the affected/buggy file is identified, run `draht-tools graph-context <buggy-file>` and `draht-tools graph-callers <buggy-file>` to orient (package, layer, who calls it) — paste the summary into the `debugger` subagent's prompt to support its "trace UPWARD" step.

Dispatch the `debugger` subagent with this prompt:

```
Investigate this issue using Phase 1 root-cause discipline. Do NOT fix anything — only diagnose.

Issue: $ARGUMENTS

Walk through these steps and report on each:
1. Read the error message / stack trace carefully — exact line numbers, exact file paths.
2. Reproduce consistently — what are the exact steps to trigger it? If you cannot reproduce, gather more data instead of guessing.
3. Check recent changes — `git log --oneline -20` and `git diff HEAD~5` against the affected files. What changed?
4. For multi-component flows: trace data flow. Where does the bad value originate? What called this with that value? Keep tracing UPWARD until you find the source. Fix at source, not at symptom.
5. State the root cause as one sentence: "X happens because Y at <file:line>."
6. Label every statement in your report: observed (you ran it and saw it), derived (follows necessarily from evidence), or assumed (unchecked — say what would check it). A root cause resting on an assumption is a hypothesis, not a diagnosis.

End your response with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.
```

If `BLOCKED` or `NEEDS_CONTEXT`: provide the missing info and re-dispatch. Do not skip ahead.

### Phase 2 — Pattern Analysis

Read the root cause from Phase 1. Then:

1. Find working examples in the codebase that do the same kind of thing correctly — use `draht-tools graph-query "<concept>"` to locate reference implementations instead of grepping
2. Read those reference implementations **completely** — not skimmed
3. List every difference between the working code and the broken code, however small
4. Note dependencies: what config, settings, environment, or call-order does the working version assume?

If Phase 2 reveals a different root cause than Phase 1, go back to Phase 1 and re-investigate. Do not paper over the disagreement.

### Phase 3 — Single Hypothesis Test

1. State ONE hypothesis: "I think the root cause is X because Y."
2. Design the **smallest possible change** that would prove the hypothesis — one variable, one line if possible.
3. Apply it and observe. Did it fix the issue?
   - **Yes** → proceed to Phase 4 with this fix.
   - **No** → form a NEW hypothesis (do not pile changes on top). Revert the test change.
4. If after 3 hypotheses you are still failing, STOP. Question the architecture, not the hypothesis. Report to the user.

You may also say "I don't understand X" rather than pretend. That is the correct answer when it's true.

### Phase 4 — Implementation

1. **Write the reproducing test FIRST.** Smallest possible test that demonstrates the bug. Run it — confirm it FAILS for the right reason (not for a syntax error, not for a missing import).
   - Commit: `git add <test-files> && git commit -m "red: reproduce <bug>"`

2. **Apply the single fix** identified in Phase 3. No other changes — no opportunistic refactor, no "while I'm here".
   - Run the failing test — confirm it now PASSES.
   - Run the FULL test suite — confirm no regressions.
   - Commit: `git add <files> && git commit -m "green: fix <bug>"`

3. **Refactor (optional)** — only if there's clear improvement that doesn't change behaviour. Tests must stay green after every change.
   - Commit: `git add <files> && git commit -m "refactor: <description>"`

4. **Verify the fix solved the original symptom**, not just the unit test. Run the user-level reproduction one more time.

5. **Update state**: `draht-tools update-state`

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "Simple bug, skip the process" | Simple bugs have root causes too. The process is fast. |
| "It's an emergency, no time" | Systematic debugging is *faster* than thrashing on guesses. |
| "I'll write the test after I confirm the fix" | Untested fixes don't stick. The test-first proves the bug existed. |
| "I'll just try a few things and see what works" | Can't isolate what worked. Creates new bugs. |
| "I already manually tested it" | A reproducing test is the only durable proof. |
| "The user already told me the cause" | The reporter saw the symptom. Their diagnosis is Hypothesis #0, not a finding. |
| "The fix passed, so my diagnosis was right" | Fixes can mask. Verify the causal chain, not just the symptom's absence. |

## Rules
- Always reproduce before fixing — a fix without a test is a guess
- One bug, one fix, one commit series. Do not bundle unrelated changes.
- Fix at the source, not the symptom
- If 3 fix attempts have failed, the architecture is wrong — stop and discuss
- If the fix is non-obvious, the commit body explains the chain
- Final report order: verdict first (fixed / not fixed, root cause in one sentence), then evidence (reproducing test red→green, suite results), then risk (what the fix could regress, what stays assumed)
