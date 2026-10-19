---
description: Analyze uncommitted changes and create atomic conventional commits (one logical change per commit)
allowed-tools: Bash, Read, Task
---

# /atomic-commit

Analyze changes and create atomic commits.

## Commit prerequisites

Resolve these conditions before committing:

- A single proposed commit mixes unrelated concerns (e.g., a feature + an unrelated refactor + a config tweak)
- The change set contains potential secrets (`.env`, credentials, API keys in source)
- Staged content includes files unrelated to the user's stated intent (stale build artifacts, IDE configs, scratch files)
- Pre-commit hooks fail — fix the cause, never use `--no-verify`
- You cannot articulate the "why" of a commit in one sentence — that's a sign it contains more than one logical change

Split unrelated changes and resolve check failures within scope. Report secrets or ownership questions that cannot be safely resolved.

## Atomic Reasoning

Decompose the work into independently verifiable units before acting; the `atomic-reasoning` skill holds the full discipline — load it when the decomposition is not obvious.

## Gathering Current State

First, gather the current state:

1. Run `git status` to see what changed
2. Run `git diff` to see unstaged changes
3. Run `git diff --cached` to see staged changes

## Strategy

Based on the changes, analyze and group them into logical, atomic commits. Each commit should:

1. Contain one logical change only
2. Be self-contained and complete
3. Not break the build if applied independently

You may delegate this work to the `git-committer` subagent via Codex subagents with ``git-committer` agent prompt` if the change set is large or spans multiple areas. The git-committer will review diffs, group changes, and create commits with conventional commit messages.

For each group of changes you identify:
- List the specific files that belong together
- Generate a clear, descriptive commit message following conventional commits format
- Explain why these changes belong in one commit

Then execute the `git add <specific-files>` and `git commit` commands for each atomic commit in the order they should be applied.

Format each commit message as:
```
type(scope): brief description
```

Common types: feat, fix, refactor, docs, test, chore, style, perf. For strict TDD cycles, also use `red:`, `green:`, `refactor:`.

## Rules
- Never use `git add -A` or `git add .` — always stage specific files
- Never use `git commit --no-verify`
- Never force push
- Review diffs before committing to ensure nothing unexpected is staged
