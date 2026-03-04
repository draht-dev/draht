# /init-project

Initialize GSD planning framework for an existing project: codebase mapping → questioning → domain model → requirements → roadmap.

## Usage
```
/init-project [focus area or goal]
```

Use this when you have an existing codebase and want to add GSD methodology.
For greenfield projects, use `/new-project` instead.

## Steps
1. Run `draht-tools init` to check preconditions (git repo, etc.)
2. Run `draht-tools map-codebase` to build a structural map of the existing code
3. Analyze the codebase map to understand architecture, tech stack, and conventions
4. Deep questioning phase (3-7 rounds, 1-2 questions at a time):
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
9. Optional research phase via `draht-tools research`
10. Run `draht-tools create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
11. Run `draht-tools create-roadmap` with phases
12. Run `draht-tools init-state`
13. Git commit via `draht-tools commit-docs "initialize GSD planning"`

## Rules
- Ask 1-2 questions at a time, never dump 10 at once
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Confirm, don't assume
- 3-7 follow-up rounds typical
- Respect what already exists — do not propose rewriting working code
- Stop when you have: current state, goals, MVP scope, constraints, success criteria
