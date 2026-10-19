---
disable-model-invocation: true
description: Complete an ad-hoc task directly with relevant verification and optional specialist help
argument-hint: "<description>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /quick

Task: $ARGUMENTS

Complete the requested task directly, using an approach proportionate to its scope. Follow repository and user instructions. Ordinary work needs no numbered plan, XML, `.planning/` state, phase command, or session reset.

1. Inspect the relevant code, callers, and tests; identify the observable result the user needs.
2. Make the smallest complete change and preserve unrelated behavior. For behavior changes, add or update focused tests. Reproduce a bug before fixing it and demonstrate that the regression test detects it; skip tests for pure documentation or configuration changes with no testable behavior.
3. Run the relevant project checks and any tests you created or changed, following repository command restrictions. A failed command, timeout, or unavailable required check is not a pass; do not weaken checks to obtain one.
4. Report the result, changed files, and observed verification with decisive output. State what remains unverified. Do not commit unless requested.

## Optional delegation

Delegate when independent investigation, implementation, or fresh review materially helps. Give each agent the task, relevant context, scope, and expected evidence. Use the `implementer` agent for changes, the `spec-reviewer` agent for an explicit spec, and the `reviewer` agent for code quality; when both reviews are needed, check spec compliance first.

Require delegated reports to end with one `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Check evidence before accepting `DONE`; resolve correctness concerns before completion. Supply missing context for `NEEDS_CONTEXT`. An implementer blocker stops the task; a review blocker returns its required fixes for implementation and re-review. Allow at most **3 implementer re-dispatches total across review stages**, then report unresolved findings. Never claim completion while required checks or review findings remain unresolved.
