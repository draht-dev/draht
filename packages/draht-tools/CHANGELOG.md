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
- commented-out `export { X } from` examples no longer count as exports (content-level export passes match a comment-masked copy), and a bare `export *` no longer forwards the target's `default` export — including named default declarations (`export default class Widget {}` classifies as `default`, not `Widget`; the local name still appears as a non-exported symbol so search finds the defining file) ([#2](https://github.com/draht-dev/draht/pull/2))
- star expansion drops names exported ambiguously by two star targets with different origins (ES spec); the same origin reached through different chains stays ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` engine correctness: brace depth is counted on a string/comment-masked copy so a `{` in a literal no longer hides later declarations; call regions end at the tracked body end instead of the next declaration; `this.method()` binds to the enclosing class only; renamed default imports resolve to the target's default declaration; imports and calls through barrels follow re-export bindings (aliases, stars, cycle-guarded); `ns.member()` calls through namespace imports are recorded; `kg query` prints edges in stored direction and includes edges between seeds; `kg report`/`kg export wiki` rebuild community members from a loaded graph; id collisions (graphify ids.py canonicalization) are surfaced as a build warning ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` engine parsing: object types in function headers no longer end the call region early; imports are scanned on a comment-masked copy so commented-out examples are not dependencies; `implements` captures the full interface list (and generic classes still parse); `import type X from` is recorded; wiki god-node pages are named by unique node id, length-bounded with a stable hash suffix. Living map: named re-export entries resolve to their defining origin (`via`, plus `viaName` when aliased) before star expansion, so the same binding reached through a named re-exporter and its definer is one export — while a renamed binding (`export { b as a } from`) colliding with the origin's own `a` stays ambiguous ([#2](https://github.com/draht-dev/draht/pull/2))
