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

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Steps
1. Run `draht-tools init` to check preconditions
2. If existing code detected, run `draht-tools map-codebase` first
3. Deep questioning phase (3-7 rounds — each round asks the whole frontier: every question whose prerequisites are settled, numbered, each with a recommended answer)
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
- Ask the whole frontier per round — numbered, each with a recommended answer; the user replies by number, and accepted-by-number counts as decided
- Questions that depend on still-open answers wait for a later round
- Finding facts is your job, never the user's — dispatch a subagent for anything the environment can answer and keep asking the rest of the frontier while it runs
- Follow threads based on answers
- Use examples ("Like Stripe Checkout, or custom?")
- Confirm, don't assume
- When the description names a solution ("an app with X"), ask what problem it solves — requirements record problems and outcomes; mechanisms stay candidates
- 3-7 follow-up rounds typical
- Stop when you have: problem, audience, MVP scope, constraints, success criteria
