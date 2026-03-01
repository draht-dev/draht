---
description: "Analyze changes and create atomic commits"
---

# Git Atomic Commit Analysis

First, check the current status:

*! git status*

Now get the full diff of all changes:

*! git diff*

And staged changes:

*! git diff --cached*

Based on the changes shown above, analyze and group them into logical, ATOMIC commits. Each commit should:

1. Contain ONE logical change only
2. Be self-contained and complete
3. Not break the build if applied independently

For each group of changes you identify:
- List the specific files that belong together
- Generate a clear, descriptive commit message following conventional commits format
- Explain WHY these changes belong in one commit

Then provide the exact `git add` and `git commit` commands to execute for each atomic commit in the order they should be applied.

Format each commit message as:
type(scope): brief description
- Detailed explanation of what changed
- Why the change was necessary


Common types: feat, fix, refactor, docs, test, chore, style, perf

