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

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Steps
1. Run `draht-tools init` to check preconditions (git repo, etc.)
2. Run `draht-tools map-codebase` to build a structural map of the existing code
3. Analyze the codebase map to understand architecture, tech stack, and conventions
4. Deep questioning phase (3-7 rounds — each round asks the whole frontier: settled-prerequisite questions only, numbered, each with a recommended answer):
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
13. Git commit via `draht-tools commit-docs "initialize project planning"`

## Workflow
After project initialization, phases are executed one at a time in new sessions:

```
/init-project → /new → /discuss-phase 1 → /new → /plan-phase 1 → /new → /execute-phase 1 → /new → /verify-work 1
            → /new → /discuss-phase 2 → /new → /plan-phase 2 → /new → /execute-phase 2 → /new → /verify-work 2
            → ... (repeat for all phases in the milestone)
            → /new → /next-milestone (only after ALL phases are complete)
```

Each step runs in its own session (`/new` between steps). Do NOT suggest `/next-milestone` until every phase in the milestone is verified.

## Rules
- Ask the whole frontier per round — numbered, each with a recommended answer; the user replies by number, and accepted-by-number counts as decided
- Questions that depend on still-open answers wait for a later round
- Finding facts is your job, never the user's — dispatch a subagent for anything the environment can answer and keep asking the rest of the frontier while it runs
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Confirm, don't assume
- When the focus names a solution ("migrate to X"), ask what problem it solves — the existing code may admit a smaller answer
- 3-7 follow-up rounds typical
- Respect what already exists — do not propose rewriting working code
- Stop when you have: current state, goals, MVP scope, constraints, success criteria
