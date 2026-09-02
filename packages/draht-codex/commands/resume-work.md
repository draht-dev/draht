---
description: Resume from the CONTINUE-HERE handoff document
allowed-tools: Bash, Read, Write, Edit
---

# /resume-work

Resume from last session state.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Steps
1. Read `.planning/CONTINUE-HERE.md` (if missing, tell the user there's nothing to resume)
2. Read `.planning/STATE.md` for current phase/status
3. Run `git status` to check current working state
4. Compare handoff document's "Uncommitted Changes" to actual git state — report any discrepancies
5. Summarize to the user:
   - What was in progress
   - What the next step is
   - Any blockers to resolve first
6. Delete `.planning/CONTINUE-HERE.md` only after the user confirms work is resumed
7. Proceed with the next step from the handoff

## Rules
- Do not auto-execute the next step — confirm with the user first
- If the codebase state doesn't match the handoff (e.g., uncommitted changes missing), flag it before proceeding
- Preserve CONTINUE-HERE.md until the user acknowledges; this is the safety net
