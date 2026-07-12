# Changelog

## [Unreleased]

### Added

- graphify parity for the living map: barrel re-exports (`export { X } from`, multi-line blocks, `export * from` with `via` provenance) now populate each barrel's exports/symbols; MAP.html gains the Insights view (clusters, hotspots, surprising connections, rationale highlights; keyboard `i`)

### Fixed

- graph-query recall: term coverage is scored at the module level with coverage² scaling (was a per-symbol AND that missed multi-word concepts); tests are demoted below the code they test
- graph-impact echoes full resolved paths and explains zero-impact barrels instead of printing a bare `index.ts — 0 modules`
- graph-clusters labels are unique and descriptive (dominant layer / ordinal suffixes instead of six identical `packages/ai` rows)
- MAP.html search covers `modules[*].symbols` (non-exported declarations and barrel APIs), not just the exported-only symbolIndex

## [2026.7.11] - 2026-07-11

### Added

- add advisor agent, loop mode, and model-tiering guidance
- overhaul map-graph clustering, MAP.html viewer, map-serve
- pin reviewer and spec-reviewer to opus
- lessons accumulation and standing-spec digest per session
- enforce quality gates in the harness, not prose

### Changed

- reference advisor and model-tiering in stall guidance

### Fixed

- keep plugin manifests in lockstep with package version

## [2026.7.7-1] - 2026-07-07

### Added

- mirror operating-manual weave into agents, commands, skills

## [2026.6.11] - 2026-06-11

### Added

- add Concepts, Knowledge Graph, and Calls views to MAP.html
- wire knowledge-graph steps into GSD workflow commands and skills
- add graphify-style knowledge graph engine and query CLI
- expose command prompts as Codex skill wrappers
- add Draht GSD workflows as a Codex plugin

### Fixed

- deepen flow extraction so entries stop dead-ending
