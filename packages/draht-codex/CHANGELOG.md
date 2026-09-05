# Changelog

## [2026.9.5-1] - 2026-09-05

### Added

- judge the gates a session writes, not the decisions it made
- ship the judge queue and the draht status line
- add /triage external issue-report triage command skill
- add blast-radius impact-analysis discipline skill
- add /create-verification-skill command skill
- add typescript-discipline skill
- add epistemics discipline skill (confidence tiers for investigation findings)
- add unslop prose discipline skill
- /speak command + speaker subagent — ElevenLabs TTS voice output
- enforce comment discipline across code-writing and review surfaces
- question in whole-frontier rounds, not one at a time
- add versatile /grill frontier interrogation command
- hold fix-plan reproducing tests to the red-capable standard
- reproduction-first operating brief for the debugger agent
- reproduction-loop ladder and ranked hypotheses in debugging-workflow
- gate Phase 1 on a red-capable reproduction loop and rank Phase 3 hypotheses
- add resolve-conflicts command skill and prompt
- add Codex saga-spawner equivalent
- add cinematic continuation skill
- record symbol signatures behind --symbol-signatures
- add java, ruby and shell import resolution
- resolve python/go/rust imports behind --experimental-lang-edges
- Phase 4 — cross-platform build, release CI, and the opt-in Go engine cutover
- Phase 3 — GRAPH_REPORT.md, MAP.html viewer, and the graph-* commands
- Phase 2 — clustering, hotspots, containers, symbols, call graph, flows
- add Go knowledge-graph engine (Phase 1: AST, concurrency, incremental cache)

### Changed

- fix roster drift across plugin READMEs and install banner
- route /triage in the draht router and the /fix entry path
- route blast-radius in the draht router
- route create-verification-skill in the draht router
- route typescript-discipline in the draht router
- route /why against /fix, debugging-workflow, and the draht router
- route unslop in the draht router and fix the stale discipline count
- record this branch's unchangelogged user-visible changes
- fix agent and skill roster drift in plugin surfaces
- list orchestrate-loop and resolve-conflicts in plugin READMEs
- prune the Atomic Reasoning stamp from command skill sources
- correct the shipped skill, command and agent inventories
- preserve unified-installer partial state before rebase

### Fixed

- keep the release gate green under an npm banner and a slow sandbox start
- re-contend on lock identity churn instead of crashing
- correct the /review rung-4 rationale about subagent capabilities
- align implementer TDD commit prefixes with red:/green:
- close scanner and installer publishability blockers
- close transaction recovery gaps
- bound installer archive handling
- verify transactional updates
- bound consumers and validate provenance
- close runtime integrity and backpressure gaps
- make marketplace updates atomic
- harden graph engine coordination and provenance
- harden runtime installers
- support publication locks on Windows
- coordinate graph publication across processes
- make signatures private and defaults compatible
- make SSE client handling concurrent
- bound cache commits and scope arrow signatures
- bound cache reads during file growth
- gate npm publish on graph assets
- make symbol signatures safe and explicit
- harden map serving and cache loading
- make the regex-pinned cutover actually byte-clean; key the cache on the grammar set
- make every subcommand discoverable from `help`

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
