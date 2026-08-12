# Changelog

## [Unreleased]

### Added

- Initial `@draht/install` engine package.
- `draht-install` CLI with `plan`, `install`, `status`, `doctor`, `update` and `uninstall`, plus `--help/-h`, `--version` and `--json`. Basename dispatch selects the surface; both bins target the same built entry and `runCli` is exported for testing.
- `draht-init` CLI: ensures components through the same engine, then scaffolds a project's `.planning/` tree by invoking the bundled `draht-tools` through argv. Refuses a non-empty directory without `--force` and never overwrites an existing `.planning/`. Reports the agent handoff command instead of launching an agent.
- Detection-based default profile, `--full`, explicit component selectors, and `--fail-on-empty` for CI.
- Shipped zod-validated component catalog (`claude-plugin`, `codex-plugin`, `coding-agent`, `installer`) with adapters keyed by kind; unknown kinds fail closed only when selected.
- Kind-keyed adapters driving the pinned `draht-claude` / `draht-codex` host call sequences, with deregistration verified before any local payload deletion, and a `global-cli` adapter that delegates to npm and reports failures honestly.
- Injectable `RegistryClient` with an npm implementation honoring `DRAHT_REGISTRY` (dist-tag resolution, size-bounded and timed-out downloads, registry-served `dist.integrity` verification, integrity-keyed payload cache) and a local fixture source for hermetic tests.
- Safe tar extraction rejecting traversal, absolute paths, links, special entries, GNU long-name records, duplicate paths, excessive members and excessive expanded size, writing nothing until the whole archive passes.
- Source identity verification: an extracted payload's own `package.json` must match the resolved name and version, and a payload without a manifest is refused.
- Mutual-exclusion lock with conservative stale-owner handling; user-private permissions on the state root, state, journal and lock.
- Path, target and symlink-pivot validation preventing traversal, install-root targeting and destructive deletion outside owned targets.
- Automatic crash recovery from durable journal and backup evidence, proven by SIGKILL subprocess tests; recovery is refused rather than guessed when evidence is incomplete, and `doctor` reports those cases as non-repairable.
- Write-ahead `swap-intent` and `external-intent` journal records covering the live-rename/pre-journal crash window and preventing automatic recovery from misreporting uncertain host/package-manager effects.
- Atomic token-directory lock ownership, destructive-boundary target revalidation, no-follow backup claiming during recovery, and state-confirmed commit finalization only when a torn canonical journal record already identifies the exact transaction and complete `committed` event.
- Extracted cache tree manifests are rehashed before reuse; modified content under an intact completion marker is atomically quarantined rather than path-deleted, so a losing writer cannot delete a valid concurrent winner.
- SHA-256-bound release evidence over the exact installer source/test/config/documentation path set, with direct compiler and full-suite execution in publication mode.
- `doctor` findings for node/npm availability, corrupt or torn state and journal, hash drift, payload manifest drift, legacy `~/.draht` clone, `~/.local/bin/draht` shadowing, `~/.pi` legacy state, missing hosts for installed components, open transactions and held locks.
- Schema-versioned JSON: one document for read commands, NDJSON event records for mutations, schema-stable error output, and no prose on stdout in JSON mode.
- Blocked `draht-init` plans stop before scaffolding with exit 3; init event identity and mutation failure NDJSON remain stable and line-parseable.
- Hermetic end-to-end suite driving the packed tarball's bins against a fake HOME, controlled PATH, stub hosts and a loopback fixture registry.

### Changed

- `applyPlan` now carries delegated actions, records `effectiveness`, `registered` and `delegated` in durable state, aborts between actions on request, and reports effects it could not roll back instead of implying it undid them.
- `resolveInstallRoot` derives from a resolvable home (`DRAHT_HOME`/`HOME`) rather than reading `os.homedir()` directly.
