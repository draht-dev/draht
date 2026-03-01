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
4. Record decisions with `draht save-context N`
5. Commit: `draht commit-docs "capture phase N context"`

## Gray Area Categories
- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, error handling, auth
- **Data models** → Schema, relationships, validation
- **Content** → Structure, tone, depth, flow
- **Refactoring** → Grouping, naming, migration strategy
