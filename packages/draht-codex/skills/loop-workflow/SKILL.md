---
name: loop-workflow
description: Loop-driven development discipline — run agents in cycles of work gated by deterministic checks until a stop condition is met. Use when work needs iteration until a measurable criterion holds, when designing retry or verification loops, when a task is too large for one context window, or when choosing between one-shot orchestration and a loop. Triggers on "loop", "iterate until", "keep going until", "run until it passes", "ralph loop", "long-running", or any moment the agent is about to retry work without a defined stop condition.
---

# Loop Workflow

A loop is an agent repeating cycles of work until a stop condition is met. The discipline: **the loop closes on a check, not on a feeling of doneness.** Without a check that produces pass/fail, "looks done" is the only signal available and the human becomes the verification loop.

## The Four Hand-offs

Every loop is defined by what gets handed off to it:

| Loop | Hand off | Draht surface |
|---|---|---|
| Turn-based | the check | TDD cycle inside one task (red → green → refactor → verify) |
| Goal-based | the stop condition | `/orchestrate-loop` (deterministic check + max iterations) |
| Phase-based | the spec | `/execute-phase` → `/verify-work` → `--gaps-only` cycle |
| Session-based | the process | GSD per-phase cycle (`/discuss-phase → /plan-phase → /execute-phase → /verify-work`), fresh context each step |

Pick the smallest loop that fits: a failing test needs the TDD loop, not a goal loop; a roadmap phase needs the phase cycle, not an ad-hoc goal loop.

## Anatomy of a Sound Loop

1. **Deterministic check** — a command whose exit code proves the goal. The loop is only as good as its check; a near-perfect verifier is the highest-leverage component of any loop.
2. **Explicit stop conditions** — criterion met, max iterations, stall. Every loop needs a bound; an unbounded loop is a bug, not persistence.
3. **Independent evaluation** — the agent doing the work never decides completion. Re-run the check outside the worker; route the final verdict to a fresh-context evaluator. Agents systematically overrate their own work.
4. **Recoverable state** — every iteration commits and appends a progress log, so any iteration can die without losing the loop. Fresh iterations run a startup ritual: read the progress log, run the check, observe before changing anything.
5. **One increment per cycle** — small verified steps beat one-shot attempts. Batching increments hides which change broke the check.

## Known Failure Modes → Counters

| Failure mode | Counter |
|---|---|
| Premature completion claims | Independent re-run of the check; evidence before claims |
| Self-graded verification | Fresh-context evaluator (spec-reviewer / reviewer) |
| One-shotting too much per cycle | One increment, one commit per iteration |
| State lost at context death | Commit every iteration + append-only progress log |
| Weakening tests or the check to pass | Tests and check are immutable inside a loop; violation means revert + hard stop |
| Spinning on the same failure | Stall detection — two identical failure signatures in a row means change the inputs, consult `advisor`, or stop |
| Time blindness (hours burned re-running slow checks) | Keep checks fast and their output terse: failures only |

## Interaction With Other Disciplines

- `verification-gate` supplies the evidence rules for reading loop results: label them observed / derived / assumed
- `tdd-workflow` is the innermost loop; `/orchestrate-loop` wraps the same shape at goal level
- `atomic-reasoning` cuts the increments: an increment is well-cut only if its check can fail while all others pass
- `model-tiering` sets the economics: loops are volume work, so workers run on the executor tier while steering (the orchestrating context, `advisor`, `spec-reviewer`) stays on the strongest tier — most loop tokens bill at the worker rate

## Scope

This skill is the discipline reference behind `/orchestrate-loop` and the retry mechanics in `/execute-phase` and `/verify-work`. Consult it before constructing any ad-hoc retry-until-done behaviour.
