# Token budgets

The coding agent, draht-claude, and draht-codex share per-file token limits that
encourage readable, cohesive code and concise documentation. Budgets are opt-in:
they apply only in Git repositories that contain `.draht/budgets.json`. Chat
responses have no budget.

Limits are ceilings: aim for the smallest clear solution, not a filled allowance.
Document contracts, setup, and non-obvious decisions; avoid restating code or
keeping status diaries. Do not minify code or split files arbitrarily to fit.
These are size guardrails, not quality scores.

## Setup

Run `/budget` in draht, `/draht:budget` in Claude Code, or `$draht:budget` in
Codex. The agent proposes defaults, asks for missing choices, and writes only
`.draht/budgets.json` at the repository root:

```json
{
  "maxFileTokens": 5000,
  "maxDocFileTokens": 1500,
  "maxOversizedGrowthTokens": 250,
  "maxCodeTokens": null,
  "maxDocTokens": null,
  "exclude": ["packages/*/dist/", "*.generated.ts"]
}
```

These are the defaults, apart from the example `exclude` patterns. File limits
are positive integers. `maxOversizedGrowthTokens` is how far a file that was
already over its limit when the task started may grow; `0` freezes such files.
The optional task totals cap changed tokens across the task; `null` leaves them
unlimited. `"enabled": false` turns budgets off at the next new task.

## What is measured

Tokens use the bundled `cl100k_base` encoding from pinned
[gpt-tokenizer](https://github.com/niieani/gpt-tokenizer), counted offline. The
active model does not change the count.

The budget covers text files that Git tracks, plus untracked files that
`.gitignore` does not exclude. Markdown, MDX, reStructuredText, AsciiDoc, and
`.txt` files use the documentation limit, except `CMakeLists.txt` and pip
requirement lists; everything else, tests included, is code. Source files with
invalid UTF-8 are decoded lossily and still counted.

Never measured:

- lockfiles such as `bun.lock`, `package-lock.json`, `go.sum`, and `Cargo.lock`
- `CHANGELOG.md` files
- credential files such as `.env*`, `.npmrc`, `*.pem`, and SSH keys, which are
  never copied into the ledger
- files marked `linguist-generated` in the `.gitattributes` committed at task start
- paths matching `exclude`: a pattern without `/` matches a name at any depth, one
  with `/` is relative to the repository root, and a trailing `/` matches a
  directory; `*`, `?`, and `**` are supported
- files outside the repository, ignored files, binary files, symlinks, and nested
  repositories

Writes to unmeasured files pass unchecked, whether they come from edit tools or
the shell. A file that Git starts ignoring during a task, or that a nested
repository takes over, does not count while it stays out; when it returns, it
is measured against its starting content again.

A change costs the tokens in its added lines plus the tokens in its deleted
lines, measured against the task's starting snapshot. Replacing a 100-token block
with an 80-token block costs 180 tokens; unchanged lines are free, and redrafts
do not add up. Diffs with more than 4,096 line edits are charged as whole-file
replacements. A moved file is measured against its old content when at least
half of it is unchanged, so moving a file costs only its edits and keeps its
limit.

## Tasks

The first budget event in a configured repository starts a task. Its snapshot
includes existing changes, and its settings stay fixed until a new task.
Commits, restarts, new prompts, and pulls do not reset it; pulled changes count
as changes, so start a new task after pulling.

The main agent, subagents, and linked worktrees of the repository share one
task. A removed worktree's changes still count toward task totals, but its file
limits no longer apply.

Only the user starts a new task: `/budget new` in draht, or `/draht:budget new`
and `$draht:budget new` submitted as the whole prompt in the plugins. Agents
cannot reset the task. Edits to `.draht/budgets.json`, including an agent's,
apply only from the next new task, so review the file before starting one.

## Enforcement

Edit tools are checked before they run; a change that creates or enlarges an
excess is refused, while changes that leave the excess the same size or reduce
it proceed. Audits after tools and before completion catch shell writes; plugins
audit after their project checks, so formatter output counts. An excess blocks
completion for three repair attempts per prompt; after that the run ends with
the excess reported. Audits never roll files back.

When a check cannot run, for example because `.draht/budgets.json` is invalid or
the ledger is damaged, tools keep working and completion is reported as
unchecked. Fix the configuration or start a new task.

These gates are not a sandbox: code running in the repository can still edit
the ledger. Plugin enforcement requires the host to run trusted hooks.

## Ledger and CLI

The ledger lives in the Git common directory: `draht-budgets/` holds the task
and content snapshots, `draht-budgets.task` records the active task, and
`draht-budgets.lock` serializes access. Per-worktree caches of file metadata
and token counts keep checks fast; a new task replaces the stored snapshots and
caches. Native draht runs checks in a child process, so they never block the
session.

Run the packaged CLI from the project directory:

```sh
node /path/to/plugin/scripts/budgets-runtime.cjs status
node /path/to/plugin/scripts/budgets-runtime.cjs config
```

`config` validates `.draht/budgets.json` without starting or changing a task.
