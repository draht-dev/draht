---
name: map-codebase
description: Draht command prompt wrapper for map-codebase. Use when the user selects the Draht map-codebase workflow or wants architecture, domain, and test strategy extracted from an existing codebase.
---

# Draht Command: map-codebase

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
