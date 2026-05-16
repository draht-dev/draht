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
| `map-graph [dir]` | Generate `.planning/codebase/MAP.json` + `MAP.html` — the **living map** |
| `map-serve [port]` | HTTP server with live reload — open the map in a browser and watch it update as you code |
| `init` / `create-project` / `create-roadmap` / … | Planning scaffolding (see `help`) |

## Living architecture map

`map-graph` builds an interactive **architecture** map of your codebase — not just stats:

- **MAP.json** — entry points (CLI bins, HTTP routes, library main exports), sinks (FS / net / DB / stdout / exec calls), bounded contexts (packages), cross-package dataflow edges, symbol-resolved call edges, flows (which sinks each entry reaches and through which module), per-module architectural layer (presentation / application / domain / infrastructure / support), exports and imports per file. Used by humans **and by agents** starting a new task: read it once and you know how the software actually works.
- **MAP.html** — three layered views:
  - **System** — packages as containers in horizontal layer bands; cross-package dataflow drawn as arrows (thickness = import count).
  - **Modules** — every file inside its package container; click a package or sink to highlight its subgraph.
  - **Flows** — entry points on top, sinks on bottom, intermediate modules ranked by depth. Pick an entry → trace which sinks it reaches and through which module.

The map regenerates on every file save in `map-serve` mode (`fs.watch` + Server-Sent Events). No need to write architecture docs by hand — the map is always current.

## Architecture

Self-contained CommonJS, zero runtime dependencies, Node ≥20. Loads only `node:fs`, `node:path`, `node:child_process`, `node:http`.
