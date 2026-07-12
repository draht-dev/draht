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
