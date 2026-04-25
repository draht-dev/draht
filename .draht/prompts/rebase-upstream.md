# Rebase on Upstream Pi

Rebase draht on upstream pi (`pi` remote) to incorporate upstream patches.
Delegate work to subagents. Use `agentScope: "both"` for all subagent calls.

## Remote

```
pi  https://github.com/badlogic/pi-mono.git
```

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
