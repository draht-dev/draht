---
name: triage
description: Draht command prompt wrapper for triage. Use when the user pastes an external issue report — a bug report, support ticket, `gh issue view` output, or forwarded user complaint — and wants it classified and routed rather than fixed. Classifies (bug / performance / feature request / question / reroute) after a bounded cause trace, dedupes against GitHub Issues with typed outcomes, creates a tracker issue only behind a strict all-conditions gate, and ends with one typed verdict marker. Triggers on "triage this", "someone reported", "is this a bug or a feature request", "should we file this", or a pasted issue report.
---

# Draht Command: triage

This skill exposes the Draht prompt command template to Codex's `$draht` and `/skills` surfaces.

When invoked:
1. Read `./command.md` in this skill's directory.
2. Treat the user's text after the skill mention as `$ARGUMENTS`. If the template uses `$1`, use the first positional argument.
3. Follow that command template as the active workflow.
4. Use Draht support skills such as `debugging-workflow`, `epistemics`, or `unslop` when the command template calls for that discipline.
