# Changelog

## [Unreleased]

### Breaking Changes

- automatic session and prompt planning context now requires `hooks.planningContext: true` in `.planning/config.json`

### Changed

- shorten blast-radius, explainers, and saga-spawner discovery descriptions while preserving their instructions
- remove mandatory brainstorming approvals, fixed debugging hypothesis counts, repeated self-check rituals, and automatic commit/session-reset instructions; retain scoped evidence and bounded correction contracts
- share project-defined `.draht/checks.json` verification across hosts, cache successful checks by input content, and enforce configured failures on committed and non-JavaScript changes
- preserve explicit-only activation in portable skill installs as well as generated plugin artifacts
- make ordinary work and `/quick` direct, with relevant verification and optional delegation; GSD phase workflows require explicit selection
- narrow skill discovery descriptions, use focused graph context, and replace outdated model-tiering claims with workload-based evaluation guidance
- bound per-prompt planning reminders to one line of at most 196 characters
- run completion type/lint checks without requiring `.planning`, excluding workflow heuristics and automatic full-suite runs
- add `--checks-only` for standalone verification without workflow heuristics

### Fixed

- make user instructions take precedence over advisor advice and clarify diagnosis-only triage completion
- enforce literal force-push and Git hook-bypass safeguards through a shared native/plugin policy
- quality gates now reject unsuccessful verification commands by exit status; post-task hooks record failed checks instead of reporting an unverified pass
- require explicit invocation for generated GSD lifecycle skills and triage, fix, and quick wrappers through Codex host policy
- resolve debugger/reviewer scope and orchestration status conflicts while retaining actionable suspected security findings
- replace nonexistent research and milestone commands, correct fix-plan retry instructions, and recognize graph artifacts already produced by map-codebase
- block failed completion-check launches, timeouts, and signals; recognize source changes with unusual paths and untracked directories
- allow spec review against plain acceptance criteria without requiring XML plans
- rerun project checks when declared inputs cross symlinks or submodules instead of reusing incomplete snapshots

## [2026.10.8-1] - 2026-10-08

### Changed

- refresh model ids to Opus 5.5, Sonnet 5, Fable 5.1 and GPT-6

## [2026.10.4-1] - 2026-10-04

### Added

- add the explainers discipline skill
- add an STE-lite controlled register to unslop

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
