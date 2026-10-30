# Changelog

## [Unreleased]

### Added

- `kg` engine (`bin/draht-kg.cjs`): graphify-parity **symbol-level** knowledge graph — deterministic indexer (`kg build` → `graph.json` in graphify's node-link schema + `KG_REPORT.md`), graphify query semantics (`kg query` seed-scored BFS/DFS traversal with NODE/EDGE output, `kg explain`, `kg path`, `kg affected`), and exports (`kg export tree|wiki|graphml`) ([#2](https://github.com/draht-dev/draht/pull/2))
- graphify parity for the living map: barrel re-exports (`export { X } from`, multi-line blocks, `export * from` with `via` provenance) now populate each barrel's exports/symbols; MAP.html gains the Insights view (clusters, hotspots, surprising connections, rationale highlights; keyboard `i`) ([#2](https://github.com/draht-dev/draht/pull/2))
- knowledge-graph regression tests (`test/graph.test.mjs`): barrel extraction, star expansion, deterministic rebuild, unique cluster labels, query recall, impact output, Insights embed ([#2](https://github.com/draht-dev/draht/pull/2))

### Fixed

- graph-query recall: term coverage is scored at the module level with coverage² scaling (was a per-symbol AND that missed multi-word concepts); tests are demoted below the code they test ([#2](https://github.com/draht-dev/draht/pull/2))
- graph-impact echoes full resolved paths and explains zero-impact barrels instead of printing a bare `index.ts — 0 modules` ([#2](https://github.com/draht-dev/draht/pull/2))
- graph-clusters labels are unique and descriptive (dominant layer / ordinal suffixes instead of six identical `packages/ai` rows) ([#2](https://github.com/draht-dev/draht/pull/2))
- MAP.html search covers `modules[*].symbols` (non-exported declarations and barrel APIs), not just the exported-only symbolIndex ([#2](https://github.com/draht-dev/draht/pull/2))
- deterministic tie-break on surprising-connection ordering (`score desc, from asc, to asc`) ([#2](https://github.com/draht-dev/draht/pull/2))
- commented-out `export { X } from` examples no longer count as exports (content-level export passes match a comment-masked copy), and a bare `export *` no longer forwards the target's `default` export ([#2](https://github.com/draht-dev/draht/pull/2))
