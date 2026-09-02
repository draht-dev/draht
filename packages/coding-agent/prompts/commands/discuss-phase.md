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

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Steps
1. Run `draht-tools phase-info $1` to load phase context
2. Identify gray areas based on what's being built
3. Present the whole frontier of open decisions in one numbered round — every question whose prerequisites are settled, each with a recommended answer the user can accept by number; defer questions that depend on still-open answers to the next round. Environment facts are your job, never the user's — dispatch a subagent and only hold back the questions downstream of it.
4. If `.planning/DOMAIN.md` exists, load it and validate discovered terms against the glossary. Add any new domain terms found during discussion.
5. Record decisions with `draht-tools save-context $1` — label each entry **decided** (the user explicitly chose) or **assumed** (you inferred from context). An answer accepted by number counts as decided. Assumed entries are flagged for confirmation; a plan built on an unlabeled assumption fails silently later.
6. Commit: `draht-tools commit-docs "capture phase $1 context"`

## Workflow
This is one step in the per-phase cycle. Each step runs in its own session (`/new` between steps):

```
/discuss-phase N → /new → /plan-phase N → /new → /execute-phase N → /new → /verify-work N → /new → /discuss-phase N+1 → ...
```

After completing this command, tell the user to start a new session and run `/plan-phase $1`.
Do NOT suggest `/next-milestone` — that is only after ALL phases in the milestone are verified.

## Gray Area Categories
- **Visual features** → Layout, density, interactions, empty states
- **APIs/CLIs** → Response format, error handling, auth
- **Data models** → Schema, relationships, validation
- **Content** → Structure, tone, depth, flow
- **Refactoring** → Grouping, naming, migration strategy
- **Testability** → What needs testing, test framework preference, coverage goals, integration vs unit boundaries
- **Domain boundaries** → What are the bounded contexts in play? Are there existing domain terms to respect? What aggregates/entities are involved?
