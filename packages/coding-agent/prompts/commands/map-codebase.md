---
description: "Analyze existing codebase before planning"
---

# /map-codebase

Analyze existing codebase before planning, using subagents for parallel analysis.

## Usage
```
/map-codebase [directory]
```

Directory: $1

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
3. **Run parallel deep analysis via subagents:**
   Use the `subagent` tool in **parallel mode** with these tasks:
   - `architect` agent: "Analyze the codebase at $1. Identify bounded contexts from directory structure — look for top-level src/ subdirectories, packages, or modules that encapsulate coherent domain concepts. Note any cross-directory coupling suggesting blurred context boundaries. Extract domain language: collect PascalCase class/interface/type names, key function names, database table/collection names. Look for repeated nouns representing core domain concepts. Output a structured list of: bounded contexts (name + description), domain terms (glossary), aggregates per context, and context relationships (upstream/downstream, shared kernel, ACL). Do NOT run draht, draht-tools, or pi commands."
   - `verifier` agent: "Analyze the test infrastructure at $1. Discover: test framework(s) in use (check package.json, config files), test directory conventions (co-located, __tests__/, test/), existing coverage configuration and goals, which layers have tests (unit, integration, e2e), gaps and recommendations. Output a structured test strategy report. Do NOT run draht, draht-tools, or pi commands."

4. Collect subagent results and merge with the draht-tools output
5. Create `.planning/DOMAIN.md` (if it doesn't exist) with:
   - `## Bounded Contexts` — one entry per discovered context with a brief description
   - `## Ubiquitous Language` — glossary of extracted domain terms
   - `## Context Map` — how bounded contexts relate (upstream/downstream, shared kernel, ACL)
   - `## Aggregates` — aggregates and their root entities per context
   - `## Domain Events` — any existing event names or patterns discovered
6. Create `.planning/TEST-STRATEGY.md` with:
   - `## Test Framework` — chosen framework and rationale
   - `## Directory Conventions` — where test files live relative to source
   - `## Coverage Goals` — target coverage percentage and which paths are critical
   - `## Testing Levels` — what is tested at unit level vs integration vs e2e, with examples
   - `## Excluded` — what is explicitly not tested and why
7. Commit: `draht-tools commit-docs "map existing codebase"`
