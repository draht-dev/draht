---
name: next-milestone
description: Draht command prompt wrapper for next-milestone. Use when the user selects the Draht next-milestone workflow or wants to plan the next milestone after all current phases are complete.
---

# Draht Command: next-milestone

This skill exposes the Draht prompt command template to the host's skill-invocation surface.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
