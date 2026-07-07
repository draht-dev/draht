# Changelog

## [Unreleased]

### Added

- `PostToolUse` lifecycle hook (`post-edit-check.cjs`): file-scoped Biome lint feedback on every Edit/Write, enforced by the harness instead of command prose
- `Stop` lifecycle hook (`stop-quality-gate.cjs`): runs the quality gate (types + lint, `--no-tests`) when a turn ends with uncommitted source changes in a `.planning` project; opt out via `hooks.stopGate: false`
- `--no-tests` flag for `gsd-quality-gate.cjs`
- Session-start hook now injects a standing-spec digest (Vision + Constraints from `.planning/PROJECT.md`) and the most recent `## Lessons` entries every session
- Lessons-learned accumulation: `## Lessons` section in STATE.md, seeded by the post-phase hook on failures/violations, written by `/pause-work`, `/fix`, and `/next-milestone`, read by `/plan-phase`

### Changed

- Quality gate is strict by default (`qualityGateStrict: true`): failing tests/types/lint exit 1; opt out per-project in `.planning/config.json`
- `gsd-post-task.cjs` hard stop: 3 recorded failures for the same task exit non-zero — the orchestrator must escalate instead of re-dispatching
- `/execute-phase` and `/quick` review loops carry a hard cap of 3 implementer re-dispatches per task; `/fix`'s 3-attempt stop is a hard cap and records a lesson
- `reviewer` and `spec-reviewer` agents pinned to `model: opus` so maker (sonnet implementer) and checkers run on different models

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
