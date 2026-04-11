---
description: Analyze uncommitted changes and create atomic conventional commits (one logical change per commit)
allowed-tools: Bash, Read, Task
---

# /atomic-commit

Analyze changes and create atomic commits.

## Atomic Reasoning

Before creating commits, decompose changes into atomic reasoning units:

**For each file change:**
1. **State the logical component** — What does this change do? What is its purpose? Does it complete a thought?
2. **Validate independence** — Can this change be applied independently? Does it depend on other changes? Does it break the build alone?
3. **Verify correctness** — Is this change logically complete? Does it mix concerns? Should it be split further?

**Synthesize commit strategy:**
- Group changes by logical concern (one commit = one idea)
- Order commits so each builds successfully
- Write clear commit messages that explain WHY, not just WHAT
- Ensure each commit is self-contained and reviewable

## Gathering Current State

First, gather the current state:

1. Run `git status` to see what changed
2. Run `git diff` to see unstaged changes
3. Run `git diff --cached` to see staged changes

## Strategy

Based on the changes, analyze and group them into logical, ATOMIC commits. Each commit should:

1. Contain ONE logical change only
2. Be self-contained and complete
3. Not break the build if applied independently

You may delegate this work to the `git-committer` subagent via the **Task tool** with `subagent_type: "git-committer"` if the change set is large or spans multiple areas. The git-committer will review diffs, group changes, and create commits with conventional commit messages.

For each group of changes you identify:
- List the specific files that belong together
- Generate a clear, descriptive commit message following conventional commits format
- Explain WHY these changes belong in one commit

Then execute the `git add <specific-files>` and `git commit` commands for each atomic commit in the order they should be applied.

Format each commit message as:
```
type(scope): brief description
```

Common types: feat, fix, refactor, docs, test, chore, style, perf. For strict TDD cycles, also use `red:`, `green:`, `refactor:`.

## Rules
- NEVER use `git add -A` or `git add .` — always stage specific files
- NEVER use `git commit --no-verify`
- NEVER force push
- Review diffs before committing to ensure nothing unexpected is staged
