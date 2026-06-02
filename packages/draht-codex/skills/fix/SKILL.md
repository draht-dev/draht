---
name: fix
description: Draht command prompt wrapper for fix. Use when the user selects the Draht fix workflow or wants systematic root-cause debugging with TDD discipline.
---

# Draht Command: fix

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `../../commands/fix.md` relative to this `SKILL.md`.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
