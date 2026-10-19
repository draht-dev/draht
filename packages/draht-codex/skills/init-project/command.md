---
description: Initialize GSD planning for an existing project (codebase mapping → questioning → domain model → roadmap)
argument-hint: "[focus area]"
allowed-tools: Bash, Read, Write, Edit, Task
---

# /init-project

Initialize planning framework for an existing project: codebase mapping → questioning → domain model → requirements → roadmap.

Focus: $ARGUMENTS

Use this when you have an existing codebase and want to add structured planning. For greenfield projects, use `/new-project` instead.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Steps
1. Run `draht-tools init` to check preconditions (git repo, etc.)
2. Run `draht-tools map-codebase` to generate structural docs and the knowledge graph. If graph generation fails, retry with `draht-tools map-graph --quiet` before querying it
3. Read `.planning/codebase/GRAPH_REPORT.md` for architecture, tech stack, and conventions. Use `draht-tools graph-query <topic>` and `draht-tools graph-context <file...>` for focused detail; use `graph-hotspots` or `graph-clusters` when needed instead of reading the full `MAP.json`
4. Clarify material gaps in the problem, scope, constraints, and success criteria; use existing answers and repository evidence before asking:
   - What is this project? Who uses it?
   - What are the current pain points or goals?
   - What is MVP vs aspirational scope?
   - What constraints exist (infra, team size, deadlines)?
5. Run `draht-tools create-project` with gathered info
6. Run `draht-tools create-domain-model` to define bounded contexts, entities, and ubiquitous language
7. Create `.planning/DOMAIN.md` with the same sections as `/new-project`:
   Bounded Contexts, Ubiquitous Language, Context Map, Aggregates, Domain Events.
   Seed the Ubiquitous Language glossary from `GRAPH_REPORT.md` key concepts and focused `draht-tools graph-query <topic>` results (start from extracted terms, not zero)
8. Create `.planning/TEST-STRATEGY.md` with: Test Framework, Directory Conventions, Coverage Goals, Testing Levels, Excluded
9. If research is needed before defining requirements, investigate the open questions and save findings with sources under `.planning/research/<topic>.md`
10. Run `draht-tools create-requirements` with v1/v2/out-of-scope (map requirements to bounded contexts)
11. Run `draht-tools create-roadmap` with phases
12. Run `draht-tools init-state`
13. If committing is authorized, use `draht-tools commit-docs "initialize project planning"`

## Workflow
After project initialization, phases are executed one at a time in dependency order:

```
/init-project → /discuss-phase 1 → /plan-phase 1 → /execute-phase 1 → /verify-work 1
              → ... (repeat for all phases in the milestone)
              → /next-milestone (only after ALL phases are complete)
```

## Rules
- Group related questions and ask only those that change a material decision.
- Questions that depend on still-open answers wait for a later round
- Investigate repository facts directly; delegate independent research when useful.
- Respect explicit requirements; clarify the intended outcome when it is unclear.
- Respect what already exists — do not propose rewriting working code
- Stop when you have: current state, goals, MVP scope, constraints, success criteria
