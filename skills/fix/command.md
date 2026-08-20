---
description: Diagnose and fix a bug using a 4-phase systematic debugging protocol with TDD discipline
argument-hint: "<description of what's broken>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /fix

Diagnose and fix a bug using the **four-phase systematic debugging protocol**: root cause investigation → pattern analysis → ranked hypotheses & testing → implementation with a reproducing test.

Issue: $ARGUMENTS

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. For subagents, dispatch the `debugger` or `implementer` role.

## The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Symptom fixes are failure — they create new bugs in different places. If you find yourself proposing a "quick fix for now, investigate later", STOP and return to Phase 1.

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
- Implementing before a failing test exists for the bug

When you've tried **3 fix attempts and still failing**, STOP. This is a **hard cap**, not advice — an architectural problem, not a hypothesis problem. Report back to the user — do not try a 4th fix. Before reporting, append one line to `.planning/STATE.md` under `## Lessons`: what was tried, why it failed, dated — so the next session doesn't repeat the same three attempts.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## The Four Phases

### Phase 1 — Root Cause Investigation (before ANY fix)

Once the affected/buggy file is identified, run `draht-tools graph-context <buggy-file>` and `draht-tools graph-callers <buggy-file>` to orient (package, layer, who calls it) — paste the summary into the `debugger` subagent's prompt to support its "trace UPWARD" step.

Dispatch the `debugger` subagent with this prompt:

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

You may also say "I don't understand X" rather than pretend. That is the correct answer when it's true.

### Phase 4 — Implementation

Comment discipline: the fix ships no narration — comments exist ONLY for constraints the code cannot express: a protocol quirk, a deliberate deviation, a non-obvious invariant. If code needs comments to be understood, rewrite the code until it doesn't. Never narrate steps, restate the diff, or leave "removed X" / "this handles Y" breadcrumbs. Comment density above the surrounding file's norm is a defect — fix it before committing. A heavily-commented solution signals the design is wrong: redesign, don't annotate.

1. **Write the reproducing test FIRST.** Seed it from the Phase 1 reproduction command — the loop that already goes red is the test's skeleton; port its scenario and its symptom assertion to the right test seam. Smallest possible test that demonstrates the bug. Run it — confirm it FAILS for the right reason (not for a syntax error, not for a missing import).
   - Commit: `git add <test-files> && git commit -m "red: reproduce <bug>"`

2. **Apply the single fix** identified in Phase 3. No other changes — no opportunistic refactor, no "while I'm here".
   - Run the failing test — confirm it now PASSES.
   - Run the FULL test suite — confirm no regressions.
   - Commit: `git add <files> && git commit -m "green: fix <bug>"`

3. **Refactor (optional)** — only if there's clear improvement that doesn't change behaviour. Tests must stay green after every change.
   - Commit: `git add <files> && git commit -m "refactor: <description>"`

4. **Verify the fix solved the original symptom**, not just the unit test. Run the user-level reproduction one more time.

5. **Sweep instrumentation** — grep your `[DEBUG-` prefix across the tree; the fix is not done until the grep returns nothing. Tagged probes die here; untagged probes survive to pollute production.

6. **Update state**: `draht-tools update-state`

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
| "I can't reproduce it, but the cause is obvious from the code" | Reading code yields theories, not verdicts. No red-capable command, no diagnosis — report NEEDS_CONTEXT and name what's missing. |

## Rules
- Always reproduce before fixing — a fix without a test is a guess
- One bug, one fix, one commit series. Do not bundle unrelated changes.
- Fix at the source, not the symptom
- If 3 fix attempts have failed, the architecture is wrong — stop and discuss
- If the fix is non-obvious, the commit body explains the chain
- Final report order: verdict first (fixed / not fixed, root cause in one sentence), then evidence (reproducing test red→green, suite results), then risk (what the fix could regress, what stays assumed)
