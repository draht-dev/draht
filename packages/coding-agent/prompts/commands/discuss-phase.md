# /discuss-phase

Capture implementation decisions before planning a phase.

## Usage
```
/discuss-phase [N]
```

## Steps
1. Run `draht phase-info N` to load phase context
2. Identify gray areas based on what's being built
3. Present 1-2 questions at a time about preferences
4. If `.planning/DOMAIN.md` exists, load it and validate discovered terms against the glossary. Add any new domain terms found during discussion.
5. Record decisions with `draht save-context N`
6. Commit: `draht commit-docs "capture phase N context"`

## Gray Area Categories
- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, error handling, auth
- **Data models** → Schema, relationships, validation
- **Content** → Structure, tone, depth, flow
- **Refactoring** → Grouping, naming, migration strategy
- **Testability** → What needs testing, test framework preference, coverage goals, integration vs unit boundaries
- **Domain boundaries** → What are the bounded contexts in play? Are there existing domain terms to respect? What aggregates/entities are involved?
