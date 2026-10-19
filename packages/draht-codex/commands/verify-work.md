---
description: Acceptance testing of completed phase work (parallel verifier + security-auditor + reviewer + spec-reviewer)
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /verify-work

Verify the selected GSD phase against its acceptance criteria.

Phase: $1

Invoke Draht tooling as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>`. Run `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/scripts/gsd-quality-gate.cjs" --checks-only` for the plugin's deterministic gate and honor its exit status.

1. Run `draht-tools extract-deliverables $1` and read the phase's plans. Identify the exact commit range and any uncommitted work being verified; retain the baseline and relevant configuration.
2. Collect verification evidence and focused reviews. Parallelize independent roles where useful:
   - Dispatch `verifier` with the deliverables, changed scope, required commands, and any existing check records. It must inspect actual command outcomes and run missing, stale, or insufficient checks. Use a relevant project `verify-<app>` skill for user-visible behavior when available; preserve its artifacts and cleanup rules. Without such a skill, other direct behavior checks remain possible.
   - Dispatch `security-auditor` with the phase diff and relevant deployment/threat context. Request confirmed findings and actionable suspected risks with severity and evidence.
   - Dispatch `reviewer` with the phase diff and established project conventions. Existing domain documentation and graph impact can inform the review; an unknown glossary word or cross-directory import alone is not a defect.
   - Dispatch `spec-reviewer` with the plan paths, phase diff, and acceptance criteria. Request per-plan compliance, omissions, and over-builds, including work lost or reverted since task reviews.

   Require every role to finish with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Supply missing available context; stop a blocked required review rather than treating it as a pass. At most 3 re-dispatches for missing context or correction; preserve the execution workflow's combined repair cap.
3. Inspect the evidence and load-bearing review findings. Reuse a check only when its source, tests, configuration, dependencies, and execution environment are unchanged and its scope covers the claim. A status line alone is not evidence. Rerun missing, stale, or unverifiable checks; do not repeat a suite merely because an agent ran it.
4. Honor the project's required deterministic quality checks. A failed process, signal, timeout, required unavailable check, non-compliant plan, Must-fix review issue, or confirmed Critical/High security issue prevents a passing phase verdict. Review remaining concerns explicitly.
5. Record each deliverable as pass/fail/partial/skip with evidence. Preserve the labels **observed** (executed behavior with output), **derived** (conclusion supported by observations), and **assumed** (unchecked). Ask for human verification only where automation and available evidence cannot resolve the acceptance criterion.
6. For failures, use `draht-tools create-fix-plan $1 P`. Include a reproduction with observed output where feasible, or the exact missing evidence/access needed to construct one. Group corrections by coherent behavior; no implementation starts on an invented diagnosis.
7. Write the UAT report with `draht-tools write-uat $1`: **verdict first**, **evidence second**, **risk last**. Include deliverable outcomes, commands/checked state, review findings, and material gaps. Follow `unslop` for prose and `explainers` when a diagram or requested HTML report helps.
8. Mark the phase complete only when acceptance and required checks pass. Otherwise route to `/execute-phase $1 --gaps-only`. More phases lead to `/discuss-phase N+1`; `/next-milestone` is only for when all phases are verified. A fresh session is optional.
