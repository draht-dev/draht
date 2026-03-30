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

### 6. Branding — draht always wins

**draht branding is non-negotiable.** No upstream cherry-pick may introduce or reintroduce pi branding anywhere in the codebase. This applies to every file touched by the cherry-pick AND any file that references content changed by the cherry-pick.

After every cherry-pick, run a full branding sweep:

```bash
# Scan the entire diff for pi branding leaks
git diff HEAD~1 --unified=0 | grep -iE '@mariozechner/pi|"pi"|pi-mono|pi-agent|pi-tui|pi-ai|pi-coding-agent|pi-mom|pi-pods|pi-web-ui'
```

#### Mandatory replacements

| Upstream (pi)                        | draht                              |
| ------------------------------------ | ---------------------------------- |
| `@mariozechner/pi-*`                 | `@draht/*`                         |
| `@mariozechner/pi`                   | `@draht/coding-agent`              |
| Binary/command name `pi`             | `draht`                            |
| `pi-mono`                            | `draht-mono`                       |
| `pi-test.sh`                         | `pi-test.sh` (keep — tests upstream compat) |
| Display strings / titles / CLI help / `description` fields / README text referencing "pi" as the product | "draht" |
| GitHub URLs `github.com/badlogic/pi*`| Keep as-is **only** when referring to the upstream remote |
| npm registry references to `@mariozechner/pi-*` | `@draht/*` |

#### Scope

- **`package.json`**: `name`, `description`, `bin`, `repository`, `homepage`, `bugs`, dependency names.
- **Source code**: Import paths, string literals, error messages, user-facing text, comments that say "pi" meaning the product.
- **Documentation**: README files, inline docs, JSDoc, help text, prompt templates, skill files.
- **Config files**: `.draht/`, CI configs, build scripts.
- **Prompt templates & skills**: Any `.md` file under `.draht/`, `.agents/`, or `docs/` that references the product.

#### What NOT to rename

- The `pi` git remote name — it refers to the upstream repo.
- `pi-test.sh` — it exists to test against the upstream pi project.
- Internal variable names where `pi` is an abbreviation for something else (e.g., `Math.PI`).
- Upstream GitHub URLs when used exclusively as remote references.

#### If in doubt, grep the whole tree

```bash
rg -i --glob '!node_modules' --glob '!.git' '@mariozechner/pi' .
rg --glob '!node_modules' --glob '!.git' --glob '!pi-test.sh' --glob '!rebase-upstream.md' '"pi"' .
```

Fix every hit before proceeding to verification.

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
- [ ] Full branding sweep done — no pi product references leaked into any file
- [ ] `rg` confirms no `@mariozechner/pi` hits outside upstream remote refs
- [ ] `npm run check` passes
- [ ] Merged into `main`
