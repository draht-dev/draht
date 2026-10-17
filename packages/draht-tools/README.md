# @draht/tools

Canonical CLI for the Draht **Get Shit Done** methodology.

This package is the single source of truth for the `draht-tools` binary used by:
- [`draht-claude`](../draht-claude) — Claude Code plugin
- [`@draht/coding-agent`](../coding-agent) — Coding agent CLI

Both consumer packages copy `bin/draht-tools.cjs` into their own `bin/` during build / publish so the resulting npm tarballs remain self-contained.

## Commands

Run `draht-tools help` for the full list. Highlights:

| Command | What it does |
|---|---|
| `map-codebase [dir]` | Generate `.planning/codebase/*.md` from the current repo |
| `map-graph [dir] [--quiet]` | Generate `.planning/codebase/MAP.json` + `MAP.html` + `GRAPH_REPORT.md` — the **living map** (`--quiet` = JSON + report only, for hooks) |
| `map-serve [port]` | HTTP server with live reload — open the map in a browser and watch it update as you code |
| `graph-context <file…>` | Where a file sits: package, layer, cluster, importers/imports, sinks, rationale |
| `graph-impact <file…>` | Blast radius: reverse-dependents, entry points reached, downstream sinks, boundary warnings |
| `graph-query <term…>` | Ranked symbol + doc search — replaces `grep` for "find the X" |
| `graph-callers` / `graph-callees <file>` | Who calls / what it calls (N hops via `--depth`) |
| `graph-path <from> <to>` | Shortest import path between two files |
| `graph-hotspots` / `graph-clusters [--surprising]` | God-nodes / structural neighborhoods + surprising connections |
| `graph-hook install\|uninstall\|status` | Git post-commit hook that refreshes the map |
| `kg build` | **Symbol-level** knowledge graph (graphify-parity engine) → `graph.json` + `KG_REPORT.md` |
| `kg query "<question>"` | BFS/DFS subgraph traversal from scored seeds — graphify's `NODE`/`EDGE` output |
| `kg explain` / `kg path` / `kg affected` | Node dump · shortest path with relation arrows · reverse blast-radius |
| `kg export tree\|wiki\|graphml` | Collapsible module tree HTML / wiki articles / GraphML |
| `init` / `create-project` / `create-roadmap` / … | Planning scaffolding (see `help`) |

All `graph-*` commands are **read-only** (never mutate `MAP.json`), print concise text by default (`--json` for machine output), and degrade gracefully when no map exists (`run map-graph first`).

## Living architecture map

`map-graph` builds an interactive, graphify-style **knowledge graph** of your codebase — not just stats:

- **MAP.json** (schemaVersion 5) — entry points (CLI bins, HTTP routes, library main exports), sinks (FS / net / DB / stdout / exec calls), bounded contexts (packages), cross-package dataflow edges, symbol-resolved call edges, flows, per-module architectural layer (presentation / application / domain / infrastructure / support), exports and imports per file — **plus**: `symbols` (symbol-level nodes with line numbers), `clusters` (deterministic label-propagation neighborhoods) + per-module `cluster`, `hotspots` (god-nodes / most-depended-on / orchestrators / largest), `surprisingConnections` (bridge / cross-group / layer-violating edges), `rationaleIndex` (inline `NOTE`/`WHY`/`HACK`/`TODO`/`FIXME`/`SECURITY` notes), and `EXTRACTED` / `INFERRED` / `AMBIGUOUS` confidence on every edge. Barrel files are first-class: `export { X } from './y'`, multi-line export blocks, and `export * from './y'` (expanded from the resolved target, with `via` provenance) all populate the barrel's own `exports`/`symbols`, so a package's public API is visible on its `index.ts`. Only code-language files become `modules` — docs/config/lockfiles/images etc. are excluded from the module graph (to keep imports/clusters/hotspots free of non-code noise) but still show up in `stats.languages` and are still scanned for `rationaleIndex` notes. Read once and you know how the software actually works — or query it with the `graph-*` commands instead of grepping.
- **GRAPH_REPORT.md** — a deterministic, skimmable narrative: overview, key concepts (top clusters), god nodes, surprising connections, rationale highlights, and templated suggested questions. The one page to read first.
- **MAP.html** — an interactive viewer with four tabs:
  - **Graph** — the interactive force-directed canvas graph: nodes colored by cluster and sized by degree, collapsed to one supernode per cluster by default; search, layer/cluster/edge-confidence filters, an inspector (file, symbols, importers, callers), and PNG/SVG export.
  - **Architecture** — package containers in layer bands with cross-package dataflow arrows (thickness = import count); click a package for detail, double-click a group header to focus.
  - **Flows** — entry points on top, sinks on bottom, intermediate modules ranked by depth. Pick an entry → trace which sinks it reaches and through which module.
  - **Insights** — the graphify-style "read this first" panel: clusters table, god nodes / most-depended-on / orchestrators, surprising connections, and SECURITY/BUG/FIXME/HACK rationale highlights, all click-through to the inspector (keyboard: `i`).

  `MAP.html` embeds the map data inline, so it works fully offline via `file://` — no server needed. Run `draht-tools map-serve` instead for a live-reloading dev view that pushes updates over SSE as you edit.

`map-graph` and `map-codebase` always map the **whole repository** from the git root, regardless of any `[dir]` argument — a directory argument only scopes the narrative analysis (`map-codebase`'s STACK/ARCHITECTURE/CONVENTIONS/CONCERNS docs), never the graph itself. The map regenerates on every code-file save (docs/asset saves are ignored by design) in `map-serve` mode (`fs.watch` + Server-Sent Events), and on every commit if you `graph-hook install`. The build is **deterministic** (git-committable) and writes are idempotent — a no-op rebuild produces zero diff. No need to write architecture docs by hand — the map is always current.

## Two engines, both deterministic (no LLM anywhere in indexing)

| | `map-graph` (living map) | `kg` (graphify-parity engine, `bin/draht-kg.cjs`) |
|---|---|---|
| Nodes | modules (files) with symbols as attributes | **symbols**: files, classes, `functions()`, `methods()`, types |
| Edges | import / re-export / external + call heuristics | graphify's relation set: `imports`, `imports_from`, `re_exports`, `dynamic_import`, `contains`, `defines`, `method`, `calls`, `indirect_call`, `inherits`, `implements`, `extends`, `instantiates` |
| Confidence | per-edge tag | tag **+ `confidence_score`** (EXTRACTED 1.0 · INFERRED 0.8 calls · AMBIGUOUS 0.2), graphify's rubric |
| IDs | file paths | graphify `ids.py` canonicalization (NFKC → `_` → casefold), e.g. `packages_router_src_router_modelrouter` |
| Query | ranked search (`graph-query`) | **subgraph traversal** (`kg query`): scored seeds → BFS/DFS with p99-degree hub guard → `NODE`/`EDGE` lines under a token budget |
| Output | MAP.json (schema v6) + MAP.html + GRAPH_REPORT.md | `graph.json` (node-link, loadable by graphify's own tooling) + KG_REPORT.md + GRAPH_TREE.html/wiki/GraphML |

Both engines are pure deterministic JS — the LLM is only involved in the *narrative* docs
(`map-codebase`'s STACK/ARCHITECTURE/…), never in indexing. Rebuilds are byte-identical
(regression-tested), so both graphs are safe to commit or regenerate from hooks.

## Querying the graph (instead of grepping)

The `graph-*` commands let agents (and you) orient without walking the tree:

```sh
draht-tools graph-context src/auth/session.ts   # package · layer · cluster · callers · sinks
draht-tools graph-impact  src/auth/session.ts   # what breaks if I change this
draht-tools graph-query   auth storage          # find the symbol/concept (ranked, no grep)
draht-tools graph-path    a.ts b.ts             # how does A reach B
draht-tools graph-clusters --surprising         # neighborhoods + anomalous edges
```

## Architecture

Self-contained CommonJS, zero runtime dependencies, Node ≥20. Loads only `node:fs`, `node:path`, `node:child_process`, `node:http`.
