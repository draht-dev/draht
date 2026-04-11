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

Before initializing, decompose project understanding into atomic reasoning units:

**For each aspect of the existing project:**
1. **State the logical component** — What does this project do? Who are the users? What problems does it solve?
2. **Validate independence** — What bounded contexts exist in the code? What domain concepts are already present? Can they be separated cleanly?
3. **Verify correctness** — What works well that we must preserve? What pain points exist? What constraints limit changes?

**Synthesize initialization strategy:**
- Map existing architecture and conventions
- Extract domain model from code (bounded contexts, aggregates, ubiquitous language)
- Identify test strategy and coverage
- Define requirements that align with existing structure
- Create roadmap that respects what already works

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
7. Create `.planning/DOMAIN.md` with the same sections as `/new-project`:
   Bounded Contexts, Ubiquitous Language, Context Map, Aggregates, Domain Events
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
- Respect what already exists — do not propose rewriting working code
- Stop when you have: current state, goals, MVP scope, constraints, success criteria
