---
description: Resume from the CONTINUE-HERE handoff document
allowed-tools: Bash, Read, Write, Edit
---

# /resume-work

Resume from last session state.

> **Tool note**: Invoke `draht-tools <subcommand>` as `node "${CLAUDE_PLUGIN_ROOT}/bin/draht-tools.cjs" <subcommand>` via the Bash tool.

## Atomic Reasoning

Before resuming, decompose handoff context into atomic reasoning units:

1. **State the logical component** — What phase/task was active? What was the last accomplishment? What decisions were made?
2. **Validate independence** — Are there blockers? What changed since the pause? Is the codebase in the expected state?
3. **Verify correctness** — Is the handoff document complete? Does the current state match what was documented? Can work continue safely?

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
