# Releasing

**Lockstep versioning**: All packages always share the same version number. Every release updates all packages together.

**Version scheme**: CalVer, always suffixed — `YYYY.M.D-N`, where `N` starts at `1` for the first release of a day and increments for same-day follow-ups (`scripts/release.mjs` → `computeNextVersion` in `scripts/lib/version-stamp.mjs`). The bare `YYYY.M.D` form is retired: it sorted *above* every same-day `-N` under semver, which broke fielded update comparators. There are no `release:patch`/`release:minor` commands and no semver semantics.

## Steps

1. **Update CHANGELOGs**: Ensure all changes since the last release are documented in the `[Unreleased]` section of each affected package's CHANGELOG.md (conventional-commit collection in the script assists, but the `[Unreleased]` sections are the source of truth).

2. **Run the release script**:
   ```bash
   npm run release        # or: npm run release:dry to preview
   ```

The script: computes the next version from existing tags (`computeNextVersion` in `scripts/lib/version-stamp.mjs`), stamps every version surface via `scripts/release-helpers.mjs` `setVersion` — every `packages/*/package.json`, the root `package.json`, **both plugin manifests** (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` — hosts key update detection off these; `check-draht-customizations.mjs` fails on drift), and the `bun.lock` workspace snapshots — then re-validates all of them with `assertReleaseVersions`, finalizes CHANGELOGs from conventional commits, runs `./test.sh`, builds, commits and tags, pushes commit + tag, waits for the verified GitHub release, publishes every non-private workspace package (`scripts/publish-workspaces.mjs`, `workspace:*` deps rewritten to exact versions), and adds fresh `[Unreleased]` sections.

The release tag and commit are pushed before npm publication. The script then
polls the matching GitHub release and refuses to publish npm packages until
`manifest.json`, `SHA256SUMS`, and all five graph archives are attached. A
partial or failed binary workflow therefore leaves no new npm version pointing
at unavailable native assets. `--dry-run` prints this choreography but performs
none of its commits, tags, pushes, polling, or publication.

## Binaries

`scripts/release.mjs` pushes a `v<version>` tag, which fires
`.github/workflows/build-binaries.yml`. Two jobs attach assets to that same
release:

- `build` — the Draht-branded `draht-*` runtime archives (5 platforms).
- `build-graph` (`needs: build`, `if: !cancelled()`) — the Go knowledge-graph
  engine: `draht-graph-<platform>.tar.gz`/`.zip` for
  darwin-arm64/darwin-x64/linux-x64/linux-arm64/windows-x64, plus
  `SHA256SUMS` and `manifest.json`. It runs on `needs: build` ordering (so
  the release always exists first) rather than as a separate workflow, so
  the two jobs never race on `gh release create` for the same tag.

Local reproduction: `./scripts/build-graph-binaries.sh [--platform <name>]`
(also `npm run build:graph-binaries`) — see `go/README.md`'s "Building
release artifacts".

Both binary jobs use GitHub Actions OIDC with
`actions/attest-build-provenance` to create keyless build-provenance
attestations. This covers the five `draht-*` runtime archives and the five
`draht-graph-*` archives, `SHA256SUMS`, and `manifest.json`. Verify a downloaded
asset with `gh attestation verify <asset> --repo draht-dev/draht`.
This proves which GitHub workflow, repository, commit, and runner identity built
the bytes; it is not an Apple code-signing or notarization substitute.

### macOS signing and notarization

The macOS archives remain unsigned and unnotarized. Completing that step
requires organization-controlled credentials that must not be invented or
committed: an Apple Developer ID Application certificate/private key, Apple
Team ID, and App Store Connect notarization credentials (issuer/key ID and
private key, or an approved Apple ID app-specific password). Once those are
provisioned as protected CI secrets, the release job must codesign each Darwin
binary with the hardened runtime, submit and wait for notarization, staple where
the distributed format supports it, and validate with `codesign --verify` and
`spctl`. Until then, the installer accurately describes the binaries as
unsigned and keeps graph-engine installation opt-in.

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

## Channels

**Not yet supported**: publishing to the `npm` `next` dist-tag — the historical `--tag next` branch in `release.mjs` is unreachable for every version `computeNextVersion` can emit, and the registry's existing `@draht/coding-agent@next` is a frozen 2026-03 artifact. See `.planning/specs/2026-08-12-unified-distribution-product.md` (deferred register) before adding a prerelease channel.
