---
name: ddd-workflow
description: Model domain concepts, invariants, and context boundaries when the user requests domain design or a project already uses domain-driven design.
---

# Domain Design

Start with the project's language and actual consistency requirements. Domain-driven design is an optional modeling approach, not a prerequisite for ordinary edits or naming a variable.

Identify concepts that have distinct rules or ownership, the operations that must be atomic, and the interfaces between them. Use established terms consistently. Prefer the simplest model that enforces the required invariants; do not introduce aggregates, events, repositories, or adapters without a concrete need.

Use the existing domain document when present. `.planning/DOMAIN.md` is GSD's convention, not a required global source of truth. Record meaningful changes to the model alongside implementation in the project's established documentation.

For context boundaries, make ownership and coupling explicit. Direct calls, events, and adapters each have trade-offs; choose according to consistency, latency, failure handling, and dependency direction. A cross-directory import alone does not prove a boundary violation.

For existing code, use `draht-tools graph-clusters` and `graph-context` to find candidate groupings when a map is available. Import clusters are structural evidence; validate their domain meaning against code, docs, and requirements. Do not reorganize a working codebase solely to match graph clusters or a textbook layout.

Validate domain invariants with behavior tests and structural rules with project-defined checks. GSD's glossary/heading checks and import heuristics can reveal possible drift, but they do not prove domain correctness.
