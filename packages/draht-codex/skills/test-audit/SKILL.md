---
name: test-audit
description: Draht command prompt wrapper for test-audit. Use when the user wants to audit test value, remove low-value tests, or gate a new test at its owning behavior boundary.
---

# Draht Command: test-audit

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
