---
description: Analyze existing codebase before planning — extract architecture, domain model, and test strategy
argument-hint: "[directory]"
allowed-tools: Bash, Read, Write, Edit, Task, Grep, Glob
---

# /map-codebase

Analyze existing codebase before planning, using subagents for parallel analysis.

Directory: $1

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>`. For subagents, use the **Task tool** with `subagent_type` matching the agent name (e.g. `architect`, `verifier`).

## Atomic Reasoning

Before analyzing, decompose codebase understanding into atomic reasoning units:

**For each architectural layer:**
1. **State the logical component** — What is this directory/module's responsibility? What concepts does it encapsulate?
2. **Validate independence** — Is this a bounded context? What are its dependencies? Does it leak abstractions across boundaries?
3. **Verify correctness** — What domain terms appear in code? What aggregates exist? What test infrastructure is present?

**Synthesize analysis strategy:**
- Map directory structure to bounded contexts
- Extract domain language from identifiers (classes, functions, types)
- Identify context relationships (upstream/downstream, shared kernel)
- Document test strategy and coverage
- Note architectural concerns and patterns

## Steps
1. Run `draht-tools map-codebase $1`
2. Tool generates: STACK.md, ARCHITECTURE.md, CONVENTIONS.md, CONCERNS.md

3. **Run parallel deep analysis via the Task tool**:
   Dispatch these two subagents in parallel (single assistant turn, two Task tool calls):

   - **Task tool** with `subagent_type: "architect"` and prompt:
     "Analyze the codebase at $1. Identify bounded contexts from directory structure — look for top-level src/ subdirectories, packages, or modules that encapsulate coherent domain concepts. Note any cross-directory coupling suggesting blurred context boundaries. Extract domain language: collect PascalCase class/interface/type names, key function names, database table/collection names. Look for repeated nouns representing core domain concepts. Output a structured list of: bounded contexts (name + description), domain terms (glossary), aggregates per context, and context relationships (upstream/downstream, shared kernel, ACL)."

   - **Task tool** with `subagent_type: "verifier"` and prompt:
     "Analyze the test infrastructure at $1. Discover: test framework(s) in use (check package.json, config files), test directory conventions (co-located, __tests__/, test/), existing coverage configuration and goals, which layers have tests (unit, integration, e2e), gaps and recommendations. Output a structured test strategy report."

4. Collect subagent results and merge with the draht-tools output
5. Create `.planning/DOMAIN.md` (if it doesn't exist) with:
   - `## Bounded Contexts` — one entry per discovered context with a brief description
   - `## Ubiquitous Language` — glossary of extracted domain terms
   - `## Context Map` — how bounded contexts relate (upstream/downstream, shared kernel, ACL)
   - `## Aggregates` — aggregates and their root entities per context
   - `## Domain Events` — any existing event names or patterns discovered
6. Create `.planning/TEST-STRATEGY.md` with: Test Framework, Directory Conventions, Coverage Goals, Testing Levels, Excluded
7. Commit: `draht-tools commit-docs "map existing codebase"`
