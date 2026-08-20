---
description: Create a CONTINUE-HERE handoff document for session continuity
allowed-tools: Bash, Read, Write, Edit
---

# /pause-work

Create a handoff document for session continuity.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Steps
1. Run `git status` and `git diff --stat` to see uncommitted changes
2. Read `.planning/STATE.md` for current phase/status
3. Write `.planning/CONTINUE-HERE.md` with:
   - `## Current Phase` — which phase and plan is active
   - `## Last Completed` — last task or milestone that finished cleanly
   - `## In Progress` — what is partially done (be specific: file paths, failing tests)
   - `## Uncommitted Changes` — list of modified files and why
   - `## Decisions Made This Session` — any design decisions or context
   - `## Next Steps` — exact commands to run when resuming
   - `## Blockers` — anything waiting on external input or clarification
4. **Distill lessons before the context is lost**: for anything this session tried that failed, or an approach that worked against expectations, append one dated bullet to `.planning/STATE.md` under `## Lessons` (create the section before `## Blockers` if missing). Lessons name what to do differently — "runner hits TLS issue in PowerShell, use bash", not "had problems with tests".
5. Update `.planning/STATE.md` last activity timestamp via `draht-tools update-state`
6. Commit: `draht-tools commit-docs "pause work — handoff"`
7. Tell the user: "Resume with `/resume-work` in a fresh session."

## Rules
- Be specific — "fix bug in auth" is useless; "null check in src/auth/session.ts:42, test reproducing in test/auth-null.test.ts" is useful
- Include exact commands, not vague directions
- Capture any in-flight decisions or trade-offs being weighed
