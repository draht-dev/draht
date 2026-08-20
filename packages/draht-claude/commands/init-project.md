---
description: Initialize GSD planning for an existing project (codebase mapping → questioning → domain model → roadmap)
argument-hint: "[focus area]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /init-project

Initialize planning framework for an existing project: codebase mapping → questioning → domain model → requirements → roadmap.

Focus: $ARGUMENTS

Use this when you have an existing codebase and want to add structured planning. For greenfield projects, use `/new-project` instead.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Steps
1. Run `draht-tools init` to check preconditions (git repo, etc.)
2. Run `draht-tools map-codebase` to build a structural map of the existing code, then `draht-tools map-graph` to produce `.planning/codebase/MAP.json` + `GRAPH_REPORT.md` (map-codebase alone does NOT emit MAP.json)
3. Analyze the codebase map to understand architecture, tech stack, and conventions: read `.planning/codebase/MAP.json` and run `draht-tools graph-hotspots` + `draht-tools graph-clusters` to surface high-traffic and cohesive modules
4. Deep questioning phase (3-7 rounds, 1-2 questions at a time):
   - What is this project? Who uses it?
   - What are the current pain points or goals?
   - What is MVP vs aspirational scope?
   - What constraints exist (infra, team size, deadlines)?
5. Run `draht-tools create-project` with gathered info
6. Run `draht-tools create-domain-model` to define bounded contexts, entities, and ubiquitous language
7. Create `.planning/DOMAIN.md` with the same sections as `/new-project`:
   Bounded Contexts, Ubiquitous Language, Context Map, Aggregates, Domain Events.
   Seed the Ubiquitous Language glossary from `GRAPH_REPORT.md` key concepts / `modules[*].symbols` (start from extracted terms, not zero)
8. Create `.planning/TEST-STRATEGY.md` with: Test Framework, Directory Conventions, Coverage Goals, Testing Levels, Excluded
9. Optional research phase via `draht-tools research`
10. Run `draht-tools create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
11. Run `draht-tools create-roadmap` with phases
12. Run `draht-tools init-state`
13. Git commit via `draht-tools commit-docs "initialize project planning"`

## Workflow
After project initialization, phases are executed one at a time in fresh sessions:

```
/init-project → /discuss-phase 1 → /plan-phase 1 → /execute-phase 1 → /verify-work 1
              → ... (repeat for all phases in the milestone)
              → /next-milestone (only after ALL phases are complete)
```

## Rules
- Ask 1-2 questions at a time, never dump 10 at once
- When the focus names a solution ("migrate to X"), ask what problem it solves — the existing code may admit a smaller answer
- Respect what already exists — do not propose rewriting working code
- Stop when you have: current state, goals, MVP scope, constraints, success criteria
