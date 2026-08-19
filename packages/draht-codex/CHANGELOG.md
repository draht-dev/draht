# Changelog

## [Unreleased]

### Added

- `install-graph-engine` (alias `graph-engine`) command that fetches the prebuilt Go `draht-graph` knowledge-graph engine binary; `map-graph`/`graph-*`/`map-codebase` now dispatch to it automatically when present (`DRAHT_GRAPH_ENGINE=auto`, the default), falling back to the built-in JS engine otherwise — see `go/README.md` and `.planning/kg-integration/SPEC.md`
- `--no-graph-engine` install flag and `DRAHT_SKIP_GRAPH_ENGINE` env var to skip the automatic fetch
- portable `cinematic-continuation` skill with bundled style/continuity references, a neutral sequence template, Seedance adapter boundary, and offline timeline compiler

### Fixed

- plugin manifest version lockstep — `.codex-plugin/plugin.json` is now stamped by the automated release path (`setVersion` in `scripts/release-helpers.mjs`) as well as the manual `npm run version:*` path. The 2026.7.11 lockstep fix only patched the manual path, which the release pipeline never calls, so the manifest froze at `2026.7.7-1` while this package advanced from `2026.7.11` through `2026.7.30`. Both plugin manifests now read `2026.7.30`, matching their `package.json`
- the two writers remain separate — the manual path stamps manifests through `scripts/lib/version-stamp.mjs`, while the automated path stamps them from its own path list in `scripts/release-helpers.mjs` — so two gates make any future divergence loud: `scripts/check-draht-customizations.mjs` fails when `.codex-plugin/plugin.json` disagrees with this package's `package.json` version, and `assertReleaseVersions` re-reads every stamped surface after a release writes it

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
