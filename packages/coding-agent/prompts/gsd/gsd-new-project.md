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
6. Optional research phase via `draht research`
7. Run `draht create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
8. Run `draht create-roadmap` with phases
9. Run `draht init-state`
10. Git commit via `draht commit-docs "initialize GSD project"`

## Rules
- Ask 1-2 questions at a time, never dump 10 at once
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Confirm, don't assume
- 3-7 follow-up rounds typical
- Stop when you have: problem, audience, MVP scope, constraints, success criteria
