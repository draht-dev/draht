---
description: Diagnose and fix a bug using a 4-phase systematic debugging protocol with TDD discipline
argument-hint: "<description of what's broken>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /fix

Issue: $ARGUMENTS

Investigate and repair the reported defect within the requested scope. Historical design questions belong in `/why`; a triage trace supplies hypotheses, not an already-confirmed diagnosis.

> Invoke noninteractive Draht tooling as `node "<PLUGIN_ROOT>/bin/draht-tools.cjs" <subcommand>`. The `debugging-workflow` skill provides investigation guidance.

## Investigation

Read the relevant source, errors, configuration, and history. Restate observed versus expected behavior and identify a command that can expose the symptom. Code inspection and hypotheses may precede reproduction; distinguish a candidate cause from a demonstrated one.

Use the `debugger` agent when a separate investigation is useful. Pass the issue, relevant code/context, and this scope:

```
Diagnose this issue; do not apply a production fix. Read the affected path and build a reproduction when feasible. Report the supported cause or labeled hypotheses, relevant files, reproduction command/output, and any missing evidence. Respect any read-only restriction, including on test or instrumentation edits.
End with exactly one: STATUS: DONE, STATUS: DONE_WITH_CONCERNS, STATUS: NEEDS_CONTEXT, or STATUS: BLOCKED.
```

- If `NEEDS_CONTEXT`, provide available missing information and retry within the budget.
- If `BLOCKED`, report the blocker and evidence; do not keep retrying.
- At most 3 re-dispatches or failed repair attempts; stop with a concise record when that bound is reached. It does not establish that the architecture is wrong.

Test plausible causes with discriminating observations or small experiments. Use the number of hypotheses the evidence warrants. Remove unsuccessful probes rather than layering speculative changes. When reproduction is unavailable, continue useful read-only investigation and identify what prevents confirmation.

## Repair

Apply a focused fix once the evidence supports it. Preserve a regression check: observe it fail for the intended reason before the repair, then pass afterward where a test seam exists. Explain any inability to establish that evidence. Run the original reproduction when available, relevant regression checks, and project-required validation; do not automatically run every available command.

Remove temporary instrumentation and avoid unrelated cleanup. Delegate the implementation to `implementer` only when useful, with the issue, scope, evidence, checks, and the same STATUS contract.

Commit only when authorized. For recorded TDD phases use plain Git with explicit paths and `red:`, `green:`, `refactor:` subjects; never route source commits through docs-only tooling. Update GSD state only for an active GSD task.

Report the verdict and supported cause first, decisive commands/results next, then residual risk and missing evidence. A completion claim requires checks that cover the current state; reuse recorded results only when their inputs and environment remain unchanged.
