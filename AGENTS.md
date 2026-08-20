# Development Rules

Standing rules only. Task-specific playbooks live in `docs/` — read them when the task matches, not before:

- Adding an LLM provider → `docs/adding-a-provider.md`
- Releasing → `docs/releasing.md`
- Testing the TUI with tmux → `docs/tui-testing.md`
- Why an architectural decision stands (logic placement, skill channels, commit convention) → `docs/adr/`

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Code Quality

- Read files in full before making wide-ranging changes, before editing files you have not already fully inspected, and when the user asks you to investigate or audit something. Do not rely only on search snippets for broad changes.
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it
- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Add default to matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)
- NEVER modify `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

## Commands

- After code changes (not documentation changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing.
- Note: `npm run check` does not run tests.
- NEVER run: `npm run dev`, `npm run build`, `npm test`
- Only run specific tests if user instructs: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- Run tests from the package root, not the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, identify issues in either the test or implementation, and iterate until fixed.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Do not use real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.
- NEVER commit unless user asks

## Codebase knowledge graph (orient before you grep)

This repo ships a living knowledge graph at `.planning/codebase/` (built by `draht-tools map-graph`). Before walking the tree, query it:

- `draht-tools graph-context <file…>` — package, layer, cluster, importers/imports, sinks, rationale for a file.
- `draht-tools graph-impact <file…>` — blast radius before a change: reverse-dependents, entry points reached, downstream sinks, boundary warnings.
- `draht-tools graph-query <term…>` — ranked symbol + doc search (replaces `grep` for "where is the X").
- `draht-tools graph-callers` / `graph-callees` / `graph-path` / `graph-hotspots` / `graph-clusters --surprising`.
- `GRAPH_REPORT.md` is the one-page skimmable summary (key concepts, god-nodes, surprising connections). `MAP.json` (schemaVersion 4) is the machine-readable source; open `MAP.html` (Insights view) for the visual.

All `graph-*` commands are read-only and print concise text (`--json` for full data). If the map is stale or missing, run `draht-tools map-graph` (or `graph-hook install` to refresh on every commit).

## Contribution Gate

- New issues from new contributors are auto-closed by `.github/workflows/issue-gate.yml`
- New PRs from new contributors without PR rights are auto-closed by `.github/workflows/pr-gate.yml`
- Maintainer approval comments are handled by `.github/workflows/approve-contributor.yml`
- Maintainers review auto-closed issues daily; issues below the `CONTRIBUTING.md` quality bar are not reopened and get no reply
- `lgtmi` approves future issues; `lgtm` approves future issues and rights to submit PRs

When creating issues:

- Add `pkg:*` labels for affected package(s): `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`, `pkg:web-ui` (all that apply)

When posting issue/PR comments:

- Write the full comment to a temp file and use `gh issue comment --body-file` or `gh pr comment --body-file` — never pass multi-line markdown via `--body`
- Preview the exact comment text before posting; post exactly one final comment unless the user explicitly asks for multiple
- If a comment is malformed, delete it immediately, then post one corrected comment
- Keep comments concise, technical, and in the user's tone

When closing issues via commit: include `fixes #<number>` or `closes #<number>` in the commit message.

## PR Workflow

- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, push, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own).

- New entries ALWAYS go under `## [Unreleased]`, in sections: `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, `### Removed`
- Read the full `[Unreleased]` section first; append to existing subsections, do not create duplicates
- NEVER modify already-released version sections — each released section is immutable
- Attribution: internal `Fixed foo ([#123](…/issues/123))`; external `Added X ([#456](…/pull/456) by [@username](https://github.com/username))`

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `packages/ai/src/models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work (and are deny-listed in `.claude/settings.json` — the wall is enforced, not just requested):

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

Push with `git pull --rebase && git push` when needed — never reset/checkout to resolve.

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
