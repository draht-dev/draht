---
description: "Initialize planning for an existing project"
---

# /init-project

Initialize planning framework for an existing project: codebase mapping → questioning → domain model → requirements → roadmap.

## Usage
```
/init-project [focus area or goal]
```

Focus: $ARGUMENTS

Use this when you have an existing codebase and want to add structured planning.
For greenfield projects, use `/new-project` instead.

## Steps
1. Run `draht-tools init` to check preconditions (git repo, etc.)
2. Run `draht-tools map-codebase` to build a structural map of the existing code
3. Read `.planning/codebase/GRAPH_REPORT.md` and query relevant files/concepts with `draht-tools graph-context` and `graph-query`; do not load the full MAP.json
4. Clarify material gaps in the problem, scope, constraints, and success criteria; use existing answers and repository evidence before asking:
   - What is this project? Who uses it?
   - What are the current pain points or goals?
   - What is MVP vs aspirational scope?
   - What constraints exist (infra, team size, deadlines)?
5. Run `draht-tools create-project` with gathered info
6. Run `draht-tools create-domain-model` to define bounded contexts, entities, and ubiquitous language
7. Create `.planning/DOMAIN.md` with:
   - `## Bounded Contexts` — each context with name, responsibility, and brief description
   - `## Ubiquitous Language` — glossary of domain terms agreed with the user (term → definition)
   - `## Context Map` — how bounded contexts relate to each other (upstream/downstream, shared kernel, ACL)
   - `## Aggregates` — aggregates and their root entities per context
   - `## Domain Events` — named events that cross context boundaries
8. Create `.planning/TEST-STRATEGY.md` with:
   - `## Test Framework` — chosen framework and rationale
   - `## Directory Conventions` — where test files live relative to source
   - `## Coverage Goals` — target coverage percentage and which paths are critical
   - `## Testing Levels` — what is tested at unit level vs integration vs e2e, with examples
   - `## Excluded` — what is explicitly not tested and why (config files, generated code, etc.)
9. If research is needed before defining requirements, investigate the open questions and save findings with sources under `.planning/research/<topic>.md`
10. Run `draht-tools create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
11. Run `draht-tools create-roadmap` with phases
12. Run `draht-tools init-state`
13. If committing is authorized, use `draht-tools commit-docs "initialize project planning"`

## Workflow
After project initialization, phases are executed one at a time in dependency order:

```
/init-project → /discuss-phase 1 → /plan-phase 1 → /execute-phase 1 → /verify-work 1
            → /discuss-phase 2 → /plan-phase 2 → /execute-phase 2 → /verify-work 2
            → ... (repeat for all phases in the milestone)
            → /next-milestone (only after ALL phases are complete)
```

A fresh session between steps is optional. Do NOT suggest `/next-milestone` until every phase in the milestone is verified.

## Rules
- Group related questions and ask only those that change a material decision.
- Questions that depend on still-open answers wait for a later round
- Investigate repository facts directly; delegate independent research when useful.
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Distinguish user decisions from reasonable implementation assumptions; clarify only blocking ambiguity
- Respect explicit requirements; clarify the intended outcome when it is unclear.
- Respect what already exists — do not propose rewriting working code
- Stop when you have: current state, goals, MVP scope, constraints, success criteria
