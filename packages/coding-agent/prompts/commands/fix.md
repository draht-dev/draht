---
description: "Diagnose and fix a bug with a 4-phase systematic debugging protocol + TDD discipline"
---

# /fix

Diagnose and fix a bug using the **four-phase systematic debugging protocol**: root cause investigation → pattern analysis → ranked hypotheses & testing → implementation with a reproducing test.

## Usage
```
/fix [description of what's broken]
```

Issue: $ARGUMENTS

## The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Symptom fixes are failure. If you find yourself proposing a "quick fix for now, investigate later", STOP and return to Phase 1.

## The Report Is a Symptom, Not a Diagnosis

**Procedure:** Restate the failure as observable behavior — "X happens when Y; expected Z" — before touching anything. If the user names a cause ("the cache is stale"), treat it as Hypothesis #0: it enters the Phase 3 ranking like any other hypothesis and does not skip Phase 1.

**Example:** "fix the stale cache bug" — Phase 1 traces the data flow and finds the cache is fine; the query behind it silently drops a filter. The fix lands in the query.

**Prevents:** shipping a correct fix to the wrong component.

## Red Flags — STOP

Stop immediately if you catch yourself:
- Proposing "quick fixes for now, investigate later"
- Attempting multiple changes simultaneously
- Skipping a reproducing test before fixing
- Proposing solutions before understanding data flow
- Reading code to build a causal theory before a red-capable reproduction command exists
- Making "one more fix attempt" after already trying 2+
- Watching each fix reveal new problems elsewhere

After **3 failed fix attempts**, STOP. This is a **hard cap**, not advice — an architectural problem, not a hypothesis problem. Report back to the user — do not try a 4th fix. Before reporting, append one dated line to `.planning/STATE.md` under `## Lessons`: what was tried and why it failed, so the next session doesn't repeat the same three attempts.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## The Four Phases

### Phase 1 — Root Cause Investigation (before ANY fix)

Use the `subagent` tool in **single mode** with the `debugger` agent. Prompt:

```
Investigate this issue using Phase 1 root-cause discipline. Do NOT fix anything — only diagnose.

Issue: $ARGUMENTS

Walk through these steps and report on each:
1. Read the error message / stack trace carefully — exact line numbers, exact file paths.
2. Build a reproduction loop — ONE command that goes red on this bug. This step is the heart of the diagnosis; spend disproportionate effort here. Work down the ladder and take the first rung that reaches the bug:
   - failing test at whatever seam reaches the bug (unit, integration, e2e)
   - HTTP request script against a running dev server
   - CLI invocation on a fixture input, output diffed against a known-good snapshot
   - headless browser script asserting on DOM / console / network
   - replay of a captured payload, trace, or event log through the code path in isolation
   - throwaway harness: a minimal subset of the system (mocked deps) exercising the bug path in one call
   - property/fuzz loop: hundreds of random inputs when the output is only sometimes wrong
   - bisection harness: automate "checkout state X, run the check" so `git bisect run` can drive it
   - differential loop: the same input through old vs new version (or two configs), outputs diffed
   - last resort, human-in-the-loop: exact numbered steps for the user to run by hand, output pasted back
   Flaky bugs: the goal is a HIGHER reproduction rate, not a clean repro — loop the trigger 100x, add stress, narrow timing windows until it fails often enough to debug against.
   Exit checklist — all four must hold before you continue: (a) ONE named command (a test invocation, a script path, a curl); (b) you have ALREADY RUN it at least once; (c) your report shows the invocation AND its output (secrets redacted); (d) it asserts the user's EXACT symptom — able to go red on this bug and green once fixed, not merely "runs without erroring".
   Self-interrupt: if you catch yourself reading code to build a causal theory before this command exists, STOP — anchoring on the first plausible idea is the exact failure this protocol prevents. No red-capable command, no steps 4-6.
   If you genuinely cannot build a loop: list what you tried, name what you need (environment access, a captured artifact such as a log dump or recording, or permission to add temporary instrumentation), and end with STATUS: NEEDS_CONTEXT rather than guessing.
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

### Phase 3 — Ranked Hypotheses

1. Generate **3-5 ranked falsifiable hypotheses** before testing any of them. A single hypothesis anchors you to the first plausible idea — ranking forces the alternatives into view.
2. Each hypothesis must state its prediction: "If X is the cause, then changing Y will make the bug disappear / changing Z will make it worse." If you cannot state the prediction, it is a vibe — discard it or sharpen it.
3. If the user named a cause, it is **Hypothesis #0** and enters the ranking with the others — ranked on evidence, not privileged for being first.
4. Show the ranked list to the user before testing. Domain knowledge re-ranks instantly ("we just deployed a change to #3") and rules hypotheses out for free. Do not block waiting for a reply — proceed in ranked order if none comes.
5. Test in rank order, one hypothesis at a time. Design the **smallest possible change** that would prove or falsify the prediction — one variable, one line if possible — and re-run the Phase 1 reproduction command to read the verdict.
   - **Prediction confirmed** → proceed to Phase 4 with this cause.
   - **Falsified** → revert the probe, record which prediction failed, move to the next hypothesis. Do not pile changes on top.
6. When a probe needs logging, prefer one debugger/REPL inspection over ten log lines; if you must log, tag every line with one unique session prefix, e.g. `[DEBUG-a4f2]`, and never "log everything and grep".
7. If after 3 falsified hypotheses you are still failing, STOP. Question the architecture, not the ranking. Report to the user.

### Phase 4 — Implementation

1. **Write the reproducing test FIRST.** Seed it from the Phase 1 reproduction command — the loop that already goes red is the test's skeleton; port its scenario and its symptom assertion to the right test seam. Confirm it FAILS for the right reason.
   - Commit: `git add <test-files> && git commit -m "red: reproduce <bug>"`

2. **Apply the single fix** from Phase 3. No other changes.
   - Failing test now PASSES.
   - Full test suite — no regressions.
   - Commit: `git add <files> && git commit -m "green: fix <bug>"`

3. **Refactor (optional)** — only if clear improvement, no behaviour change. Tests stay green.
   - Commit: `git add <files> && git commit -m "refactor: <description>"`

4. **Verify the original symptom is gone** — run the user-level reproduction.

5. **Sweep instrumentation** — grep your `[DEBUG-` prefix across the tree; the fix is not done until the grep returns nothing. Tagged probes die here; untagged probes survive to pollute production.

6. **Update state**: `draht-tools update-state`

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
| "I can't reproduce it, but the cause is obvious from the code" | Reading code yields theories, not verdicts. No red-capable command, no diagnosis — report NEEDS_CONTEXT and name what's missing. |

## Rules
- Always reproduce before fixing
- One bug, one fix, one commit series
- Fix at source, not symptom
- 3 failed attempts ⇒ architecture problem, stop and discuss
- If the root cause spans multiple files, explain the chain in the commit message
- Final report order: verdict first (fixed / not fixed, root cause in one sentence), then evidence (reproducing test red→green, suite results), then risk (what the fix could regress, what stays assumed)
