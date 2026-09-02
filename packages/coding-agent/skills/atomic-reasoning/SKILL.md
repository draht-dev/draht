---
name: atomic-reasoning
description: Decompose work into atomic reasoning units before acting — state the logical component, validate independence, verify correctness. The discipline that opens every draht slash command. Use whenever planning, designing, refactoring, breaking down a feature, structuring a commit, or scoping work. Triggers on "plan", "decompose", "break down", "scope", "split", "atomic", "how should I structure", or any moment the agent is about to spawn many parallel changes without first carving the work into independently-verifiable units.
---

# Atomic Reasoning

A meta-discipline. Before acting on any non-trivial piece of work, decompose it into atomic units — pieces that can be reasoned about, built, and verified independently.

This is the discipline that opens every draht slash command (`/plan-phase`, `/execute-phase`, `/fix`, `/quick`, `/verify-work`, `/atomic-commit`). The skill makes it explicit and available outside those commands too.

## The Three Questions

For each unit of work you're about to undertake, answer these three questions before doing anything else:

### 1. State the Logical Component
- What does this change do? What is its singular purpose?
- What observable outcome does it produce?
- Does it complete a thought, or is it half of one?

If you can't state the purpose in one sentence, the unit is not yet atomic — keep decomposing.

### 2. Validate Independence
- Can this be done without touching unrelated features?
- Does it depend on other units, or is it standalone?
- Which files does it touch? Are those files coupled to anything outside this unit's concern?
- If applied alone, would the codebase still build/run?

If the answer to "would it build alone" is *no*, the unit is too small — pair it with the dependency. If the answer to "does it touch unrelated concerns" is *yes*, the unit is too big — split it.

### 3. Verify Correctness
- What test or check would prove this unit works?
- What inputs → what expected outputs or state changes?
- What edge cases or failure modes exist?

If you can't name the proving test, you don't yet understand what "correct" means for this unit. Define it before building.

## How to Apply

### Before planning a feature
For each observable user-visible outcome:
1. State the logical component (what must be true for the user?)
2. Validate independence (which artifacts prove this? can it be built standalone?)
3. Verify correctness (what scenarios prove it works?)

### Validate a decomposition against the living map
Run `draht-tools graph-context <file...>` on each unit's files: a unit whose files share one cluster/bounded context is atomic; a unit spanning multiple contexts should be split along the boundary.

### Before splitting a commit
For each file in the diff:
1. State the logical component (what does this change accomplish?)
2. Validate independence (would this build alone? does it mix concerns?)
3. Verify correctness (is the change complete? does it leave a coherent intermediate state?)

### Before fixing a bug
1. State the logical component (what is the observed failure? what should happen vs what does?)
2. Validate independence (which components are involved? can we isolate it?)
3. Verify correctness (what test reproduces it reliably? what would prove it fixed?)

### Before refactoring
1. State the logical component (what structural change are you making?)
2. Validate independence (which behaviour-equivalence test proves this is a refactor, not a rewrite?)
3. Verify correctness (all tests stay green after the change?)

## Atomicity Heuristics

A unit is atomic if:
- ✅ It can be described in one sentence
- ✅ It can be built or applied in 2–5 minutes of focused work
- ✅ It can be verified by ONE test or check
- ✅ It touches ONE concern in the codebase
- ✅ All files in the atomic unit belong to one bounded context (or explicitly cross a documented boundary) — confirm with `draht-tools graph-context`
- ✅ It produces ONE commit (or one TDD red→green→refactor trio)
- ✅ Its `<files>` list contains specific paths, not "all relevant files"
- ✅ Its outcome is a concrete state change, not "improve X"

If any of these fail, decompose further.

## Order by Risk

Decomposition tells you the units; it doesn't tell you which to do first. When the units are independent, sequence is a lever — use it to fail cheaply.

Score each unit by **uncertainty** (has this codebase done it before?) × **blast radius** (how many other units become invalid if this one is wrong?). Do the highest-scoring unit first; push boilerplate last. Boilerplate never invalidates the plan — the risky, unfamiliar unit regularly does, and you want to discover that before you've built everything downstream of it.

*Example:* a feature needs a third-party webhook and a settings screen. Both are atomic. Prove the webhook round-trip first — if the contract isn't what you assumed, the settings screen you'd have built on top of it was wasted. *Prevents:* sinking effort into work that a later, riskier unit turns out to obsolete.

## Anti-Patterns — STOP

- **"Improve performance"** — not atomic. Pick one metric, one bottleneck, one change.
- **"Refactor the X module"** — not atomic. Pick one structural change with one behaviour-equivalence proof.
- **"Add error handling"** — not atomic. Pick one error case, one handler, one test.
- **"Wire up the Y feature"** — not atomic. Decompose into the components, the data flow, and the integration.
- **"And also fix the related bug while I'm there"** — that's a different atomic unit. Different commit.

## Relationship to TDD

Atomicity and TDD reinforce each other:
- TDD's RED phase forces you to name the proving test (Question 3) before building
- Atomic units fit naturally inside one RED → GREEN → REFACTOR cycle
- A test that requires changes in multiple unrelated files means the unit is not atomic

## Relationship to /atomic-commit

`/atomic-commit` is this skill applied to the git history: each commit is one atomic unit. The questions are the same; the artifact is a commit instead of a plan task.

## Relationship to subagent dispatch

Subagents work best on atomic units. When dispatching:
- Each subagent task should answer the three questions inside its prompt
- Parallel dispatch is only safe when units are genuinely independent (Question 2)
- A subagent returning `STATUS: BLOCKED — complexity` often means the unit wasn't atomic — split it.

## Output

This skill produces *thought*, not files. The artifact is a clearer plan / commit / fix scope before any code is written.
