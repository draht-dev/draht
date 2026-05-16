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
2a. Run `draht-tools map-graph $1` to produce the **living architecture map**:
   - `.planning/codebase/MAP.json` — machine-readable map with **entry points** (CLI bins, HTTP routes, library main exports), **sinks** (FS / net / DB / stdout / exec calls), **bounded contexts** (packages), **cross-package dataflow edges**, **symbol-resolved call edges**, **flows** (which sinks each entry point reaches and through which intermediate module), per-module **layer** (presentation / application / domain / infrastructure / support), and exports/imports per file. Agents starting a new task should read MAP.json first instead of re-scanning the tree.
   - `.planning/codebase/MAP.html` — interactive layered visualization with three views:
     - **System** — packages drawn as containers in architectural layers, with cross-package dataflow arrows. Thickness encodes import count.
     - **Modules** — every file inside its package container, import edges between them; click a package or sink to highlight.
     - **Flows** — entry points on top, sinks on bottom, intermediate modules ranked by depth from entry. Click an entry point to trace which sinks it reaches.
     Open directly, or run `draht-tools map-serve` for a live-reloading dev view (regenerates on every file save).
3. **Run parallel deep analysis via subagents:**
   Use the `subagent` tool in **parallel mode** with these tasks:
   - `architect` agent: "Analyze the codebase at $1. Identify bounded contexts from directory structure — look for top-level src/ subdirectories, packages, or modules that encapsulate coherent domain concepts. Note any cross-directory coupling suggesting blurred context boundaries. Extract domain language: collect PascalCase class/interface/type names, key function names, database table/collection names. Look for repeated nouns representing core domain concepts. Output a structured list of: bounded contexts (name + description), domain terms (glossary), aggregates per context, and context relationships (upstream/downstream, shared kernel, ACL). End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Do NOT run draht, draht-tools, or pi commands."
   - `verifier` agent: "Analyze the test infrastructure at $1. Discover: test framework(s) in use, test directory conventions, existing coverage configuration and goals, which layers have tests (unit, integration, e2e), gaps and recommendations. Output a structured test strategy report. End with `STATUS: ...`. Do NOT run draht, draht-tools, or pi commands."

4. Read each subagent's `STATUS:` line. `BLOCKED` or `NEEDS_CONTEXT` from either means STOP — partial output here corrupts downstream phases. Collect subagent results and merge with the draht-tools output.
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

## Living map for agents

The `MAP.json` produced in step 2a is the single source of truth for "what's in this codebase":
- Subagents that need orientation should read `.planning/codebase/MAP.json` before walking the file tree.
- It is regenerated every time `map-codebase`, `map-graph`, or `map-serve` runs, so it stays current with the code.
- Developers can keep `draht-tools map-serve` running in a terminal — the HTML visualization updates live as files change, so architecture documentation is never stale.
