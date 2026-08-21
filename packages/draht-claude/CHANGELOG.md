# Changelog

## [Unreleased]

### Added

- `install-graph-engine` (alias `graph-engine`) command that fetches the prebuilt Go `draht-graph` knowledge-graph engine binary; `map-graph`/`graph-*`/`map-codebase` now dispatch to it automatically when present (`DRAHT_GRAPH_ENGINE=auto`, the default), falling back to the built-in JS engine otherwise — see `go/README.md` and `.planning/kg-integration/SPEC.md`
- `--no-graph-engine` install flag and `DRAHT_SKIP_GRAPH_ENGINE` env var to skip the automatic fetch
- portable `cinematic-continuation` skill with bundled style/continuity references, a neutral sequence template, Seedance adapter boundary, and offline timeline compiler
- `/grill` command for whole-frontier interrogation of any subject
- `/why` command: code archaeology for intent and history — one read-only `investigator` subagent per available evidence category in parallel, synthesized into a confidence-tiered, citation-backed answer with a Sources Consulted coverage map
- `investigator` agent — single-category evidence gathering with verbatim citations, null results, contradictions, and cross-category leads
- portable `epistemics` skill — the confidence-calibration discipline `/why` synthesizes with (five tiers, cite-or-label-as-inference, null results as evidence, competing hypotheses, coverage-map contract)
- portable `unslop` prose-discipline skill — cuts AI tells from prose deliverables (docs, reports, handoffs, commit bodies), adds voice back register-aware, and covers German prose by category (Füllwörter, Werbesprache, Anglizismen)
- portable `typescript-discipline` skill — TypeScript type-system discipline (discriminated unions over optional-field bags, constructive modeling, branded primitives, boundary parsing with trust inside, totality-triggered strengthening, compiler-enforced exhaustiveness) with a worked don't/do examples file under `references/`
- `/resolve-conflicts` command: resolve an in-progress git merge, rebase, or cherry-pick by reconstructing both sides' intent — never by picking a side blind
- `/create-verification-skill` command: interviews the target repo (surface, run, drive, observe, isolate) and generates a committed project-local `verify-<app>` skill — Launch/Doctor/Drive/Evidence/Cleanup/Helpers sections plus a per-feature verification map — that drives the real app the way a user does and captures proof artifacts, proven end to end once before handover

### Changed

- pruned the boilerplate Atomic Reasoning section from all generated command templates; commands keep only command-specific reasoning plus a one-line pointer to the `atomic-reasoning` skill (already shipped in this plugin's skills/)
- frontier-rounds questioning protocol in the brainstorming skill and the discuss-phase/new-project/init-project commands
- `/fix` Phase 1 now gates on a red-capable reproduction loop (one named command, already run, invocation and output shown, asserting the exact symptom) and Phase 3 tests 3-5 ranked falsifiable hypotheses instead of a single one; the `debugger` agent and the debugging-workflow skill carry the same reproduction-first brief and reproduction ladder
- `/verify-work` fix plans now hold their reproducing tests to the same red-capable standard as `/fix` Phase 1
- comment discipline enforced across the implementer and reviewer agents, the execute-phase/fix/quick/review commands, and the tdd-workflow skill: comments only for constraints the code cannot express
- the pause-work/verify-work/grill commands, the brainstorming skill, and the git-committer agent now point their prose-producing steps at the `unslop` skill
- the reviewer agent's Type Safety criteria now name the TypeScript anti-patterns to hunt (optional-field state bags, unbranded interchangeable IDs, non-exhaustive switches, unearned casts) and point at the `typescript-discipline` skill

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
