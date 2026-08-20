---
name: speak
description: Draht command prompt wrapper for speak. Use when the user wants text spoken aloud — voice output, text-to-speech, "say it", "read it to me", "sprich", "vorlesen" — or wants a spoken summary of a result via the ElevenLabs API.
---

# Draht Command: speak

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
