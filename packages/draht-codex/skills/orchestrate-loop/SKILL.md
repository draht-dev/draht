---
name: orchestrate-loop
description: Draht command prompt wrapper for orchestrate-loop. Use when the user selects the Draht orchestrate-loop workflow or wants to run a verification-gated loop of fresh subagent iterations until a deterministic check passes.
---

# Draht Command: orchestrate-loop

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `loop-workflow`, `tdd-workflow`, `verification-gate`, or `debugging-workflow` when the command template calls for that discipline.
