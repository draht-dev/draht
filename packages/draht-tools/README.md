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
| `init` / `create-project` / `create-roadmap` / … | Planning scaffolding (see `help`) |

All `graph-*` commands are **read-only** (never mutate `MAP.json`), print concise text by default (`--json` for machine output), and degrade gracefully when no map exists (`run map-graph first`).

## Living architecture map

`map-graph` builds an interactive, graphify-style **knowledge graph** of your codebase — not just stats:

- **MAP.json** (schemaVersion 4) — entry points (CLI bins, HTTP routes, library main exports), sinks (FS / net / DB / stdout / exec calls), bounded contexts (packages), cross-package dataflow edges, symbol-resolved call edges, flows, per-module architectural layer (presentation / application / domain / infrastructure / support), exports and imports per file — **plus**: `symbols` (symbol-level nodes with line numbers), `clusters` (deterministic label-propagation neighborhoods) + per-module `cluster`, `hotspots` (god-nodes / most-depended-on / orchestrators / largest), `surprisingConnections` (bridge / cross-group / layer-violating edges), `rationaleIndex` (inline `NOTE`/`WHY`/`HACK`/`TODO`/`FIXME`/`SECURITY` notes), and `EXTRACTED` / `INFERRED` / `AMBIGUOUS` confidence on every edge. Read once and you know how the software actually works — or query it with the `graph-*` commands instead of grepping.
- **GRAPH_REPORT.md** — a deterministic, skimmable narrative: overview, key concepts (top clusters), god nodes, surprising connections, rationale highlights, and templated suggested questions. The one page to read first.
- **MAP.html** — four layered views:
  - **System** — packages as containers in horizontal layer bands; cross-package dataflow drawn as arrows (thickness = import count).
  - **Modules** — every file inside its package container; click a package or sink to highlight its subgraph.
  - **Flows** — entry points on top, sinks on bottom, intermediate modules ranked by depth. Pick an entry → trace which sinks it reaches and through which module.
  - **Insights** — modules colored by cluster, god-nodes enlarged, surprising connections drawn as hot edges. Hover any node for detail.

The map regenerates on every file save in `map-serve` mode (`fs.watch` + Server-Sent Events), and on every commit if you `graph-hook install`. The build is **deterministic** (git-committable) and writes are idempotent — a no-op rebuild produces zero diff. No need to write architecture docs by hand — the map is always current.

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
