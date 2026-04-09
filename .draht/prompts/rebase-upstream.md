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

### 5. Verify (subagent: verifier)

Use the subagent tool in **single** mode:

```
agent: "verifier"
task: "Run bun run check and fix all errors, warnings, and infos until clean."
```

### 6. Final branding audit (subagent: branding-guard)

Run branding-guard again — verification fixes can reintroduce pi references:

```
agent: "branding-guard"
task: "Final audit. Scan the entire codebase for pi branding leaks. Fix all hits and confirm zero remaining."
```

### 7. Merge into main

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
- [ ] **branding-guard** subagent: full sweep done, no pi product references leaked
- [ ] **verifier** subagent: `bun run check` passes
- [ ] **branding-guard** subagent: final audit confirmed zero branding hits
- [ ] Merged into `main`
