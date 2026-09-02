---
name: debugging-workflow
description: Four-phase systematic debugging — reproduction-loop root cause investigation → pattern analysis → ranked falsifiable hypotheses → reproducing-test-first implementation. Use whenever investigating a bug, test failure, error, stack trace, regression, build break, or unexpected behaviour. Auto-triggers on phrases like "broken", "doesn't work", "failing", "error", "bug", "regression", "why is X", "what's wrong with". The same protocol that `/fix` enforces, available transversally.
---

# Debugging Workflow

Random fixes create new bugs. This skill enforces the four-phase systematic debugging protocol whenever Claude is investigating any technical failure — independent of whether the user invoked `/fix`.

## The Iron Law

> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

A symptom fix is a failure. If you patch the visible error without understanding why it occurred, you've created the next bug.

## The Report Is a Symptom, Not a Diagnosis

Restate the failure as observable behaviour — "X happens when Y; expected Z" — before touching anything. If the reporter names a cause ("the cache is stale"), treat it as Hypothesis #0: it earns a test in Phase 3 like any other and does not skip Phase 1. The person who saw the bug saw the symptom; their diagnosis is a lead, not a finding.

*Example:* "fix the stale cache bug" — Phase 1 traces the data flow and finds the cache is fine; the query behind it silently drops a filter. The fix lands in the query. *Prevents:* shipping a correct fix to the wrong component.

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
2. **Build a reproduction loop.** This step is the phase — a tight pass/fail signal that goes red on *this* bug is what bisection, hypothesis-testing, and instrumentation all consume. Spend disproportionate effort here. Work down the ladder and take the first rung that reaches the bug:
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

   **Exit checklist — all four before steps 4-6:** (a) ONE named command; (b) already run at least once; (c) invocation and output shown (secrets redacted); (d) it asserts the exact reported symptom — able to go red on this bug and green once fixed, not merely "runs without erroring".

   **Self-interrupt:** reading code to build a causal theory before this command exists is the anchoring failure this protocol prevents. No red-capable command, no steps 4-6.

   **If you genuinely cannot build a loop:** stop and say so — list what you tried, then ask for environment access, a captured artifact (log dump, recording, saved payload), or permission to add temporary instrumentation. Do not hypothesise without a loop.
3. **Check recent changes.** `git log --oneline -20`, `git diff HEAD~N` on the affected paths. What was the last thing that touched this?
4. **Trace data flow.** Where does the bad value originate? What called the function with that value? Keep tracing **upward** until you find the source. Fix at source, not at the symptom site.
5. **State the root cause in one sentence:** "X happens because Y at <file:line>."
6. **Label each step** observed (you ran it and saw it), derived (follows necessarily from evidence), or assumed (unchecked — name what would check it). A root cause resting on an assumption is a hypothesis, not a diagnosis.

If you cannot state the root cause clearly, you do not understand the bug yet. Do not proceed.

## Phase 1.5 — Orient on the failing file

Before walking the tree, orient via the living map. Run `draht-tools graph-context <failing-file>` for pkg/layer/cluster/importers/imports/sinks and `draht-tools graph-callers <failing-file>` to see who feeds bad values in (supports the "trace UPWARD" step above). If `.planning/codebase/MAP.json` is absent, run `draht-tools map-graph` first.

## Phase 2 — Pattern Analysis

1. **Find working examples.** Use `draht-tools graph-query "<concept>"` instead of grep to locate reference implementations in this repo that do the same kind of thing correctly.
2. **Read references completely.** Not skimmed — read every line of the working version.
3. **List every difference** between working and broken, however small.
4. **Note dependencies.** What config / env / call-order does the working version assume?

If Phase 2 contradicts Phase 1, go back to Phase 1. Don't paper over disagreement.

## Phase 3 — Ranked Hypotheses

1. Generate **3-5 ranked falsifiable hypotheses** before testing any of them. A single hypothesis anchors you to the first plausible idea — ranking forces the alternatives into view.
2. Each hypothesis must state its prediction: "If X is the cause, then changing Y will make the bug disappear / changing Z will make it worse." If you cannot state the prediction, it is a vibe — discard it or sharpen it.
3. If the user named a cause, it is **Hypothesis #0** and enters the ranking with the others — ranked on evidence, not privileged for being first.
4. Show the ranked list to the user before testing. Domain knowledge re-ranks instantly ("we just deployed a change to #3") and rules hypotheses out for free. Do not block waiting for a reply — proceed in ranked order if none comes.
5. Test in rank order, one hypothesis at a time. Design the **smallest possible change** that would prove or falsify the prediction — one variable, one line if possible. Before applying, run `draht-tools graph-impact <file-to-change>` to scope the blast radius (reverse-dependents, affected entry points, crossed boundaries) and avoid regressions. Re-run the Phase 1 reproduction command to read the verdict.
   - **Prediction confirmed** → proceed to Phase 4 with this cause.
   - **Falsified** → revert the probe, record which prediction failed, move to the next hypothesis. Do not pile changes on top.
6. When a probe needs logging, prefer one debugger/REPL inspection over ten log lines; if you must log, tag every line with one unique session prefix, e.g. `[DEBUG-a4f2]`, and never "log everything and grep".
7. **After 3 falsified hypotheses, STOP.** This is an architectural problem, not a ranking problem. Discuss before continuing.

## Phase 4 — Implementation

1. **Write the reproducing test FIRST.** Seed it from the Phase 1 reproduction command — the loop that already goes red is the test's skeleton; port its scenario and its symptom assertion to the right test seam. Confirm it FAILS for the right reason (not syntax, not missing import).
   - Commit: `red: reproduce <bug>`
2. **Apply the single fix** from Phase 3. No other changes.
   - Failing test now PASSES.
   - Full test suite — no regressions.
   - Commit: `green: fix <bug>`
3. **Refactor (optional)** — only if clear improvement. Tests stay green.
   - Commit: `refactor: <description>`
4. **Verify the original symptom is gone** — run the user-level reproduction, not just the unit test.
5. **Sweep instrumentation.** Grep your `[DEBUG-` prefix — done means the grep returns nothing. Tagged probes die here; untagged probes survive to pollute production.

## Red Flags — STOP

Stop immediately if you catch yourself:
- "Quick fix for now, investigate later"
- Multiple changes simultaneously
- Skipping the reproducing test
- Proposing solutions before understanding data flow
- Reading code to build a causal theory before a red-capable reproduction command exists
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
| "The user already told me the cause" | The reporter saw the symptom. Their diagnosis is Hypothesis #0, not a finding. |
| "The fix passed, so my diagnosis was right" | Fixes can mask. Verify the causal chain, not just the symptom's absence. |
| "I can't build a repro, I'll reason it out" | No red-capable command, no diagnosis. Ask for access, an artifact, or permission to instrument. |

## Relationship to /fix

This skill is the *protocol*. `/fix` is the *command* that runs it with subagent delegation, commit conventions, and state updates. Use the skill transversally; use `/fix` when you want the full workflow with tracking.

## Relationship to /why

This protocol answers "why is X doing the wrong thing right now" — a live defect with a reproduction loop. The `why` command answers "why is X built this way" — intent, history, and rejected alternatives reconstructed from git, the review record, and `.planning/`, with `epistemics`-calibrated confidence. If the investigation shows the surprising behaviour is a recorded decision, not a defect, stop debugging and route to `/why`; if a `/why` investigation surfaces a live defect, hand it to `/fix`.

## Relationship to verification-gate

After Phase 4, verification-gate kicks in: don't claim "bug fixed" without running the proving command and seeing the output.
