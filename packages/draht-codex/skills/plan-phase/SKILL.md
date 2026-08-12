---
name: plan-phase
description: Draht command prompt wrapper for plan-phase. Use when the user selects the Draht plan-phase workflow or wants to create atomic execution plans for a roadmap phase.
---

# Draht Command: plan-phase

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
