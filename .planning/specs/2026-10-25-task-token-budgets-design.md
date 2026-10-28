# Token budgets

Date: 2026-10-25, revised 2026-10-26 after review

Oskar wants readable, cohesive code and concise, precise documentation. Per-file
limits are the primary guardrail; shared task totals are optional. Accounting is
deterministic, with no limits on chat responses.

## Policy

All three hosts use the same packaged policy: coding-agent, draht-claude, and
draht-codex. Use the pinned `gpt-tokenizer` 4.1.0 `cl100k_base` encoding offline.
This is a common accounting unit, independent of the active model's tokenizer.
Source text resembling special tokens is counted as ordinary text.

Budgets are opt-in. A Git repository takes part once `.draht/budgets.json`
exists or a task is active; elsewhere every adapter does nothing, stores nothing,
and adds no prompt text. `/budget` in each host guides the user through writing
the file. Defaults are `maxFileTokens: 5000` for code, `maxDocFileTokens: 1500`
for documentation, and `maxOversizedGrowthTokens: 250`. `maxCodeTokens` and
`maxDocTokens` default to `null`, leaving task totals unlimited. File limits are
positive safe integers; the growth allowance is a non-negative one. An explicit
`enabled: false` turns budgets off at the next new task.

Limits are ceilings; aim for the smallest clear solution, not a filled allowance.
Guidance should favor cohesive modules and docs about contracts, setup, and
non-obvious decisions. Avoid restating code, status diaries, minification, and
arbitrary file splits to satisfy a limit. Size limits do not score code quality.

Measure the current patch against a fixed task-start snapshot. Count the tokens
in added and deleted diff hunks separately. A replacement costs both sides;
unchanged text costs nothing. Diffs exceeding 4,096 line edits are charged as
complete file replacements. A file that already exceeded its limit at task start
may grow by `maxOversizedGrowthTokens`; other files must stay within the limit.
A moved file is measured against the deleted file it most resembles, when at
least half of its tokens survive. Markdown, MDX, reStructuredText, AsciiDoc, and
text files use the documentation limits, except `CMakeLists.txt` and pip
requirement lists. Other text files, including tests, use code.

## Scope

Budgets measure text files Git tracks plus untracked files `.gitignore` does not
exclude. Never measured: lockfiles, `CHANGELOG.md`, credential files (which are
never copied into the ledger), files marked
`linguist-generated` by the `.gitattributes` in the commit checked out at task
start, paths matching the configured `exclude` globs, files outside the
repository, ignored files, binary files, symlinks, and nested repositories.
Writes to unmeasured files pass unchecked from edit tools and the shell alike.
Source files with invalid UTF-8 are decoded lossily and counted.

## Task lifetime and sharing

The first budget event in a configured repository starts a task. The task
persists across prompts, host restarts, commits, and pulls until the user starts
a new one. Configuration and the starting snapshot are fixed for that task.
Existing changes are part of the starting snapshot; pulled changes count.

Only the user starts a new task: the native `/budget new` command, or the plugin
command with `new` submitted as the whole prompt, which the prompt hook detects.
The packaged CLI cannot start a task, and edit tools cannot change ledger files.
A marker outside the ledger directory records the active task, so deleting the
ledger fails the final gate instead of starting a new allowance.

One active task is shared by hosts in the same Git repository, including linked
worktrees. Each participating worktree gets its own starting snapshot. A removed
worktree's changes still count toward task totals; its file limits no longer
apply because nobody can repair them. Identical merged contributions are
deduplicated.

## Enforcement

Preflight supported write and edit payloads against the prospective workspace.
Refuse a change only when it creates or enlarges an excess. Audit after tool
execution and before completion to detect shell-written changes; the plugins
audit after their project checks. Budget failures report the measured cost and
limit and block completion for three repair attempts per user prompt in every
host; after that the run ends with the excess reported. Audits never undo a
shell command.

An inspection that cannot run, such as invalid configuration or a damaged
ledger, never blocks tools. Natively it reports the run as unchecked; in the
plugins the first Stop blocks with instructions and a host retry reports the
error without blocking. Edits whose preview the host would reject run anyway, so
the host reports its own error.

The native host registers a builtin that runs the runtime in a child process, so
checks never block the session. Both plugins register thin lifecycle hooks and
run the final audit from their stop gate. All adapters use the same generated
standalone runtime with compressed tokenizer data, loaded only when a change
needs measuring; plugin execution needs no network or dependency install.
Per-worktree caches of file metadata and token counts keep repeated checks
cheap; a new task discards them.
Generation checks detect drift between source and every shipped runtime,
comparing the vocabulary after decompression.

## Evidence required

- Token counts are repeatable for Unicode, code, and special-token spellings.
- Unconfigured repositories get no prompt text, no checks, and no ledger.
- Rejected native writes leave files unchanged.
- Dirty starting files and commits preserve the task's accounting boundary.
- Parent and child worktree changes consume the same allowance; a removed child cannot block the parent.
- Shell-produced excess fails the final gate in all three adapters.
- Excluded files, out-of-scope writes, moved files, and the growth allowance behave as specified.
- Cached metadata never hides a change made within the file system's timestamp granularity.
- Only a user prompt or the native command starts a new task.
- Run each changed test file and the repository `npm run check` command.

## Tradeoff

Prompt instructions alone cannot enforce these limits. Full filesystem mediation
would prevent arbitrary shell writes before they happen, but requires a different
sandbox architecture. Preflight plus a final deterministic gate bounds accepted
work without adding that architecture. Code running in the repository can still
edit the ledger, so the gates resist accidents and casual workarounds, not
deliberate tampering. Token limits control size and scope; formatting, tests,
and review remain necessary for code quality.
