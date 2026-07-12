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
1. Run `draht-tools map-codebase $1` (graph artifacts are always whole-repo — see below)
2. Tool generates: STACK.md, ARCHITECTURE.md, CONVENTIONS.md, CONCERNS.md
2a. Run `draht-tools map-graph` to produce the **living architecture map**. The graph always maps the whole repository from the git root, regardless of any directory argument — the tool enforces this deterministically; a directory argument only scopes the narrative analysis in step 3, not the graph itself.
   - `.planning/codebase/MAP.json` — machine-readable map with **entry points** (CLI bins, HTTP routes, library main exports), **sinks** (FS / net / DB / stdout / exec calls), **bounded contexts** (packages), **cross-package dataflow edges**, **symbol-resolved call edges**, **flows** (which sinks each entry point reaches and through which intermediate module), per-module **layer** (presentation / application / domain / infrastructure / support), and exports/imports per file. Agents starting a new task should read MAP.json first instead of re-scanning the tree.
   - `.planning/codebase/MAP.html` — interactive visualization with four tabs:
     - **Graph** — the primary interactive force-directed knowledge graph: nodes colored by cluster and sized by degree; click a node for an inspector (file, symbols, importers, callers); search plus filters for layer / cluster / edge-confidence (EXTRACTED/INFERRED/AMBIGUOUS); legend; PNG/SVG export; double-click a cluster to expand/collapse it.
     - **Architecture** — package containers in layer bands with cross-package dataflow arrows.
     - **Flows** — entry points on top, sinks on bottom, intermediate modules ranked by depth from entry. Click an entry point to trace which sinks it reaches.
     - **Insights** — the graphify-style "read this first" panel: clusters table, god nodes / most-depended-on / orchestrators, surprising connections, and SECURITY/BUG/FIXME/HACK rationale highlights — every row click-through to the inspector.
     Open `MAP.html` directly via `file://` — the data is embedded inline so it works fully offline — or run `draht-tools map-serve` for a live-reloading dev view (regenerates on every code-file save (docs/asset saves are ignored by design), via SSE).
2b. Run `draht-tools kg build` for the **symbol-level** knowledge graph (graphify-parity engine, fully deterministic — no LLM). Produces `.planning/codebase/graph.json` (nodes = functions/classes/types with calls/inherits/imports edges + EXTRACTED/INFERRED/AMBIGUOUS confidence) and `KG_REPORT.md` (god nodes, communities, surprising connections, suggested questions). Query it with `draht-tools kg query "<question>"` (subgraph traversal), `kg explain "<symbol>"`, `kg path "<a>" "<b>"`, `kg affected "<symbol>"`.
3. **Run parallel deep analysis via subagents:**
   Use the `subagent` tool in **parallel mode** with these tasks:
   - `architect` agent: "Analyze the codebase at $1. Identify bounded contexts from directory structure — look for top-level src/ subdirectories, packages, or modules that encapsulate coherent domain concepts. Note any cross-directory coupling suggesting blurred context boundaries. Extract domain language: collect PascalCase class/interface/type names, key function names, database table/collection names. Look for repeated nouns representing core domain concepts. Output a structured list of: bounded contexts (name + description), domain terms (glossary), aggregates per context, and context relationships (upstream/downstream, shared kernel, ACL). End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. Do NOT run draht, draht-tools, or pi commands."
   - `verifier` agent: "Analyze the test infrastructure at $1. Discover: test framework(s) in use, test directory conventions, existing coverage configuration and goals, which layers have tests (unit, integration, e2e), gaps and recommendations. Output a structured test strategy report. End with `STATUS: ...`. Do NOT run draht, draht-tools, or pi commands."

4. Read each subagent's `STATUS:` line. `BLOCKED` or `NEEDS_CONTEXT` from either means STOP — partial output here corrupts downstream phases. Collect subagent results and merge with the draht-tools output.
5. Create `.planning/DOMAIN.md` (if it doesn't exist). Everything in it is **inferred from code, not confirmed by the user** — mark uncertain context boundaries and ambiguous terms as `(inferred)` so later commands know to confirm rather than build on them. With:
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

The `MAP.json` produced in step 2a is the single source of truth for "what's in this codebase". It is always the **whole-repo** map — `map-graph` maps from the git root regardless of where it's invoked or what directory argument is passed:
- Subagents that need orientation should read `.planning/codebase/MAP.json` before walking the file tree, even when working from a subdirectory — they get the full map via the `graph-*` commands, not a scoped one.
- It is regenerated every time `map-codebase`, `map-graph`, or `map-serve` runs, so it stays current with the code.
- Developers can keep `draht-tools map-serve` running in a terminal — the HTML visualization updates live as files change, so architecture documentation is never stale.
