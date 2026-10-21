---
description: "Grill any subject in whole-frontier question rounds — output form chosen at the end, not presumed"
---

# /grill

Subject: $ARGUMENTS

Stress-test the subject through focused questions about assumptions, evidence, trade-offs, and failure modes. The result may be a refined idea, decision, spec, ticket list, or simply a clearer conversation; do not presume a GSD handoff.

Read the relevant context before asking for repository facts. Use the `architect` agent for independent read-only fact-finding when useful; continue questions that do not depend on it.

Group related open decisions and ask the questions whose answers would change the result. Offer a recommendation with its trade-off when helpful. Defer questions that depend on unresolved answers. Preserve what the user decided, label assumptions, and follow new evidence that challenges the leading approach.

Continue while useful unresolved questions remain and the user wants deeper examination. There is no requirement to enumerate every imaginable branch or empty a fixed question tree. Respect requests to stop, narrow scope, or proceed with authorized work.

End with the decisions, consequential assumptions, remaining risks, and recommended next action. Produce the artifact the user requested; otherwise a chat summary is sufficient. Use project conventions for files, and `.planning/` only when that workflow is selected. Follow `unslop` for prose and preserve quoted user decisions exactly.

A request to discuss alone does not authorize implementation. When the user subsequently asks to implement, use that authorization without requiring another ceremonial approval.
