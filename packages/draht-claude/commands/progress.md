---
description: Show current GSD project status (milestone, phase, task, blockers)
allowed-tools: Bash, Read
---

# /progress

Show current project status.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Steps
1. Read `.planning/STATE.md` for current phase and status
2. Read `.planning/ROADMAP.md` and extract all phases with their status
3. Check for `.planning/CONTINUE-HERE.md` (paused session)
4. Read `.planning/execution-log.jsonl` for the last 10 entries
5. Report:
   - Current phase and status
   - Milestone completion (X of Y phases complete)
   - Recent activity (last 5 task results)
   - Any blockers or paused work
   - Next suggested command based on state (e.g., `/resume-work`, `/discuss-phase N+1`)
