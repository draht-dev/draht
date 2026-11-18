# Changelog

## [Unreleased]

### Added

- `kg` engine (`bin/draht-kg.cjs`): graphify-parity **symbol-level** knowledge graph — deterministic indexer (`kg build` → `graph.json` in graphify's node-link schema + `KG_REPORT.md`), graphify query semantics (`kg query` seed-scored BFS/DFS traversal with NODE/EDGE output, `kg explain`, `kg path`, `kg affected`), and exports (`kg export tree|wiki|graphml`) ([#2](https://github.com/draht-dev/draht/pull/2))
- graphify parity for the living map: barrel re-exports (`export { X } from`, multi-line blocks, `export * from` with `via` provenance) now populate each barrel's exports/symbols; MAP.html gains the Insights view (clusters, hotspots, surprising connections, rationale highlights; keyboard `i`) ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` engine: Go, Rust and Python are extracted as deeply as TypeScript — Go package scopes, methods joined to their type across files, calls bound by receiver, parameter, field and result types, imports resolved through `go.mod`; Rust module tree (`mod`, inline modules, workspace crates), `use` resolution, impl methods, `Self::` / `self.` / path calls; Python declarations under `if` / `try`, module constants, decorators, source-root and re-export imports, function-local imports ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` engine (TS/JS): generic arrow functions, multi-line method headers, function-valued class fields, class expressions, declarations nested in function bodies and callbacks, top-level constants, `export { a as b }`, CommonJS `require` bindings; `x.method()` binds through the type written or constructed for `x` (parameters, locals, fields), else through a method name one class of the repo declares (INFERRED) ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg query` ranks files first: BM25 over each file's 100 most distinctive words (stored by `kg build` on the file node), its best-matching symbol name and its path; a symbol whose name is the whole query leads, and tests, docs and vendored code rank below source unless the question names them ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` runs in the Go engine: `draht-graph kg …` (`go/internal/kg`) is a port of `bin/draht-kg.cjs` that writes the same `graph.json`, report and exports and prints the same output, parses files on all cores and builds about 1.7× faster on a large TypeScript repo; `draht-tools kg` uses it when an installed `draht-graph` binary has the command and the JavaScript engine otherwise ([#2](https://github.com/draht-dev/draht/pull/2))
- `draht-tools` says once a day, on stderr, that the optional Go graph engine is not installed (or predates `kg`) and how to install it; `--quiet`, CI and `DRAHT_GRAPH_HINT=0` keep it silent, and the engine stays an opt-in download ([#2](https://github.com/draht-dev/draht/pull/2))

### Changed

- MAP.json `schemaVersion` is 6 (barrel re-exports in `exports`, `via`/`viaName` provenance, 60-name cap); a `draht-graph` binary stamped for schema 5 is rejected and the JS engine runs until the binary is reinstalled ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg build` lists files through git in a checkout (tracked files plus untracked ones git does not ignore): tracked dot-directories are indexed, ignored output is not; outside git the directory walk and its ignore list still apply ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` engine: a call binds through a declaration, an import or a type of the calling file — the guess from a name unique in the whole repo is gone for Python, Go and Rust, and a parameter or local shadows the file-level name it repeats ([#2](https://github.com/draht-dev/draht/pull/2))

### Fixed

- `kg` no longer links a parameter that shadows an import as the import's constructor or callback, nor a method signature in a parameter or return type as a call; a checkout whose only code is git-ignored yields an empty graph; `graph.json`, the report and exports are replaced atomically; and `map-graph` keeps a name that reaches a barrel both directly and through `import { x }` + `export { x }` ([#2](https://github.com/draht-dev/draht/pull/2))
- graph-query recall: term coverage is scored at the module level with coverage² scaling (was a per-symbol AND that missed multi-word concepts); tests are demoted below the code they test ([#2](https://github.com/draht-dev/draht/pull/2))
- graph-impact echoes full resolved paths and explains zero-impact barrels instead of printing a bare `index.ts — 0 modules` ([#2](https://github.com/draht-dev/draht/pull/2))
- graph-clusters labels are unique and descriptive (dominant layer / ordinal suffixes instead of six identical `packages/ai` rows) ([#2](https://github.com/draht-dev/draht/pull/2))
- MAP.html search covers `modules[*].symbols` (non-exported declarations and barrel APIs), not just the exported-only symbolIndex ([#2](https://github.com/draht-dev/draht/pull/2))
- graph-query ranks the defining file above barrels: re-exported names score at their defining module, and a module whose single symbol carries every query term ranks first ([#2](https://github.com/draht-dev/draht/pull/2))
- living map and `kg` engine correctness: type-only re-exports, order-independent star expansion, string-aware source masking, workspace root resolution, Python import resolution, and linear-time `kg build` on large repos ([#2](https://github.com/draht-dev/draht/pull/2))
- `kg` engine: a class keeps every method (was capped at 80), constructors and `#private` methods are nodes that own their calls, and methods named like reserved words (`delete()`) are indexed ([#2](https://github.com/draht-dev/draht/pull/2))

## [2026.11.14-1] - 2026-11-14

### Added

- ship test audit prompt and plugin skills

### Changed

- clarify skill distribution and update install instructions

## [2026.10.31-1] - 2026-10-31

### Added

- add opt-in per-file token budgets for draht and the Claude Code and Codex plugins

### Fixed

- generate the budget runtime bundle identically under hoisted and isolated installs
- pair moved files by shared content and leave deletions of ignored files uncharged
- keep allowances for files Git ignores temporarily and pair moves by content first
- harden checks for new worktrees, missing Git, named pipes, stale locks, moves, and ignored files
- run checks in the compiled binary without Node and preflight Codex apply_patch edits

## [2026.10.23-1] - 2026-10-23

### Added

- validate hybrid prompts with confined model comparisons
- streamline agent prompts and add deterministic verification

### Changed

- bump Node.js for Oct 2026 security releases

### Fixed

- enforce patched Node versions per release line
- avoid stale passes across input boundaries

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
- add saga-spawner skill — saga graph of beats, reconciliation loop for cloud routines
- add cinematic continuation skill
- record symbol signatures behind --symbol-signatures
- add java, ruby and shell import resolution
- resolve python/go/rust imports behind --experimental-lang-edges
- Phase 4 — cross-platform build, release CI, and the opt-in Go engine cutover
- Phase 3 — GRAPH_REPORT.md, MAP.html viewer, and the graph-* commands
- Phase 2 — clustering, hotspots, containers, symbols, call graph, flows
- add Go knowledge-graph engine (Phase 1: AST, concurrency, incremental cache)

### Changed

- changelog the auto-enable install fix
- fix roster drift across plugin READMEs and install banner
- route /triage in the draht router and the /fix entry path
- route blast-radius in the draht router
- route create-verification-skill in the draht router
- route typescript-discipline in the draht router
- route /why against /fix, debugging-workflow, and the draht router
- route unslop in the draht router and fix the stale discipline count
- skip redundant claude plugin enable/disable calls after install
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
- tolerate claude auto-enabling the plugin on install
- align implementer TDD commit prefixes with red:/green:
- close scanner and installer publishability blockers
- preserve marketplace registration rollback
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
