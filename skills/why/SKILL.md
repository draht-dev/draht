---
name: why
description: Draht command prompt wrapper for why. Use when the user asks why code is the way it is — design rationale, the history of a decision, rejected alternatives, "why do we do X instead of Y", "was this intentional", or where a threshold value came from — and the answer must be reconstructed from git history, the review record, and planning documents with calibrated confidence. Triggers on "why was this built", "why do we", "what's the history of", "design rationale", "code archaeology".
---

# Draht Command: why

This skill exposes the Draht prompt command template to the host's skill-invocation surface.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning`, `epistemics`, or `verification-gate` when the command template calls for that discipline.
