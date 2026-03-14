# Quick Task 003: Fix cmux notifications for draht (pi) agent turn end

## Context
The notify extension at `packages/coding-agent/examples/extensions/notify.ts` handles terminal notifications when the agent finishes its turn (`agent_end` event). However, it does not detect cmux and therefore doesn't use `cmux notify` CLI. When running inside cmux, OSC 777 notifications may not surface properly.

cmux exposes env vars: `CMUX_BUNDLE_ID`, `CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`, `CMUX_SOCKET_PATH`.
The CLI command is: `cmux notify --title "Title" --body "Body"`.

## Tasks

<task>
title: Add cmux detection and notification support to notify extension
files:
  - packages/coding-agent/examples/extensions/notify.ts
actions:
  - Add a `notifyCmux(title, body)` function that spawns `cmux notify --title <title> --body <body>`
  - Add cmux detection in the `notify()` function: check for `CMUX_BUNDLE_ID` env var (most reliable indicator)
  - Place cmux check BEFORE the existing checks (WT_SESSION, KITTY_WINDOW_ID, OSC 777 fallback) since cmux sets CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION which could cause false matches
verification:
  - Review the updated notify.ts to confirm cmux detection logic is correct
  - Run `npm run check` from repo root to verify no type errors
</task>