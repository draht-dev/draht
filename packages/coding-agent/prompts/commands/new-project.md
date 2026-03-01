# /new-project

Initialize a new GSD project: questioning → research → requirements → roadmap.

## Usage
```
/new-project [description]
```

## Steps
1. Run `draht init` to check preconditions
2. If existing code detected, run `draht map-codebase` first
3. Deep questioning phase (3-7 rounds, 1-2 questions at a time)
4. Run `draht create-project` with gathered info
5. Run `draht create-domain-model` to define bounded contexts, entities, and ubiquitous language
6. Create `.planning/DOMAIN.md` with:
   - `## Bounded Contexts` — each context with name, responsibility, and brief description
   - `## Ubiquitous Language` — glossary of domain terms agreed with the user (term → definition)
   - `## Context Map` — how bounded contexts relate to each other (upstream/downstream, shared kernel, ACL)
   - `## Aggregates` — aggregates and their root entities per context
   - `## Domain Events` — named events that cross context boundaries
7. Create `.planning/TEST-STRATEGY.md` with:
   - `## Test Framework` — chosen framework and rationale
   - `## Directory Conventions` — where test files live relative to source
   - `## Coverage Goals` — target coverage percentage and which paths are critical
   - `## Testing Levels` — what is tested at unit level vs integration vs e2e, with examples
   - `## Excluded` — what is explicitly not tested and why (config files, generated code, etc.)
8. Optional research phase via `draht research`
9. Run `draht create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
10. Run `draht create-roadmap` with phases
11. Run `draht init-state`
12. Git commit via `draht commit-docs "initialize GSD project"`

## Rules
- Ask 1-2 questions at a time, never dump 10 at once
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Confirm, don't assume
- 3-7 follow-up rounds typical
- Stop when you have: problem, audience, MVP scope, constraints, success criteria
