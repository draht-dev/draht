# Changelog

## [Unreleased]

### Breaking Changes

- `@draht/chord` is now Chord v2, carried from upstream `packages/chord` at badlogic/pi-mono@befc2d59b. The Chord v1 runtime is removed, and with it `replicatedState`, `bind`, `opaque`, `coverage`, `hostFamily`, `hostNamed`, `acceptWebSockets`, `inflateMessage`, `PACK_THRESHOLD`, `MAX_INFLATED_BYTES`, `PROTOCOL_VERSION` and the `./node` entry point. `copyJson` and `isJsonValue` are imported from `@draht/chord/json`, `Watch` and `NativeWatch` from `@draht/chord/watch`. `createHost`, `defineFacet`, `defineRegistry`, `local`, `remote`, `method`, `memoryLinkPair`, `ipcLink`, `webSocketLink` and `ChordError` keep their names with the v2 API. Code written against v1 has to be ported. The v1 documents (`docs/guide.md`, `docs/spec.md`, `docs/tutorial.md`) are replaced by the v2 design and tutorials.

### Added

- Chord v2: objects with typed contracts served by plugin facets, references that work the same locally and across links, documents and derives, jobs, registries, principals, and a SQLite-backed store with tables, queries, export and import.
- Entry points `./http`, `./workers`, `./workers/child`, `./compression`, `./plugins`, `./plugins/runtime`, `./app`, `./app/files`, `./surfaces`, `./web`, `./react`, `./tui`, `./tui/launcher`, `./sync`, `./telemetry-ingest` and `./telemetry-sqlite/node`. `esbuild`, `ws` and `react` are optional peer dependencies of the entry points that need them.
- `README.md` and the design documents under `docs/`. Runnable examples are in the repository under `packages/chord/test/examples/`.
