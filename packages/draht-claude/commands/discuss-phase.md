---
description: Capture implementation decisions before planning a phase
argument-hint: "<phase-number>"
allowed-tools: Bash, Read, Write, Edit
---

# /discuss-phase

Capture implementation decisions before planning a phase.

Phase: $1

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Atomic Reasoning

Before questioning, decompose this phase scope into atomic reasoning units:

**For each implementation decision:**
1. **State the logical component** — What gray area exists? What choice needs to be made? Why does this matter?
2. **Validate independence** — Can this decision be made independently, or does it depend on other choices? What downstream impacts does it have?
3. **Verify correctness** — What criteria determine the right answer? What trade-offs exist? What domain terms need clarification?

**Synthesize discussion strategy:**
- Identify critical decisions that block planning
- Group related decisions (e.g., all API decisions together)
- Sequence questions from foundational to detailed
- Ensure domain language is established first

## Steps
1. Run `draht-tools phase-info $1` to load phase context
2. Identify gray areas based on what's being built
3. Present 1-2 questions at a time about preferences
4. If `.planning/DOMAIN.md` exists, load it and validate discovered terms against the glossary. Add any new domain terms found during discussion.
5. Record decisions with `draht-tools save-context $1`
6. Commit: `draht-tools commit-docs "capture phase $1 context"`

## Workflow
This is one step in the per-phase cycle. Use fresh sessions (`/clear`) between steps:

```
/discuss-phase N → /plan-phase N → /execute-phase N → /verify-work N → /discuss-phase N+1 → ...
```

After completing this command, tell the user to start a fresh session and run `/plan-phase $1`. Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Gray Area Categories
- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, error handling, auth
- **Data models** → Schema, relationships, validation
- **Content** → Structure, tone, depth, flow
- **Refactoring** → Grouping, naming, migration strategy
- **Testability** → What needs testing, test framework preference, coverage goals, integration vs unit boundaries
- **Domain boundaries** → What are the bounded contexts in play? Are there existing domain terms to respect? What aggregates/entities are involved?
