# @draht/install

The Draht installer engine. One package, two bins:

- **`draht-install`** — machine-level component management: `plan`, `install`, `status`, `doctor`, `update`, `uninstall`.
- **`draht-init`** — project bootstrap: ensure components, then scaffold a project's `.planning/` tree.

Both bins are the same entry point (`dist/cli.js`); the behavior is selected by the invoked basename.

> **Not published.** This package is `private: true`. Publication is gated by
> `scripts/check-install-publishable.mjs`, which fails the repo-wide check and
> the release script if `private` is removed while the release-evidence suites
> do not pass.

## Usage

```
draht-install <command> [components…] [options]
```

| Command | What it does |
| --- | --- |
| `plan` | Resolves the channel and reports what would change. Never writes. Exits 2 when changes are pending. |
| `install` | Applies the resolved plan as one transaction. |
| `status` | Reports installed components and on-disk drift. Exits 2 with `--check` when drift exists. |
| `doctor` | Diagnoses state, journal, host, transaction and legacy-layout problems. |
| `update` | Re-resolves the channel and applies newer versions. |
| `uninstall` | Removes components. Requires explicit selectors or `--all`. |

### Selection

- **Default** (no selectors): the `installer` component plus a plugin payload for every harness CLI actually present on `PATH`. A component whose host CLI is absent is skipped and reported — never installed for a harness that is not there.
- **`--full`**: every catalog component. Cannot be combined with explicit selectors.
- **Explicit selectors** (`draht-install install claude-plugin codex-plugin`): replace the default set entirely. An unknown id is a usage error. Duplicates are deduplicated with first-occurrence order preserved.
- **`--fail-on-empty`**: exit 3 when the resolved selection is empty. Intended for CI, where a silently empty profile would otherwise look like success.

Shipped components:

| id | kind | source | in default profile |
| --- | --- | --- | --- |
| `claude-plugin` | `claude-plugin` | `draht-claude` | when `claude` is on PATH |
| `codex-plugin` | `codex-plugin` | `draht-codex` | when `codex` is on PATH |
| `coding-agent` | `global-cli` | `@draht/coding-agent` | no — explicit or `--full` only |
| `installer` | `global-cli` | `@draht/install` | when `npm` is on PATH |

Adapters are keyed by **kind**, never by package name, so adding a future component of an existing kind is a catalog data change with no engine code. A catalog entry naming an unknown kind parses fine and fails only if it is selected.

### Options

| Flag | Effect |
| --- | --- |
| `--channel <name>` | Release channel. Only `latest` is supported; anything else is refused with an explanation. |
| `--json` | Machine-readable output (see below). |
| `--yes`, `-y` | Confirm a mutating command without a TTY prompt. |
| `--dry-run`, `-n` | Offline preview: make no writes, registry requests, downloads or host calls. |
| `--force` | Reinstall a component already recorded at the desired version. |
| `--check` | (`status`) Exit 2 when changes are pending. |
| `--all` | (`uninstall`) Remove every installed component. |
| `--component <id>` | (`draht-init`) Ensure this component; repeatable. |
| `--help`, `-h` / `--version` | Usage / engine version. |

Short flags are exactly `-h`, `-y`, `-n`. There are no others, and no flag clustering.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success; nothing outstanding. |
| `1` | Error: bad usage, corrupt state, failed transaction, unusable host, malicious archive. |
| `2` | Changes pending. Only `plan` and `status --check` return this. |
| `3` | Blocked or partially applied: missing confirmation, lock held, unrecoverable transaction, refused downgrade, empty selection under `--fail-on-empty`, interrupted run. |

## Safety

- **Confirmation.** Every mutating verb requires a TTY confirmation or `--yes`. Read verbs (`plan`, `status`, `doctor`) never prompt.
- **Dry run.** `--dry-run` makes zero writes, registry requests, downloads and host calls. It is enforced structurally: the dry-run path is handed a registry and host runner that throw on every operation. Fresh installs and update checks report the symbolic target `latest`; an actual mutation resolves and pins the concrete version before applying.
- **Mutual exclusion.** Mutating commands hold `lock.json` in the state root. A live owner is refused. A lock written by another host is refused, because this process cannot ask whether a pid on another machine is alive. An unparseable or stale lock is also refused rather than automatically removed: portable filesystem APIs cannot atomically prove that another process did not replace it. Inspect and remove a stale lock only while no installer process is running.
- **Refusal on damaged state.** A mutating command refuses to run when `state.json` is corrupt, when the journal's tail is torn, or when an interrupted transaction cannot be recovered from durable evidence. `doctor` reports each case.
- **Path validation.** Component ids match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`. Payload file paths must be plain relative POSIX paths — absolute paths, `..` segments, backslashes, Windows drive paths, empty segments and NUL bytes are all refused. A payload target must be an absolute path nested at least two levels under the resolved home, and may never be, contain, or sit inside the engine's own state root.
- **Symlink pivots.** Every path segment from the home directory down to a payload target is checked; a symbolic link anywhere on that chain aborts the operation, so a swap can never be redirected into deleting something else.
- **Source identity.** Integrity proves the bytes are what the registry published at a URL; it does not prove the URL belonged to the package that was asked for. The extracted payload's own `package.json` is therefore checked against the resolved name and version, and a payload with no manifest is refused rather than trusted.
- **Archive safety.** Tarballs are verified against the **registry-served** `dist.integrity` (npm's trust root — not a hash from the catalog, which would only prove the catalog agrees with itself), then extracted with a reader that refuses: non-gzip data, decompression bombs, over-large or over-numerous members, symlinks, hardlinks, devices, FIFOs, GNU long-name extensions, traversal and absolute paths, entries outside `package/`, and two members resolving to the same path. Nothing is written until the whole archive has passed.
- **Deregistration before deletion.** On uninstall the adapter unwires the component from its host and then *verifies with the host* that it is gone. A payload is deleted only after that verification succeeds; if the host still lists the plugin, the command fails and the payload stays.
- **No shell.** Host CLIs and the scaffolder are invoked through argv with `shell: false`. A component id or path containing shell metacharacters is data, never a second command.
- **Permissions.** The state root is created `0700`; `state.json`, `journal.jsonl` and `lock.json` are created `0600`, at creation time rather than by a later `chmod`.
- **Signals.** `SIGINT`/`SIGTERM` ask the engine to stop at its next safe point (between actions); the in-flight transaction rolls back and the command exits 3. A second signal exits immediately, leaving the journal and backups for the next run to recover.

## Transactions and crash recovery

Each apply is one transaction: `planned → per action {staged → backed-up → swapped → registered} → committed`, journaled to an append-only `journal.jsonl` with `fsync` before each step's effect is observable. `state.json` is written temp-file + `fsync` + atomic rename.

- **Ordinary failure** (host refuses, archive is bad, filesystem error) rolls the whole transaction back: every backed-up directory is restored byte-identically, staging is removed, `rolled-back` is journaled, and `state.json` is left untouched.
- **Crash** (the process is killed outright) is recovered by the next mutating command, which restores each component from the backup the crashed transaction left behind, or removes a half-installed fresh payload that had no predecessor. This is exercised by tests that **SIGKILL a real subprocess** mid-transaction and then assert byte-identical restoration — not by simulated in-process faults.
- Recovery is **refused, never guessed**, when the journal tail is torn, when a leftover backup belongs to a transaction the journal never recorded, or when a recorded target fails target-safety validation. Those cases become non-repairable `doctor` findings.
- **Delegated installs cannot be rolled back.** When a transaction that already ran `npm install --global` later fails, the rollback reports that external effect verbatim rather than claiming to have undone it.

## State layout

Everything the engine writes lives under the install root (`~/.draht/install`, or `DRAHT_INSTALL_DIR`):

```
~/.draht/install/
  state.json        schema-versioned durable state (0600)
  journal.jsonl     append-only transaction journal (0600)
  lock.json         mutual-exclusion lock, present only while mutating (0600)
  cache/            integrity-keyed extracted payloads
  staging/<tx>/     in-flight payloads
  backups/<tx>/     previous payloads, retained until commit
```

Payload targets live outside the install root:

```
~/.draht/claude-marketplace/   plugins/draht/ + .claude-plugin/marketplace.json
~/.draht/codex-marketplace/    plugins/draht/ + .agents/plugins/marketplace.json
```

`global-cli` components have no engine-owned directory; they are installed by npm and recorded as delegated, with an empty file manifest, so `status` and `doctor` never claim hash-level knowledge of bytes the engine does not own.

`status` reports one of five drift values per component: `clean`, `drifted`, `missing`, `delegated` (an external package manager owns the bytes) and `unknown` (this engine build has no catalog entry for the component and cannot resolve what backs it). `unknown` is the starting value — a component earns a verdict only once the engine can actually inspect it.

## JSON output

- Read commands (`plan`, `status`, `doctor`) emit exactly **one** document on stdout: `{ "schemaVersion": 1, "command": …, … }`.
- Mutating commands (`install`, `update`, `uninstall`, `draht-init`) emit **NDJSON** event records, one per line, each with `schemaVersion` and `event`, ending with an `event: "summary"` record.
- Human prose is never mixed into stdout in JSON mode. In human mode errors go to stderr; in JSON mode a schema-stable `{ ok: false, error: { code, message } }` document goes to stdout and the message is repeated on stderr.
- `error.code` is the stable machine-readable discriminator (`usage`, `lock-held`, `unsafe`, `integrity-mismatch`, …). `error.message` is prose and may change between releases — do not parse it.
- No environment dump, no credentials, and no registry auth material appears in any output.

## Environment variables

| Variable | Effect |
| --- | --- |
| `DRAHT_INSTALL_DIR` | Overrides the state root. Default `~/.draht/install`. |
| `DRAHT_HOME` | Overrides the home directory every payload target is derived from. Takes precedence over `HOME`. |
| `DRAHT_REGISTRY` | Overrides the npm registry base URL. Must be `http(s)`; a `file:` URL is refused. |
| `DRAHT_TOOLS_BIN` | (`draht-init`) Overrides the resolved `draht-tools` entry script. |

## `draht-init`

```
draht-init [directory] [options]
```

Ensures the requested components through the same engine `draht-install` uses, then scaffolds the project's `.planning/` tree by invoking the bundled `draht-tools` CLI through argv with the project directory as cwd.

- The directory defaults to the current working directory.
- A directory containing only ignorable entries (`.git`, `.gitkeep`, `.DS_Store`) counts as empty. Anything else requires `--force`.
- An existing `.planning/` directory is refused **even under `--force`**: that is the artifact the scaffolder would clobber.
- Collision checks run before anything is created, so a refusal leaves the filesystem exactly as it was found.
- **No AI agent is launched.** Spawning an interactive agent session as a side effect of a bootstrap command is not behavior this engine can prove safe, so the handoff command is printed for the operator to run.

## Limitations and non-goals

**Limitations**

- `--dry-run` is entirely offline. Fresh installs and update checks therefore show `latest`, not a registry-resolved concrete version.
- `status`/`status --check` report drift from durable local state only; they do not contact the registry. Use `plan` to learn whether a newer version exists.
- Rename-discipline behavior is **untested on Windows** — there is no Windows CI. The engine's atomicity guarantees are verified on POSIX only.
- Delegated (`global-cli`) components are only as atomic as `npm install --global` is. The engine records the delegation honestly and never claims to roll it back.
- Codex plugin effectiveness is reported as `unknown`, because Codex's reload semantics were never verified. Claude plugin changes are reported as `restart-required`.
- Only `npm` is used for delegated installs. Other package managers are not auto-detected.
- The engine reimplements the plugin CLIs' registration flows rather than calling them. Adapter tests pin the exact call sequences so drift in `draht-claude`/`draht-codex` shows up as a failing test.

**Non-goals for this release**

- The `next` channel and version pinning (the registry's `next` tag is a frozen 2026-03 artifact).
- User-facing `repair` and `rollback` verbs — the journal and backups make them buildable later; automatic rollback and crash recovery already run inside the engine.
- Configuration merge/overlay and a `configure` verb.
- Background or startup update checks. `update` is explicit; nothing writes outside an explicit command.
- Scheduled updates, signed catalogs, and a minisign trust ladder.
- Unscoped launcher packages (`draht-install`, `draht-init`, `create-draht`) — deferred to the first publish.

## Library use

The package also exports its engine pieces (`runCli`, `Engine`, `computePlan`, `applyPlan`, the adapter table, the source clients, the safety helpers). `runCli` takes every ambient input — argv, bin name, env, cwd, streams, TTY-ness, registry, host runner, abort signal — as an argument, so it is drivable from a test without spawning a process or touching the real environment.
