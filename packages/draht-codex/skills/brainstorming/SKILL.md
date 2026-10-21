---
name: brainstorming
description: Explore a project idea, compare approaches, and resolve unclear goals or scope when the user asks to brainstorm or design.
---

# Brainstorming

Help the user choose an approach that serves their goal. Brainstorming is optional; it is not a prerequisite for coding, planning, or project initialization.

Read the relevant project context before asking for facts available in the repository. Use an existing codebase map for focused questions when helpful; do not generate a full map just to start a discussion.

Clarify only decisions that materially change the outcome: intended users, observable success, constraints, scope, and significant risks. Group related questions, offer a recommendation where useful, and distinguish confirmed decisions from assumptions. Do not require a fixed number of questions, alternatives, or approval rounds. A clear request can already supply enough direction.

Compare plausible approaches when there is a real trade-off. Explain the consequences in concrete terms. Present a coherent design at a level of detail appropriate to the task, including unresolved decisions and how success will be checked.

If the user asks to proceed, continue with the authorized work and state necessary assumptions. Ask for clarification only when a missing decision prevents useful work or the next action requires authorization that is not already present.

The result can be a concise recommendation in chat. Write a design document when requested or useful for substantial work, using the project's established location. Separate proposals from accepted decisions. Use `.planning/specs/` and hand off to GSD commands only when the user selected that workflow.

Use `grill` for a requested adversarial review of an idea or decision; it is not a mandatory next step.
