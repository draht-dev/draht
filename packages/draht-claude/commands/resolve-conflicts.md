---
description: Resolve an in-progress git merge or rebase conflict by reconstructing both sides' intent
argument-hint: "[branch or context, e.g. agent/<taskId>]"
allowed-tools: Bash, Read, Write, Edit
---

# /resolve-conflicts

Resolve an in-progress git merge, rebase, or cherry-pick conflict by reconstructing the intent of both sides — never by picking a side blind.

## Usage
```
/resolve-conflicts [branch or context]
```

Context: $ARGUMENTS

## When This Applies

- `git status` reports unmerged paths — a merge, rebase, or cherry-pick is mid-flight.
- A draht subagent run reported a failed worktree merge-back: the agent's work sits on an unmerged `agent/<taskId>` branch. Run `git merge agent/<taskId>` first to enter the conflict, then continue here.

## The Iron Law

> **EVERY HUNK RESOLUTION MUST BE JUSTIFIED BY THE RECOVERED INTENT OF BOTH SIDES. NO INTENT, NO RESOLUTION.**

A conflict is two changes with a reason each. Until you can state both reasons, you are not resolving — you are guessing.

## Phase 1 — Map the Conflict

1. `git status` — list every conflicted file.
2. Classify the operation: merge, rebase, or cherry-pick. Identify which ref is "ours" and which is "theirs" — a rebase swaps the intuitive meaning.
3. State the operation's goal in one sentence: what is this merge or rebase trying to bring in?
4. Read every conflict marker in full — all of them — before resolving any.

## Phase 2 — Intent Archaeology

For each side of each conflicted area, recover why the change was made:

- Commit messages: `git log --merge -p -- <file>` shows the commits touching the conflicted file from both sides.
- Each side's diff against the merge base: `git diff <base> <side> -- <file>`.
- PRs, issues, or tickets referenced in those commit messages.
- Planning documents (for example under `.planning/`) when the project keeps them.

Exit criterion: a one-sentence intent statement per side, per conflicted area. If an intent cannot be determined, STOP and ask the user — do not guess.

## Phase 3 — Resolve Hunk by Hunk

- Preserve both intents wherever they are compatible.
- Where they are incompatible, pick the side that matches the operation's stated goal and RECORD the trade-off — every recorded trade-off must appear in the merge commit message in Phase 5.
- Never invent behaviour that exists on neither side.
- If no stated goal decides an incompatibility, STOP and ask the user.
- Do not run `--abort` on your own. Aborting can be the right escape hatch — draht's own worktree isolator aborts failed merge-backs to keep the base branch clean — but it discards resolution work, so it is the user's call. Stop and ask instead.

## Phase 4 — Run the Project's Checks

Discover the project's own gates — package scripts, Makefile, CI config — and run them in order: typecheck, then tests, then lint/format. Fix what the merge broke, under the same rule: no invented behaviour.

## Phase 5 — Finish the Operation

- Merge: stage the resolved files and commit. The merge commit message names each recorded trade-off — which intent won where, and why.
- Rebase or cherry-pick: `git rebase --continue` / `git cherry-pick --continue` until every commit is replayed.
- Never `--no-verify`.

## Red Flags — STOP

Stop immediately if you catch yourself:
- Resolving a hunk whose "why" you cannot state for both sides
- Taking one side wholesale because it is newer, bigger, or yours
- Introducing behaviour that exists on neither side
- Finishing with failing checks, or reaching for `--no-verify`
- Running `--abort` without explicit user sign-off
