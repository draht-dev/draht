# Changelog

## [Unreleased]

### Added

- `install-graph-engine` (alias `graph-engine`) command that fetches the prebuilt Go `draht-graph` knowledge-graph engine binary; `map-graph`/`graph-*`/`map-codebase` now dispatch to it automatically when present (`DRAHT_GRAPH_ENGINE=auto`, the default), falling back to the built-in JS engine otherwise — see `go/README.md` and `.planning/kg-integration/SPEC.md`
- `--no-graph-engine` install flag and `DRAHT_SKIP_GRAPH_ENGINE` env var to skip the automatic fetch

## [2026.7.12] - 2026-07-12

### Changed

- migrate workspace checks to TypeScript 7

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
