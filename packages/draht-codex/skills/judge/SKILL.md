---
name: judge
description: The judge queue — a human-judgment TUI that collects open decisions (permission prompts, finished turns) from every agent session on this machine so the user can swipe through them with comments. Use when the user asks to open, start, or check judge, asks why a permission prompt is waiting, or when a "[judge]" feedback block appears in context.
---

# judge

`judge` is a tinder-style TUI over the decisions this machine's agent sessions are waiting on. It cannot run inside an agent session — it needs its own terminal pane.

## When the user asks to open it

Run this immediately (no confirmation) and report the one-line result:

    judge open

That pops a new cmux split to the right with the TUI running. If it prints that cmux is not found, tell the user to run `judge` in any other terminal pane. If it says "already running", say so.

If `judge` is not on PATH, the same binary ships with this plugin at `${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$HOME/.draht/codex-marketplace/plugins/draht}}/bin/judge` — run it by path, and tell the user the plugin installer can link it onto PATH for them.

Other commands: `judge list` (print the queue), `judge clear` (expire every open card). In the TUI, `u` undoes the last review decision — it pulls the feedback back, or sends a retraction when it was already delivered.

Only substantive turns become REVIEW cards: a file was edited, or there were at least 4 tool calls, or the reply ran to 700 characters or more. Slash-command turns without edits are skipped.

## What feeds it

- **PermissionRequest hook** — while judge is running, permission prompts from any session become PERMISSION cards and the session waits for the swipe (→ allow, ← deny; a comment on a deny is delivered as the denial message). If judge is not running, the normal permission dialog appears instead.
- **Stop hook** — every finished turn becomes a REVIEW card carrying project, branch, files touched, shell commands, and the final reply. A newer turn replaces that session's older open review card.

## Feedback delivery

A ← reject, or an approve carrying a comment, is written to that session's inbox. It reaches the session as a `[judge] Human review feedback…` block — either as additional context on the next user prompt, or by blocking the next Stop so the session continues immediately.

When you see a `[judge]` block: it is the human's verdict on your last turn. Address it before anything else — re-examine the rejected work critically and fix what the comment points at. If the reject carried no comment, ask what was off.

## State

Everything lives under the host config dir, in `$CLAUDE_CONFIG_DIR/judge`: `cards` for the queue, `inbox/<session>` for undelivered feedback, and `heartbeat`, touched once a second while the TUI runs. The draht status line reads the same directory to show its `⚖ N` segment.
