---
description: Grill any subject — an idea, a spec, raw tickets, an architecture decision, or an open discussion; the output form is chosen at the end, not presumed at the start
argument-hint: "[subject]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /grill

Subject: $ARGUMENTS

Stress-test the subject through focused questions about assumptions, evidence, trade-offs, and failure modes. The result may be a refined idea, decision, spec, ticket list, or simply a clearer conversation; do not presume a GSD handoff.

Read the relevant context before asking for repository facts. Use the `architect` agent for independent read-only fact-finding when useful; continue questions that do not depend on it.

Group related open decisions and ask the questions whose answers would change the result. Offer a recommendation with its trade-off when helpful. Defer questions that depend on unresolved answers. Preserve what the user decided, label assumptions, and follow new evidence that challenges the leading approach.

The grill is done when every open question whose answer would change the result is decided by the user or labelled an assumption, or when the user stops it. Respect requests to narrow scope or proceed with authorized work.

End with the decisions, consequential assumptions, remaining risks, and recommended next action. Produce the artifact the user requested; otherwise a chat summary is sufficient. Use project conventions for files, and `.planning/` only when that workflow is selected. Follow `unslop` for prose and preserve quoted user decisions exactly.

When an open decision belongs to someone outside the session, such as a client or another team, offer `/questionnaire` to send it to them.

A request to discuss alone does not authorize implementation. When the user subsequently asks to implement, use that authorization without requiring another ceremonial approval.
