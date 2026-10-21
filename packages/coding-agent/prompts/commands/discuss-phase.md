---
description: "Capture implementation decisions before planning a phase"
---

# /discuss-phase

Capture implementation decisions before planning a phase.

## Usage
```
/discuss-phase [N]
```

Phase: $1

## Steps
1. Run `draht-tools phase-info $1` to load phase context
2. Identify gray areas based on what's being built
3. Ask about material unresolved decisions, grouping related questions and offering recommendations. Obtain repository facts directly; proceed with independent work while waiting.
4. If `.planning/DOMAIN.md` exists, load it and validate discovered terms against the glossary. Add any new domain terms found during discussion.
5. Record decisions with `draht-tools save-context $1` — label each entry **decided** (the user explicitly chose) or **assumed** (you inferred from context). An answer accepted by number counts as decided. State material assumptions and clarify those that would change scope or correctness.
6. If committing is authorized: `draht-tools commit-docs "capture phase $1 context"`

## Workflow
This is one step in the per-phase cycle. A fresh session between steps is optional:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N → /discuss-phase N+1 → ...
```

After completing this command, identify `/plan-phase $1` as the next step.
Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Gray Area Categories
- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, error handling, auth
- **Data models** → Schema, relationships, validation
- **Content** → Structure, tone, depth, flow
- **Refactoring** → Grouping, naming, migration strategy
- **Testability** → What needs testing, test framework preference, coverage goals, integration vs unit boundaries
- **Domain boundaries** → What are the bounded contexts in play? Are there existing domain terms to respect? What aggregates/entities are involved?
