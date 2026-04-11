---
description: Initialize a new project with structured GSD planning (questioning → domain model → requirements → roadmap)
argument-hint: "[description]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /new-project

Initialize a new project: questioning → research → requirements → roadmap.

Description: $ARGUMENTS

> **Tool note**: When this command says `draht-tools <subcommand>`, invoke it as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool. `CLAUDE_PLUGIN_ROOT` is set by Claude Code to the plugin's install directory.

## Atomic Reasoning

Before questioning, decompose project vision into atomic reasoning units:

**For each aspect of the new project:**
1. **State the logical component** — What problem does this solve? Who are the users? What is core vs peripheral?
2. **Validate independence** — What bounded contexts will exist? What domain concepts are central? Can features be built independently?
3. **Verify correctness** — What defines MVP success? What constraints exist (time, tech, team)? What is explicitly out of scope?

**Synthesize project strategy:**
- Define bounded contexts and ubiquitous language upfront
- Establish test strategy before writing code
- Create requirements mapped to domain contexts
- Build roadmap with testable phase goals
- Ensure each phase delivers verifiable user value

## Steps
1. Run `draht-tools init` to check preconditions
2. If existing code detected, run `draht-tools map-codebase` first
3. Deep questioning phase (3-7 rounds, 1-2 questions at a time)
4. Run `draht-tools create-project` with gathered info
5. Run `draht-tools create-domain-model` to define bounded contexts, entities, and ubiquitous language
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
8. Optional research phase via `draht-tools research`
9. Run `draht-tools create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
10. Run `draht-tools create-roadmap` with phases
11. Run `draht-tools init-state`
12. Git commit via `draht-tools commit-docs "initialize project planning"`

## Workflow
After project initialization, phases are executed one at a time in fresh sessions:

```
/new-project → /discuss-phase 1 → /plan-phase 1 → /execute-phase 1 → /verify-work 1
             → /discuss-phase 2 → /plan-phase 2 → /execute-phase 2 → /verify-work 2
             → ... (repeat for all phases in the milestone)
             → /next-milestone (only after ALL phases are complete)
```

Start a fresh session (`/clear`) between steps. Do NOT suggest `/next-milestone` until every phase in the milestone is verified.

## Rules
- Ask 1-2 questions at a time, never dump 10 at once
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Confirm, don't assume
- 3-7 follow-up rounds typical
- Stop when you have: problem, audience, MVP scope, constraints, success criteria
