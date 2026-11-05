---
description: Configure repository code and documentation budgets, inspect usage, or start a new task
argument-hint: "[configure|status|new]"
allowed-tools: Bash, Read, Write, Edit
---

# /budget

Request: $ARGUMENTS

Budgets are opt-in: they apply only in repositories with `.draht/budgets.json`. Run `node "<BUDGET_RUNTIME>" <action>` from the current session's project directory, not the plugin directory. Its actions are `config` and `status`.

- **status**: run `status`, report its result, and stop without editing configuration.
- **new**: only the user can start a new task, by submitting this command with `new` as the whole prompt; the budget hook then resets the task. If the context confirms "Budget task reset by the user's command", run `status` and report the new limits. Otherwise say that no reset happened.
- **No argument or configure**: guide the configuration workflow below. Treat additional settings in the request as choices already given.

1. Run `config`. Its JSON contains `configPath`, `exists`, `enabled`, `limits`, and `exclude`, resolved from the current Git working tree; `exists: false` means budgets are off in this repository. Read the existing file when present. If validation fails, report the exact error and offer corrected JSON. Without a Git working tree, explain the requirement and stop; do not initialize one.
2. Briefly show the current settings. Ask one compact question for choices still missing; honor existing settings and choices already supplied. Offer defaults of 5,000 tokens per code file and 1,500 per documentation file, 250 tokens of growth per task for files already over their limit, and both task totals disabled. Lockfiles, `CHANGELOG.md`, and files marked `linguist-generated` in `.gitattributes` are never measured; ask which other generated paths belong in `exclude`. Ask about task totals only if the user wants them. These are local content tokens, not model billing or chat limits.
3. Once choices are clear, write only `configPath` with `enabled`, `maxFileTokens`, `maxDocFileTokens`, `maxCodeTokens`, `maxDocTokens`, `maxOversizedGrowthTokens`, and `exclude`. File limits are positive safe integers and the growth allowance is a non-negative one; task limits accept positive safe integers or `null` to disable. `exclude` holds glob patterns: one without `/` matches a name at any depth, one with `/` is relative to the repository root, and a trailing `/` matches everything below a directory. Create `.draht/` if needed.
4. Run `config` again to validate the saved file. Report the path and selected settings. A repository without an active task starts one at the next prompt; an active task keeps its settings until the user starts a new one. Never reset the task automatically, and never edit or delete the budget files under `.git`.

This workflow edits only `.draht/budgets.json`: no source refactoring, other configuration, documentation, or commits.
