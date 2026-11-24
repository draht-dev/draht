---
name: grill
description: Grill an idea, spec, plan, or decision with critical questions. Use when the user asks to grill or stress-test it.
---

# Draht Command: grill

This skill exposes the Draht prompt command template to the host's skill-invocation surface.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht skills such as `unslop` or `questionnaire` when the command template calls for them.
