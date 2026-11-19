# Changelog

## [Unreleased]

## [2026.11.5-1] - 2026-11-05

### Changed

- feat(chord): telemetry from pages and workers stored by the server, who a span was for
- feat(chord): telemetry, spans across hosts (slice 9)
- fix: remove vulnerable dependency chains
- fix(ai): resolve pi-telemetry from source in workspace tests

## [2026.10.23-1] - 2026-10-23

### Changed

- feat: SQLite telemetry store in Chord, shared TelemetryStore and trace renderer
- feat: Durable and pi-ai telemetry; Context.telemetry is always a span
- feat: telemetry propagation, span links and metrics; telemetry member in chord/context
- bump Node.js for Oct 2026 security releases

### Fixed

- enforce patched Node versions per release line

## [2026.10.4-1] - 2026-10-04

### Added

- add telemetry reference adapter and span composition

### Changed

- feat: extract telemetry package

### Fixed

- complete @draht/telemetry package metadata and wiring
