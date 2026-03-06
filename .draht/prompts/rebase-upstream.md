# Rebase on Upstream Pi

Rebase draht on upstream pi (`pi` remote) to incorporate upstream patches.

## Remote

```
pi  https://github.com/badlogic/pi-mono.git
```

## Procedure

### 1. Fetch and identify new commits

```bash
git fetch pi main
git log HEAD..pi/main --oneline
```

Review every commit. Classify each as **take**, **skip**, or **adapt**.

### 2. Filter commits

**Skip** these categories entirely — do not cherry-pick or rebase them in:

- Release/version commits (e.g. `Release v0.56.2`, `Add [Unreleased] section for next cycle`)
- Changelog-only commits (e.g. `docs(changelog): ...`, `add changelog entry for ...`)
- Commits that only bump `version` fields in `package.json` files
- Commits that only touch `CHANGELOG.md` files
- Any commit whose sole effect is version bookkeeping

**Take** (cherry-pick) commits that contain meaningful code changes: bug fixes, features, refactors, dependency updates, test improvements.

**Adapt** commits that contain useful code but also include version/changelog noise — cherry-pick them, then strip the version/changelog parts before continuing.

### 3. Cherry-pick instead of rebase

Because a straight `git rebase pi/main` would pull in every upstream commit (including version/changelog noise and branding conflicts), use **selective cherry-picking**:

```bash
# Create a working branch
git checkout -b upstream-sync main

# Cherry-pick only the filtered commits (oldest first)
git cherry-pick <commit-hash>

# If a commit needs adaptation, cherry-pick with --no-commit, fix, then commit
git cherry-pick --no-commit <commit-hash>
# ... make edits ...
git commit -m "upstream: <original-message>"
```

### 4. Version conflicts — draht always wins

draht uses **`YYYY.M.D[-patch]`** versioning (e.g. `2026.3.5`, `2026.3.5-1`).
pi uses **`major.minor.patch`** semver (e.g. `0.56.2`).

Rules:

- **Never** accept upstream version numbers into any `package.json`.
- If a cherry-picked commit touches a `version` field, revert that hunk.
- All packages use lockstep versioning — the release script handles version bumps.
- If a conflict arises on a `version` field, keep draht's value unconditionally.

### 5. Changelog conflicts — draht always wins

- **Never** merge upstream `CHANGELOG.md` content into draht changelogs.
- If a cherry-picked commit modifies `CHANGELOG.md`, drop that hunk entirely.
- draht changelogs are auto-generated from conventional commits at release time.
- If a conflict arises on `CHANGELOG.md`, keep draht's version unconditionally (use `git checkout --ours CHANGELOG.md`).

### 6. Branding — draht not pi

After cherry-picking, scan touched files for upstream branding that conflicts with draht:

- Package names: `@mariozechner/pi-*` → `@draht/*`
- Binary names: `pi` → `draht`
- Display strings, titles, docs referencing "pi" as the product name → "draht"
- Do **not** rename internal code identifiers that happen to contain "pi" if they refer to the upstream remote or integration layer (e.g. `pi-test.sh` for testing against upstream is fine).

### 7. Verify

```bash
npm run check
```

Fix all errors, warnings, and infos before merging.

### 8. Merge into main

```bash
git checkout main
git merge upstream-sync
git branch -d upstream-sync
```

Do **not** push until explicitly told to.

## Summary checklist

- [ ] Fetched `pi/main`
- [ ] Reviewed and classified every new commit
- [ ] Skipped version/release/changelog-only commits
- [ ] Cherry-picked meaningful patches (oldest first)
- [ ] No upstream version numbers leaked into `package.json`
- [ ] No upstream changelog entries leaked into `CHANGELOG.md`
- [ ] Branding is draht throughout
- [ ] `npm run check` passes
- [ ] Merged into `main`
