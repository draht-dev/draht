---
name: epistemics
description: Calibrate historical or uncertain investigation findings, distinguish evidence from inference, and report source coverage and gaps.
---

# Epistemics

Cite evidence for claims about history or intent. Code demonstrates behavior; motivation requires a decision record, commit/PR discussion, source comment, or other relevant evidence. When those are absent, label the inference.

Use these tiers when they help communicate uncertainty:

- **Direct:** a cited explicit statement from a source in a position to know.
- **Supported:** independent indirect sources converge; explain that support without presenting it as an explicit statement.
- **Inferred:** a plausible interpretation of evidence; state the inference and what it rests on.
- **Speculative:** an unresolved hypothesis, separate from established findings.
- **Unknown:** evidence was unavailable or searches did not resolve the question.

Treat the user's suggested explanation as a candidate. Seek evidence that could contradict the leading interpretation. Surface conflicting sources instead of choosing a tidier narrative. Repeated code can reflect convention or copying; it does not establish intent by itself.

Distinguish a search with no result from a source that was not searched. A null result means no evidence was found within the stated scope, not that no evidence exists. Report material gaps; do not invent a gap to satisfy a report template.

For an investigation report, include a concise **Sources Consulted** summary with relevant queries, coverage, null results, and unavailable sources. Scope source collection to the question; do not require every service or evidence category for every answer. Follow any caller-specified report format.

Use `verification-gate` for present-state claims that can be checked by execution. Preserve `verify-work`'s observed/derived/assumed labels and verdict-first ordering when that command is selected.
