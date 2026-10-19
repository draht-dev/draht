---
name: debugging-workflow
description: Investigate a software defect, test plausible causes, and verify a focused repair with regression evidence.
---

# Debugging Workflow

Start from the observed symptom and expected behavior. A reported cause is a hypothesis until supported by evidence. Respect the delegated scope: diagnosis-only work proposes a fix; read-only work makes no edits, including test or instrumentation edits.

Read relevant code, logs, history, and configuration to understand the path and construct a reproduction. Use a repository's codebase graph before broad search when available. Source inspection and exploratory hypotheses can precede reproduction; label conclusions that have not been checked.

## Reproduce and isolate

Prefer a small repeatable command that asserts the reported symptom: a focused test, request, CLI fixture, captured-event replay, or browser interaction. For intermittent failures, record reproduction frequency and environmental conditions. If automation cannot reach the problem, document exact manual steps and the missing access or artifact.

A useful reproduction has a known invocation, observed output, and an assertion that fails on this defect. Lack of a reproduction limits confidence; it does not forbid further read-only investigation. Do not claim a confirmed repair without evidence that addresses the symptom.

Develop as many plausible hypotheses as the evidence warrants. For each unresolved cause, choose a discriminating observation or experiment. Test one meaningful variable at a time, record the result, and remove unsuccessful probes. Compare working examples when they expose a relevant difference; there is no fixed hypothesis count.

If evidence stops improving, revisit assumptions or report the missing information. Respect the caller's retry budget. Three failed attempts are a stopping bound when configured, not proof of an architectural defect.

## Repair and verify

When repair is authorized, add a regression test that fails for the observed reason before changing the implementation where a suitable test seam exists. Otherwise preserve the reproduction and explain the testing limitation. Apply the smallest complete fix and run the reproduction plus relevant regression and project-required checks.

Keep unrelated cleanup out of scope. Remove temporary instrumentation. Comment only non-obvious constraints or rationale. Record TDD phases with `red:`, `green:`, and `refactor:` when commits are authorized; debugging does not authorize committing or creating planning state.

Report the supported cause or leading hypothesis, changes made, checks and their outcomes, and remaining uncertainty. Use `verification-gate` for freshness and claim scope. Use `why` when the question is historical intent rather than current defective behavior.
