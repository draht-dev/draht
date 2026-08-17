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
2. Tool generates the prose docs (STACK.md, ARCHITECTURE.md, CONVENTIONS.md, CONCERNS.md, DOMAIN-HINTS.md) **and**, in the same pass, the **living architecture map** (MAP.json + MAP.html + GRAPH_REPORT.md).
2a. The living architecture map produced by step 1 (re-run `draht-tools map-graph $1` any time to refresh just the map without rewriting the docs):
   - `.planning/codebase/MAP.json` — machine-readable map with **entry points** (CLI bins, HTTP routes, library main exports), **sinks** (FS / net / DB / stdout / exec calls), **bounded contexts** (packages), **cross-package dataflow edges**, **symbol-resolved call edges**, **flows** (which sinks each entry point reaches and through which intermediate module), per-module **layer** (presentation / application / domain / infrastructure / support), and exports/imports per file. Agents starting a new task should read MAP.json first instead of re-scanning the tree.
   - `.planning/codebase/MAP.html` — interactive layered visualization with four views:
     - **Architecture** — packages drawn as containers in architectural layers, with cross-package dataflow arrows. Thickness encodes import count.
     - **Modules** — every file inside its package container, import edges between them; click a package or sink to highlight.
     - **Flow Trace** — entry points on top, sinks on bottom, intermediate modules ranked by depth from entry. Click an entry point to trace which sinks it reaches.
     - **Insights** — graphify-style knowledge graph: clusters (label-propagation communities), god-nodes (high-degree hotspots), and surprising cross-cluster edges.
     Open directly, or run `draht-tools map-serve` for a live-reloading dev view (regenerates on every file save).

3. **Run parallel deep analysis via the Task tool**:
   Dispatch these two subagents in parallel (single assistant turn, two Task tool calls):

   - **Task tool** with `subagent_type: "architect"` and prompt:
     "Analyze the codebase at $1. Identify bounded contexts from directory structure — look for top-level src/ subdirectories, packages, or modules that encapsulate coherent domain concepts. Note any cross-directory coupling suggesting blurred context boundaries. Extract domain language: collect PascalCase class/interface/type names, key function names, database table/collection names. Look for repeated nouns representing core domain concepts. Output a structured list of: bounded contexts (name + description), domain terms (glossary), aggregates per context, and context relationships (upstream/downstream, shared kernel, ACL).

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`."

   - **Task tool** with `subagent_type: "verifier"` and prompt:
     "Analyze the test infrastructure at $1. Discover: test framework(s) in use (check package.json, config files), test directory conventions (co-located, __tests__/, test/), existing coverage configuration and goals, which layers have tests (unit, integration, e2e), gaps and recommendations. Output a structured test strategy report.

     End with `STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`."

4. Read each subagent's `STATUS:` line. `BLOCKED` or `NEEDS_CONTEXT` from either means STOP — `map-codebase` produces foundational artifacts and partial output here causes downstream confusion. Collect subagent results and merge with the draht-tools output.
5. Create `.planning/DOMAIN.md` (if it doesn't exist). Everything in it is **inferred from code, not confirmed by the user** — mark uncertain context boundaries and ambiguous terms as `(inferred)` so later commands know to confirm rather than build on them. With:
   - `## Bounded Contexts` — one entry per discovered context with a brief description
   - `## Ubiquitous Language` — glossary of extracted domain terms
   - `## Context Map` — how bounded contexts relate (upstream/downstream, shared kernel, ACL)
   - `## Aggregates` — aggregates and their root entities per context
   - `## Domain Events` — any existing event names or patterns discovered
6. Create `.planning/TEST-STRATEGY.md` with: Test Framework, Directory Conventions, Coverage Goals, Testing Levels, Excluded
7. Commit: `draht-tools commit-docs "map existing codebase"`

## Living map for agents

Step 2a also writes `.planning/codebase/GRAPH_REPORT.md` — the **primary skimmable artifact**: key concepts (clusters), god nodes, surprising connections, and suggested questions. Read it first for orientation.
- The `MAP.json` is the machine-readable source of truth — now also carrying **clusters**, **hotspots**, **surprisingConnections**, **rationaleIndex**, per-module **symbols**, and edge **confidence** fields.
- Instead of walking the tree, agents orient with `draht-tools graph-context <file>`, `graph-impact <file>`, `graph-query "<concept>"`, `graph-callers`/`graph-callees`, `graph-path <from> <to>`, `graph-hotspots`, and `graph-clusters`.
- MAP.html gains an **Insights** view (clusters, god-nodes, surprising edges) alongside System / Modules / Flows.
- It is regenerated every time `map-codebase`, `map-graph`, or `map-serve` runs; run `draht-tools graph-hook install` to auto-refresh MAP.json on every commit.
- Developers can keep `draht-tools map-serve` running in a terminal — the HTML visualization updates live as files change, so architecture documentation is never stale.
