# Releasing

**Lockstep versioning**: All packages always share the same version number. Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

## Steps

1. **Update CHANGELOGs**: Ensure all changes since last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md

2. **Run release script**:
   ```bash
   npm run release:patch    # Fixes and additions
   npm run release:minor    # API breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.

## Binaries

`scripts/release.mjs` pushes a `v<version>` tag, which fires
`.github/workflows/build-binaries.yml`. Two jobs attach assets to that same
release:

- `build` — the existing `pi-*` archives (5 platforms).
- `build-graph` (`needs: build`, `if: !cancelled()`) — the Go knowledge-graph
  engine: `draht-graph-<platform>.tar.gz`/`.zip` for
  darwin-arm64/darwin-x64/linux-x64/linux-arm64/windows-x64, plus
  `SHA256SUMS` and `manifest.json`. It runs on `needs: build` ordering (so
  the release always exists first) rather than as a separate workflow, so
  the two jobs never race on `gh release create` for the same tag.

Local reproduction: `./scripts/build-graph-binaries.sh [--platform <name>]`
(also `npm run build:graph-binaries`) — see `go/README.md`'s "Building
release artifacts".

End users never see these binaries automatically; they install (or update)
them with:

```
npx draht-claude install-graph-engine
npx draht-codex install-graph-engine
```

which fetches the one matching platform archive from the release, verifies
its checksum against `manifest.json`, and installs it to
`~/.draht/bin/draht-graph[.exe]`. This never runs on a command path (no
lazy/blocking fetch inside `map-graph`/`graph-*`/the git post-commit hook) —
only from an explicit install/update invocation. Escape hatches:
`DRAHT_GRAPH_ENGINE=go|js|auto` (default `auto`) selects the engine;
`DRAHT_GRAPH_BIN=/path/to/draht-graph` overrides binary resolution entirely;
`install-graph-engine --from <path>` installs a locally built binary
(air-gapped path); `--no-graph-engine` / `DRAHT_SKIP_GRAPH_ENGINE=1` skip the
fetch during `install`/`update`. Full detail:
`.planning/kg-integration/SPEC.md`'s "Go engine cutover" section.
