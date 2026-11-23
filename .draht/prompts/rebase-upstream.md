# Rebase on Upstream Pi

Rebase draht on upstream pi (`pi` remote) to incorporate upstream patches.
Delegate work to subagents. Use `agentScope: "both"` for all subagent calls.

## Remote

```
pi  https://github.com/badlogic/pi-mono.git
```

---

## Commit hooks (enforced at every commit)

Every commit made during the rebase (cherry-picks, conflict resolutions, branding fixes)
must pass these hooks. The cherry-picker subagent enforces them automatically after
each cherry-pick; for manual commits, run `node scripts/check-draht-customizations.mjs`.

| Hook | What it blocks |
| ---- | -------------- |
| **Package name** | Any `package.json` `name` field containing `@mariozechner/pi*` |
| **Author name** | Any `package.json` `author` field referencing upstream authors (Mario Zechner, badlogic, etc.) |
| **Import paths** | Any `@mariozechner/pi*` import/require in source files (`.ts`, `.js`, `.mjs`, etc.) |
| **README references** | Any `@mariozechner/pi*` references in `README.md` files |
| **README modification** | Any diff touching `README.md` files (revert with `git checkout HEAD -- <readme>`) |
| **README domain/discord branding** | Discord invite badge, or "graciously donated by" domain credit, reintroduced into `README.md` files |

---

## Procedure

### 1. Fetch and classify commits

Do this yourself (no subagent):

```bash
git fetch pi main
git log HEAD..pi/main --oneline
```

Review every commit. Classify each as **take**, **skip**, or **adapt**.

**Skip** these categories entirely:

- Release/version commits (e.g. `Release v0.56.2`, `Add [Unreleased] section for next cycle`)
- Changelog-only commits
- Commits that only bump `version` fields in `package.json`
- Commits that only touch `CHANGELOG.md`
- Any commit whose sole effect is version bookkeeping

**Take** commits with meaningful code changes: bug fixes, features, refactors, dependency updates, test improvements.

**Adapt** commits with useful code mixed with version/changelog noise.

### 2. Create working branch

```bash
git checkout -b upstream-sync main
```

### 3. Cherry-pick (subagent: cherry-picker)

Use the subagent tool in **single** mode:

```
agent: "cherry-picker"
task: "Cherry-pick these commits (oldest first):\n<hash> <message> — take\n<hash> <message> — adapt\n..."
```

Pass the full classified commit list as the task.

### 4. Branding sweep (subagent: branding-guard)

Use the subagent tool in **single** mode:

```
agent: "branding-guard"
task: "Scan the codebase and the diff main..upstream-sync for pi branding leaks. Fix all hits."
```

### README — never modify

**Never edit `README.md` at any level** (root or any package). If a cherry-picked commit
touches a `README.md`, skip that file hunk entirely:

```bash
git checkout HEAD -- README.md packages/*/README.md
```

If any README was modified, re-run the commit hook to confirm zero remaining pi references:

```bash
node scripts/check-draht-customizations.mjs
```

This same check also fails if a README regains the fake discord invite badge or the
stale "graciously donated by" domain credit — draht has no discord community, and the
domain credit was replaced with a Spaceship referral link (`https://draht.dev/domain`,
redirecting via `packages/landing/astro.config.mjs`). If `git checkout HEAD --
README.md` ever reintroduces either of these (e.g. because `HEAD` predates this fix),
manually reapply the fix rather than accepting the reverted content.

### 5. Draht customization guard

Run the customization check yourself (no subagent). This catches upstream overwrites
of draht-specific `package.json` fields, scripts, workspace deps, planning docs,
repo-level subagents, and all GSD workflow assets:

```bash
node scripts/check-draht-customizations.mjs
```

What it verifies:

- Root `package.json` version format, draht-only scripts, workspace deps
- `coding-agent/package.json` `drahtConfig`, bin entries, files array, build scripts, publishConfig
- All shared packages use `workspace:*` for `@draht/*` deps
- Draht-only scripts on disk (`dev-link.mjs`, `verify.sh`, `release.mjs`, etc.)
- `verify.sh` still targets `@mariozechner/pi-*`
- `.planning/` docs unchanged vs main
- Repo-level subagents in `.draht/agents/` (`branding-guard`, `cherry-picker`, `verifier`)
- GSD sources in `packages/coding-agent/src/gsd/` and their public exports
- GSD hooks in `packages/coding-agent/hooks/gsd/`
- GSD command & agent prompt templates in `packages/coding-agent/prompts/`
- Built-in agents in `packages/coding-agent/agents/`
- `draht-tools` binary at `packages/coding-agent/bin/draht-tools.cjs`
- GSD test suite in `packages/coding-agent/test/`
- Multi-agent core builtin is actually **wired**, not just present on disk:
  `core/multi-agent/index.ts` primitives (`AgentFSM`, `MailboxSystem`,
  `PermissionGate`, `TaskBoard`, `WorktreeIsolator`) are imported by
  `core/builtins/subagent.ts`, registered in `CORE_BUILTIN_EXTENSIONS`
  (`core/builtins/index.ts`), and that array is spread into
  `extensionFactories` in `agent-session-services.ts`. File existence and
  passing unit tests do not prove this — the whole multi-agent layer was
  dead code for a full phase because nothing asserted the import chain
  actually reached the running CLI. See `check-draht-customizations.mjs`.

If any checks fail, fix the issues before proceeding. Common problems:

- `version` reverted to upstream semver → restore `YYYY.M.D` format
- `drahtConfig` reverted to `piConfig` → rename the key
- `workspace:*` deps replaced with semver ranges → restore `workspace:*`
- Draht-only scripts removed (`dev:link`, `release`, `verify`, etc.) → re-add them
- `build:binary` outputs `dist/pi` → change to `dist/draht`
- `.planning/` files modified → revert with `git checkout main -- .planning/`
- `verify.sh` branding check rewritten → revert with `git checkout main -- scripts/verify.sh`
- Any GSD/subagent/prompt/agent/hook file missing → restore with
  `git checkout main -- <path>` (upstream cannot remove them; a missing file means
  a merge/cherry-pick accidentally dropped it)
- `CORE_BUILTIN_EXTENSIONS` no longer registered, or `agent-session-services.ts`
  no longer spreads it into `extensionFactories` → upstream changes to
  extension/service wiring silently unwire the multi-agent layer back to dead
  code. Restore the import and the `...CORE_BUILTIN_EXTENSIONS` spread — do not
  just restore the files and assume presence means wired.

### 6. Verify (subagent: verifier)

Use the subagent tool in **single** mode:

```
agent: "verifier"
task: "Run bun run check and fix all errors, warnings, and infos until clean."
```

### 7. Final branding audit (subagent: branding-guard)

Run branding-guard again — verification fixes can reintroduce pi references:

```
agent: "branding-guard"
task: "Final audit. Scan the entire codebase for pi branding leaks. Fix all hits and confirm zero remaining."
```

### 8. Final customization guard

Run the customization check one last time — branding fixes and verification can
re-break draht-specific fields:

```bash
node scripts/check-draht-customizations.mjs
```

All checks must pass before merging.

### 9. Merge into main

Do this yourself after all subagents report success:

```bash
git checkout main
git merge upstream-sync
git branch -d upstream-sync
```

Do **not** push until explicitly told to.

---

## Version conflicts — draht always wins

draht uses **`YYYY.M.D[-patch]`** versioning. pi uses semver.

- **Never** accept upstream version numbers into any `package.json`.
- If a cherry-picked commit touches a `version` field, revert that hunk.
- All packages use lockstep versioning — the release script handles version bumps.

## Changelog conflicts — draht always wins

- **Never** merge upstream `CHANGELOG.md` content into draht changelogs.
- draht changelogs are auto-generated from conventional commits at release time.
- On conflict: `git checkout --ours CHANGELOG.md`

## Branding — draht always wins

See the `branding-guard` agent for the full replacement table and rules. Key points:

| Upstream (pi)              | draht                |
| -------------------------- | -------------------- |
| `@mariozechner/pi-*`      | `@draht/*`           |
| `@mariozechner/pi`         | `@draht/coding-agent`|
| Binary/command name `pi`   | `draht`              |
| `pi-mono`                  | `draht-mono`         |

**Do NOT rename**: `pi` git remote, `pi-test.sh`, `Math.PI`, upstream GitHub URLs as remote refs.

## Chord and Durable

`packages/chord` (`@draht/chord`) is upstream's Chord v2 and `packages/durable` (`@draht/durable`) is upstream's
Durable. Both are carried in full since 2026-11-23, Chord from `befc2d59b` and Durable from `32c71a6d4`. Take their
commits like those of any other carried package, including `docs/`, `test/examples/` and the plugin `package.json`
files under `packages/chord/test/`. The 2026-10-31 decision not to carry Chord v2 no longer applies, and Chord v1 is
gone as it is upstream.

Fork rules for the two packages:

- **One React in the workspace.** Upstream pins exact versions of `react`, `react-dom`, `@types/react` and
  `@types/react-dom` in `packages/chord/package.json`. draht keeps the ranges `packages/geist-console` and
  `packages/reels` use for these four, and Chord's `react` peer range starts at that version. `ws` and `@types/ws`
  keep draht's caret ranges too. Do not take upstream's pins. A second React version takes the top-level slot in `bun.lock`, and under the release's hoisted
  install geist-console and reels then run with two Reacts. `scripts/check-draht-customizations.mjs` fails when
  `bun.lock` resolves more than one version of `react`, `react-dom`, `@types/react` or `@types/react-dom`. To move
  Chord to a newer React, move the whole workspace.
- `miniflare` is a dev dependency of `@draht/chord`. Upstream imports it in `test/bench/sync-memory.ts` without
  declaring it, because npm hoists it from Durable's `@cloudflare/vitest-plugin`; bun's isolated install does not. Keep
  its version equal to the one that plugin depends on.
- `packages/durable/test-workers/vitest.config.ts` aliases `@vitest/*` to the packages of the vitest that runs. vitest
  resolves them from the project root, and the workerd pool loads vitest through that resolver. The workspace has two
  vitest majors, so under the release's hoisted install the root holds the other one and the suite fails with
  "`@vitest/expect` does not provide an export named `ChaiStyleAssertions`". Keep the alias until the workspace is on
  one vitest.
- `packages/chord/test/examples/61-tutorial` is a workspace (`@todo/app`), as upstream. The root `package.json` lists
  `@todo/app` and `@draht/chord` in `devDependencies`, so that bun links both into the root `node_modules`. Chord's
  example plugins have their own `package.json` and resolve the two from there, which npm's hoisting gives upstream
  for free.
- Persisted and wire names keep upstream's `pi` prefix: Durable's entry kinds, documents, tasks and telemetry names
  (`pi.user`, `pi.agent`, `pi.generation`, `pi.durable.phase`), and the trace carrier keys `pi-sqlite-span`,
  `pi-sqlite-trace`, `pi-memory-span`, `pi-memory-trace` and `pi-memory-scope`. They are a storage and wire format,
  not branding; do not rename them. Environment variables follow the usual rule: `PI_DURABLE_*` becomes
  `DRAHT_DURABLE_*`.
- The documents under `packages/chord/docs/` are upstream's design history. Rebrand package names in them
  (`@earendil-works/chord` to `@draht/chord`, `pi-ai` to `@draht/ai`) and nothing else: "pi `<hash>`", "pi #<issue>"
  and "pi first" name upstream's repository, and `p2` and `p3` are upstream's apps.
- These files in `packages/chord` carry hand edits that no rename rule reproduces. Keep them when a pick touches the
  file:
  - `test/boundary.test.ts` checks `@draht/` names; `test/state-fuzz.test.ts` has a 60 second timeout;
    `test/output.test.ts` uses `https://example.com` where upstream uses its own domain.
  - `src/node/plugins/discover.ts` and `src/node/plugins/README.md` say "as draht's `draht.extensions`".
  - `src/sync/files.ts` and `test/sync/node-files.ts` say "Durable's", `src/sync/lines.ts` says "an older draht".
  - `src/node/tui/actions.ts` cites the upstream issue as `badlogic/pi-mono#11592`.
  - `README.md` and `CHANGELOG.md` are draht's own, as for every package.

Chord's and Durable's full suites load other workspace packages from `dist/`. CI and the release build before they
test; locally, emit `packages/telemetry`, `schema`, `chord`, `codemode` and `ai` with `npx tsc -p tsconfig.build.json`
first. Chord's browser tests need `CHROMIUM_BIN` and its terminal tests `CHORD_TUI_NODE` (Node 26.5.1 or later); both
are skipped without.

---

## Summary checklist

- [ ] Fetched `pi/main`
- [ ] Reviewed and classified every new commit
- [ ] Skipped version/release/changelog-only commits
- [ ] **cherry-picker** subagent: cherry-picked meaningful patches (oldest first)
- [ ] No upstream version numbers leaked into `package.json`
- [ ] No upstream changelog entries leaked into `CHANGELOG.md`
- [ ] No `README.md` files modified (root or any package)
- [ ] **branding-guard** subagent: full sweep done, no pi product references leaked
- [ ] `check:draht` passed (draht customizations intact)
- [ ] **verifier** subagent: `bun run check` passes
- [ ] **branding-guard** subagent: final audit confirmed zero branding hits
- [ ] `check:draht` passed again after final fixes
- [ ] Merged into `main`
