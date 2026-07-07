---
title: "Eight Reasoning Disciplines for a Coding Agent"
description: "A capable model still fails in characteristic ways. These eight disciplines — read the real request, decompose into checkable pieces, spend effort where the risk is, re-derive claims, label known vs guessed, attack your own conclusion, answer first, know the mistakes that look like competence — are now woven into every Draht agent, command, and skill."
date: "2026-07-07"
author: "Oskar Freye"
tags: ["agents", "reasoning", "prompting", "workflows", "gsd"]
---

Raw capability is not the bottleneck anymore. A strong model can read a stack trace, write the fix, and pass the tests — and still hand you the wrong thing, confidently, because it answered the literal words of your request instead of the need behind them, or because it called a build "green" that it never ran.

Those failures don't come from a gap in intelligence. They come from a gap in **discipline** — the working habits a senior engineer applies without being told. So we wrote them down. What follows is the operating manual now woven into every Draht agent, command, and skill: eight disciplines, each with the procedure to run, one example of it working, and the specific failure it prevents. The order matters — it's roughly the order in which a task moves from "what am I being asked" to "is this safe to hand over."

## 1. Read what the request is actually asking for

The words name an artifact; the request is a need. They are rarely the same thing. A model that optimizes the literal words will build exactly the wrong thing with great precision.

**Procedure.** Restate the goal as the change in the user's world — "after this, a user can X." If the request names a *mechanism* ("add Redis caching"), find the *outcome* behind it ("p95 under 200ms") and work toward the outcome — the mechanism is a candidate, not a requirement. If you can't state the outcome, you can't start; ask.

**Example.** "Add retry logic to the sync job." The real outcome is *syncs recover from transient failures without a human*. Traced that way, the job turns out to be non-idempotent — retries would double-write. The right change is idempotency, and the literal request would have shipped a bug.

**Prevents:** precisely building the wrong thing.

This is the first move in the `architect` agent and in the brainstorming gate, which now refuses to propose an approach until it has stated the need back in one sentence and gotten an explicit yes:

```markdown
## Hear the Problem Beneath the Ask

The user's words describe an artifact; the design must serve a need.
1. Separate the stated artifact ("a dashboard") from the underlying need.
2. When the user names a solution, ask what it solves before refining it.
3. State the need back in one sentence and get an explicit yes.
```

## 2. Decompose into pieces that can each be checked independently

Breaking a problem down is not the discipline — everyone does that. The discipline is a hard test for whether the pieces are actually separable.

**Procedure.** A unit is atomic only if its check can fail while every other unit's check passes. If two pieces can only be verified together, they are one piece — stop pretending otherwise. Name the proving check for each unit *before* you build it.

**Example.** "Add a webhook and a settings screen" looks like two tasks. But if the only way to know the webhook works is to drive it from the settings screen, they share one verification and they are one task until you can test the webhook round-trip on its own.

**Prevents:** a "done" unit that silently depends on another unit that isn't — the seam where integration bugs live.

## 3. Decide where the real risk lives, and spend effort there

Not all pieces deserve equal effort or equal position in the sequence. Treating them equally is how you discover in task nine that the foundation under tasks one through eight can't work.

**Procedure.** Score each unit by **uncertainty** (has this codebase done this before?) × **blast radius** (how much becomes invalid if it's wrong?). Do the highest-scoring unit first. Push boilerplate last — boilerplate never invalidates a plan; the risky, unfamiliar unit regularly does, and you want to find that out while the cost of being wrong is still one unit.

**Example.** A feature needs a third-party webhook and a settings screen. Both are atomic. Prove the webhook round-trip first — if the contract isn't what you assumed, every screen you'd have built on top of it was wasted work.

**Prevents:** sinking effort into work that a later, riskier unit turns out to obsolete.

Risk-first ordering is now the default in `/plan-phase`, `/execute-phase`, and `/orchestrate`: among independent units, the riskiest is dispatched first because its failure invalidates the rest most cheaply.

## 4. Verify a claim by re-deriving it, not by trusting that it sounds right

A claim that sounds correct and a claim that is correct are indistinguishable until you reproduce it. This is the discipline agents skip most, because plausible output is cheap and re-derivation costs a command.

**Procedure.** "Verified" means *you ran it and read the output this session* — not that the code looks right, and not that something upstream reported success. Never relay a subagent's "tests pass"; run the command yourself. For each pass, attempt one break — an input, sequence, or state the author probably didn't try. A pass you haven't tried to break is only "not yet failed."

**Example.** A summary says "auth middleware verified." You re-run the suite — green. Then you request a route with an expired token: `500`, not `401`. The reported claim was true *and the work was still broken*. Only the attempted break found it.

**Prevents:** rubber-stamping — trust laundered into evidence.

This is why the orchestrating commands no longer take `STATUS: DONE` at face value. A subagent result that quotes no verification output is treated as unverified and re-run:

```markdown
5. Spot-check before aggregating. Subagent claims are inputs, not
   verdicts. Before accepting the verifier's DONE, re-run the test
   suite headline yourself and read the counts. A pass you only heard
   about is an "assumed pass" — and an assumed pass is not a pass.
```

## 5. Separate what's known from what's guessed — out loud

Confidence is not evidence, and the dangerous case is the guess wearing a fact's clothes. The fix is a vocabulary that makes the difference visible in the output itself.

**Procedure.** Tag every load-bearing claim as one of three:

- **observed** — you ran it and saw the output
- **derived** — follows *necessarily* from something observed (not "probably" — necessarily)
- **assumed** — believed but unchecked; name what would check it

A conclusion inherits the weakest label it rests on. "Tests pass (observed), so the feature works (assumed — no end-to-end run)" is an *assumed* verdict, and it must not be reported as an observed one.

**Example.** "The middleware is correct" decomposes into "the unit tests pass" (observed) and "therefore the integration is correct" (assumed). Labeling forces the second half into the open, where the missing end-to-end run becomes obvious.

**Prevents:** false confidence propagating downstream as if it were fact.

The `debugger` and `verifier` agents now label every step this way; a root cause resting on an `assumed` link is explicitly a hypothesis, not a diagnosis.

## 6. Attack your own conclusion before handing it over

The cheapest reviewer of your work is you, one minute before you ship it — if you're willing to try to kill your own finding.

**Procedure.** Before a conclusion leaves your hands, try to refute it. For a bug you found, read the code path that would make it a *false positive* — an upstream guard, a type constraint, a test that already covers it. A finding that survives an honest refutation attempt is **confirmed**. One you couldn't confirm is **suspected** — say so, and don't rank it as if it were certain.

**Example.** You flag a null-deref on `user.email`. Then you read three lines up and find `if (!user) return`. Refuted before it wasted a reviewer's afternoon. The finding that survives that scrutiny is the one worth someone's time.

**Prevents:** the false positive that trains readers to ignore the report — which quietly discredits every real finding after it.

`/review` and the `reviewer` agent now require this refutation pass, and the security auditor won't promote a finding to Critical without a traced, confirmed exploit path — reachability is the line between confirmed and suspected.

## 7. Communicate the answer first, then the reasoning, then the risk

The reader wants the verdict, not a re-run of your process. Making them reconstruct the conclusion from a wall of narrative is a failure of the handoff, however good the work underneath.

**Procedure.** Lead with the outcome — what happened, or what you found — in the first line. Then the evidence that supports it. Then the residual risk: what you did *not* check and how it could bite. Never bury a failure under a list of passes.

**Example.** A verification report opens with `phase: FAIL — 11/12 deliverables, auth token expiry unhandled`, then the evidence per deliverable, then what wasn't tested. The reader knows the state of the world in one line and can stop there or read on.

**Prevents:** the decision-maker missing the one failure because it was paragraph six.

Every reporting agent — `verifier`, `reviewer`, `debugger` — now emits verdict-first, and `/verify-work`'s UAT report is explicitly ordered verdict → evidence → risk.

## 8. Know the mistakes that look like competence

The most durable failures are the ones that *feel* like progress. They pass the internal smell test precisely because they resemble good work.

| Looks like competence | Is actually |
|---|---|
| A test that passes on first run | Probably asserts nothing — break the code and watch it fail first |
| A large diff | Unreviewable risk; the task asked for the minimal green change |
| "Refactored while I was in there" | Scope drift that hides which change broke what |
| A confident summary of a file you skimmed | A guess — read it, or say you didn't |
| Silencing a failing check to keep moving | Deleting the only warning you'll get |
| Obeying a plan where it contradicts the code | The code is reality — report the conflict |

**Prevents:** competence theater — motion that reads as progress and isn't.

This table now lives in the `implementer` agent and the `/fix` rationalization tables, where the model is most tempted to mistake activity for results.

## The send gate

Eight disciplines are a lot to hold at once, so they collapse into a five-question self-test that every agent runs before it hands work over. It's the last thing in the `architect`, `implementer`, and `verifier` prompts:

```markdown
## Before You Send
1. Asked     — did I produce the outcome behind the request, not its literal words?
2. Evidence  — is every claim backed by output I observed, with guesses labeled?
3. Attacked  — did I try to break my own conclusion at least once?
4. Ordered   — verdict first, evidence second, risk last?
5. Wrongness — if this is wrong, where is it most likely, and did I check there?
```

None of this is exotic. It's the working memory of a careful engineer, made explicit so a model doesn't have to rediscover it under time pressure — and so the discipline survives being handed from one model to the next. Capability writes the code. Discipline is what makes the code trustworthy.
