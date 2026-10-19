---
disable-model-invocation: true
name: triage
description: Run the Draht triage command when the user explicitly selects that workflow to classify an external issue report.
---

# Draht Command: triage

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `debugging-workflow`, `epistemics`, or `unslop` when the command template calls for that discipline.
