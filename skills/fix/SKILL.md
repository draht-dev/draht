---
disable-model-invocation: true
name: fix
description: Run the Draht fix command when the user explicitly selects its root-cause debugging and TDD workflow.
---

# Draht Command: fix

This skill exposes the Draht prompt command template to the host's skill-invocation surface.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
