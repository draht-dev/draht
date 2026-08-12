---
name: verification-gate
description: Evidence before claims — before stating that work is done, fixed, passing, working, ready, complete, or successful, run the command that proves it and read the output. Triggers on language like "done", "fixed", "should work", "looks good", "passing", "ready to ship", "complete", or whenever the agent is about to assert positive state. Applies everywhere — feature work, bug fixes, refactors, infra, docs that depend on code state.
---

# Verification Gate

A transversal discipline: never claim positive state without empirical proof. This skill applies to every conversation — not just /verify-work or /execute-phase.

## The Iron Rule

> **Evidence before claims, always.**

Before you say *done*, *fixed*, *works*, *passes*, *ready*, *complete*, or any equivalent, you must:

1. **IDENTIFY** the command that would prove the claim
2. **RUN** it fully and fresh — not from memory of a previous run
3. **READ** the full output and the exit code
4. **VERIFY** the output actually supports the claim (not just "no error visible")
5. **ONLY THEN** state the result, with the evidence inline

## Label What You Know

Evidence isn't binary — statements sit on a ladder, and mislabeling one rung as another is how false confidence spreads. Tag each claim:

- **observed** — you ran it and saw the output this session
- **derived** — follows necessarily from something observed (not "probably", *necessarily*)
- **assumed** — believed but unchecked; name what would check it

A conclusion inherits the weakest label it rests on. "Tests pass (observed), so the feature works (assumed — no end-to-end run)" is an *assumed* verdict wearing an observed one's confidence. Say "the feature works" only when you've observed the feature, not just the tests around it.

## What Requires Empirical Verification

| Claim | Required Evidence |
|---|---|
| "Tests pass" | Output of the test command showing zero failures, exit 0 |
| "Build works" | Build command output, exit 0 |
| "Lint is clean" | Lint command output showing zero errors |
| "Typecheck passes" | `tsc --noEmit` (or equivalent) output, exit 0 |
| "Bug is fixed" | A reproducing test that previously failed now passes, AND the original user-level reproduction succeeds |
| "Feature works" | Manual reproduction of the user-visible behaviour, or an end-to-end test |
| "Migration is safe" | Dry-run output OR equivalent staging verification |
| "Deployment succeeded" | Deploy command output AND a live check (curl, health endpoint, etc.) |
| "Refactor is non-breaking" | Full test suite green AND a behaviour-equivalence check |
| "Architecture is sound" | `draht-tools map-graph` rebuilt, then `draht-tools graph-clusters --surprising` showing no new cross-context / layer-direction violations |

## Red Flag Phrases — STOP and Verify

If you are about to use any of these phrases without inline evidence, STOP and run the proving command first:

- "should work"
- "should pass"
- "probably works"
- "seems to work"
- "looks good"
- "looks fine"
- "appears to be"
- "Done!" / "Perfect!" / "All set!"
- "ready to ship"
- "no issues" / "no problems"

These phrases signal optimism, not verification. Replace them with the command output.

## Rationalization Table

| Excuse | Reality |
|--------|---------|
| "I'm confident this works" | Confidence is not evidence. Run the command. |
| "It's a one-line change, can't break anything" | One-line changes break things all the time. Run the tests. |
| "I just ran the tests two messages ago" | The state may have changed. If in doubt, run again. |
| "The user can verify themselves" | The user asked the agent to do the work. The work isn't done until proven. |
| "Partial verification is good enough" | Either prove the claim or don't make the claim. |
| "It compiled, so it works" | Compilation is not behaviour. Run the behaviour test. |

## Verification of Subagent Reports

Subagents return `STATUS: DONE` and may claim work is complete. **You must independently verify**, not just relay the status. If a subagent says tests pass, run the tests yourself before reporting up.

## Interaction With TDD

Verification gate and TDD reinforce each other:
- TDD makes the proving command obvious (the reproducing test)
- Verification gate prevents the "I'll run tests later" failure mode
- A `green:` commit without observing the test pass first is a TDD violation AND a verification gate violation

## Scope

This skill is auto-loading. It applies whenever the agent is in a position to claim positive state. It does not need to be explicitly invoked.

## Exception

You may say "I expect this to work because..." (forward-looking, with reasoning) before running the command. You may NOT say "this works" without running the command. The difference is tense and evidence.
