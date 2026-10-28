---
name: atomic-reasoning
description: Decompose complex work into coherent, independently verifiable units when planning dependencies, parallel implementation, or atomic commits.
---

# Atomic Reasoning

Use decomposition when it helps coordinate or verify the work. Small tasks can be implemented directly; this skill does not open every command or require a written plan.

For each unit, identify its intended outcome, dependencies, affected scope, and proving checks. Keep changes together when splitting them would leave an incoherent intermediate state. Split unrelated outcomes. A unit may span files or layers when one behavior requires them; neither a time estimate nor a file count determines atomicity.

Use `draht-tools graph-context <files>` and `graph-impact <files>` when the repository has a map and dependency boundaries are unclear. Structural clusters are evidence about coupling, not a rule that each task must fit one cluster.

Resolve uncertainty that could invalidate later work early. Parallelize units with independent ownership and explicit integration points. Give each subagent the outcome, scope, constraints, and acceptance checks; a blocker requires investigation, not automatic subdivision.

A commit should express one coherent change when commits are authorized. Testing and decomposition do not independently authorize commits. The `red:`, `green:`, and `refactor:` conventions apply when recording TDD phases.
