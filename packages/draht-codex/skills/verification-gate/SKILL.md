---
name: verification-gate
description: Validate software behavior and completion claims against executed checks and evidence for the current code state.
---

# Verification Gate

Report a result only when the evidence supports it. Run the relevant checks, read their output and exit status, and distinguish observed behavior from inference and unchecked assumptions.

## Evidence and freshness

Record the command, working directory, outcome, and the code/configuration state it checked. A commit alone does not identify a dirty worktree; include relevant uncommitted changes or use the project's content-based verification record.

Reuse a passing result when its inputs and execution environment are unchanged and it covers the claim. Rerun after relevant source, tests, configuration, dependencies, or environment changes. If input tracking is incomplete or freshness cannot be established, rerun the affected check. Do not rerun solely because another message or agent boundary intervened.

Inspect a subagent's actual check evidence and confirm its scope and freshness. A bare `STATUS: DONE` is not evidence. Re-run when evidence is absent, unverifiable, stale, or insufficient for the risk; independent verification need not duplicate a proven unchanged check.

## Choose checks for the claim

| Claim | Evidence |
|---|---|
| Tests, types, lint, or build pass | Successful process outcome and output from the named check |
| Bug is fixed | A check that exposed the symptom before the fix now passes; user-level reproduction when available |
| Feature behaves as requested | Relevant behavior test or observed user interaction |
| Refactor preserves behavior | Checks covering the affected behavior and boundaries |
| Deployment succeeded | Successful deployment plus observation of the deployed service |

Run project-required checks and focused checks for the changed behavior. Broaden when risk, failures, or uncovered dependencies justify it. Respect command restrictions; an unavailable or prohibited check is a stated limitation, not permission to run it.

Static analysis, test counts, and graph structure each prove only their own properties. A passing typecheck does not prove runtime behavior; a clean graph does not prove an architecture is sound. Process failure, timeout, signal, or missing check is never a pass.

Report the outcome first, then the decisive commands/results and material gaps. Keep evidence concise, redact secrets, and do not convert a limited check into a claim about the entire system.
