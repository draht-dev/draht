---
description: "Analyze changes and create atomic commits"
---

# Git Atomic Commit Analysis

First, gather the current state:

1. Run `git status` to see what changed
2. Run `git diff` to see unstaged changes
3. Run `git diff --cached` to see staged changes

Based on the changes, analyze and group them into logical, ATOMIC commits. Each commit should:

1. Contain ONE logical change only
2. Be self-contained and complete
3. Not break the build if applied independently

For each group of changes you identify:
- List the specific files that belong together
- Generate a clear, descriptive commit message following conventional commits format
- Explain WHY these changes belong in one commit

Then execute the `git add` and `git commit` commands for each atomic commit in the order they should be applied.

Format each commit message as:
```
type(scope): brief description
```

Common types: feat, fix, refactor, docs, test, chore, style, perf
