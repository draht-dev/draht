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
3. Present 1-2 questions at a time about preferences
4. If `.planning/DOMAIN.md` exists, load it and validate discovered terms against the glossary. Add any new domain terms found during discussion.
5. Record decisions with `draht-tools save-context $1`
6. Commit: `draht-tools commit-docs "capture phase $1 context"`

## Gray Area Categories
- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, error handling, auth
- **Data models** → Schema, relationships, validation
- **Content** → Structure, tone, depth, flow
- **Refactoring** → Grouping, naming, migration strategy
- **Testability** → What needs testing, test framework preference, coverage goals, integration vs unit boundaries
- **Domain boundaries** → What are the bounded contexts in play? Are there existing domain terms to respect? What aggregates/entities are involved?
