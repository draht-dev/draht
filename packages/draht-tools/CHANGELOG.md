# Changelog

## [Unreleased]

### Added

- `kg` engine (`bin/draht-kg.cjs`): graphify-parity **symbol-level** knowledge graph — deterministic indexer (`kg build` → `graph.json` in graphify's node-link schema + `KG_REPORT.md`), graphify query semantics (`kg query` seed-scored BFS/DFS traversal with NODE/EDGE output, `kg explain`, `kg path`, `kg affected`), and exports (`kg export tree|wiki|graphml`)
- graphify parity for the living map: barrel re-exports (`export { X } from`, multi-line blocks, `export * from` with `via` provenance) now populate each barrel's exports/symbols; MAP.html gains the Insights view (clusters, hotspots, surprising connections, rationale highlights; keyboard `i`)
- knowledge-graph regression tests (`test/graph.test.mjs`): barrel extraction, star expansion, deterministic rebuild, unique cluster labels, query recall, impact output, Insights embed

### Fixed

- graph-query recall: term coverage is scored at the module level with coverage² scaling (was a per-symbol AND that missed multi-word concepts); tests are demoted below the code they test
- graph-impact echoes full resolved paths and explains zero-impact barrels instead of printing a bare `index.ts — 0 modules`
- graph-clusters labels are unique and descriptive (dominant layer / ordinal suffixes instead of six identical `packages/ai` rows)
- MAP.html search covers `modules[*].symbols` (non-exported declarations and barrel APIs), not just the exported-only symbolIndex
- deterministic tie-break on surprising-connection ordering (`score desc, from asc, to asc`)
