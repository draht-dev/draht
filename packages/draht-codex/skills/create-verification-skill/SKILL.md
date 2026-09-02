---
name: create-verification-skill
description: Draht command prompt wrapper for create-verification-skill. Use when a project has no scripted way to prove UI/CLI/service behaviour and the user wants a committed project-local verify-<app> skill that launches the real app, drives a feature the way a user does, and captures proof artifacts. Triggers on "create a verification skill", "make a control skill for this repo", "how do we prove the app actually works", "drive the app like a user".
---

# Draht Command: create-verification-skill

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `atomic-reasoning` or `verification-gate` when the command template calls for that discipline.
