---
description: Investigate why code is the way it is — design rationale, history, rejected alternatives — via parallel evidence investigators and a confidence-tiered, citation-backed synthesis
argument-hint: "<file, symbol, or question>"
allowed-tools: Bash, Read, Task
---

# /why

Question: $ARGUMENTS

Explain historical intent from evidence. Use `epistemics` to distinguish direct statements, supported conclusions, inference, speculation, and unknowns. Current defects belong in `/fix`; a structural walkthrough may use `/map-codebase`.

## Investigate

Identify the target files/symbols and the specific decision being asked about. Read the relevant source, blame, and history; use `git log --follow`, pickaxe, and linked PR/issue discussions to trace the decision. Source mechanics alone do not establish motivation.

Select evidence sources that can answer the question:

- Git history and changed tests: origin, later changes, reversions, and constraints.
- PR/review record: rejected alternatives and discussion before merge.
- Existing planning records: decisions, lessons, summaries, verification, and handoffs.
- ADRs and changelogs: recorded rationale and later revisions.
- Available external tools: relevant tracker, conversation, or operational evidence. Do not invent access or contact people.

Follow decisive leads, including incident evidence for defensive code. A direct answer in a relevant record may be sufficient; do not require an investigator for every category. Report unavailable sources when they materially limit the answer.

## Delegate when useful

Use `investigator` agents for independent evidence searches. Give each only the question, code anchor, assigned sources, relevant leads, and read-only scope. Shared investigator instructions already define citations and reporting; avoid copying the entire protocol into every task.

Require `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Supply available missing context for `NEEDS_CONTEXT`; an unavailable required tool is a blocker, not a reason to retry unchanged. At most 3 re-dispatches total.

The lead checks load-bearing citations, merges duplicate evidence, and resolves cross-source leads. Consult the `advisor` agent when a contested inference would change an imminent implementation decision.

## Report

Lead with the answer and its confidence. Separate what sources establish from what is inferred; cite each material claim and preserve contradictions. Include unresolved hypotheses only when they help answer the question.

End with a concise **Sources Consulted** account of the searches, relevant null results, and material coverage gaps. Do not require empty headings or searches unrelated to the question. Follow `unslop` for prose and `explainers` when a timeline, dependency, or causal diagram helps.

When this investigation precedes a change, state the resulting Preserve / Change / Avoid / Risk constraints. These can guide ordinary implementation or an explicitly selected GSD plan.
