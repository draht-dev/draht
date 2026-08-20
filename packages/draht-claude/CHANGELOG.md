# Changelog

## [Unreleased]

### Added

- `install-graph-engine` (alias `graph-engine`) command that fetches the prebuilt Go `draht-graph` knowledge-graph engine binary; `map-graph`/`graph-*`/`map-codebase` now dispatch to it automatically when present (`DRAHT_GRAPH_ENGINE=auto`, the default), falling back to the built-in JS engine otherwise — see `go/README.md` and `.planning/kg-integration/SPEC.md`
- `--no-graph-engine` install flag and `DRAHT_SKIP_GRAPH_ENGINE` env var to skip the automatic fetch
- portable `cinematic-continuation` skill with bundled style/continuity references, a neutral sequence template, Seedance adapter boundary, and offline timeline compiler

### Changed

- pruned the boilerplate Atomic Reasoning section from all generated command templates; commands keep only command-specific reasoning plus a one-line pointer to the `atomic-reasoning` skill (already shipped in this plugin's skills/)

### Fixed

- implementer agent TDD commit prefixes now follow the enforced `red:`/`green:`/`refactor:` convention (previously `test:`/`feat:`, which the gsd-post-task hook's `red:`/`green:` cycle check could never match)

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

- fix YAML parse error in advisor agent frontmatter
- force-refresh plugin copy on reinstall
- keep plugin manifests in lockstep with package version

## [2026.7.7-1] - 2026-07-07

### Added

- mirror operating-manual weave into agents, commands, skills

## [2026.6.11] - 2026-06-11

### Added

- add Concepts, Knowledge Graph, and Calls views to MAP.html
- wire knowledge-graph steps into GSD workflow commands and skills
- add graphify-style knowledge graph engine and query CLI
- introduce @draht/tools package with map-graph and map-serve commands

### Changed

- extend map-codebase prompt with map-graph and map-serve usage

### Fixed

- deepen flow extraction so entries stop dead-ending

## [2026.5.12] - 2026-05-12

### Added

- flag plan placeholders and empty sections in validate-plans
- refresh gsd-workflow skill with subagent roster and STATUS protocol
- add verification-gate, brainstorming, debugging-workflow, atomic-reasoning skills
- integrate spec-reviewer, STATUS protocol, and Red Flag gates across commands
- rewrite /fix as 4-phase systematic debugging protocol
- add spec-reviewer agent for per-task spec compliance
- add STATUS protocol footer to all subagents
- add configure subcommand and agent model defaults

## [2026.4.25] - 2026-04-25

### Changed

- bump workspace version to 2026.4.25

## [2026.4.23] - 2026-04-23

### Added

- expand security-auditor with CVE checks and zero-day patterns
- add draht-claude plugin package
