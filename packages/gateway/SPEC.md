# Draht Gateway + Flutter Client

## Vision

Transform the OpenClaw gateway pattern into a first-class Draht package:
`@draht/gateway` — a standalone WebSocket/HTTP session gateway that ships
inside the draht monorepo and connects any app to draht coding agents.

Paired with a Flutter client that runs on Meta Quest 3 (spatial UI) and
mobile (iOS/Android), giving users a portable interface to spawn and manage
multiple draht sessions from anywhere.

---

## Components

### 1. `@draht/gateway` (Bun + TypeScript)

A WebSocket/HTTP server that:
- Spawns and manages draht coding agent processes
- Streams agent output (stdout/events) to connected clients in real-time
- Accepts user input from clients and forwards to the correct agent session
- Supports multiple simultaneous sessions
- Auth via bearer token (configurable)
- REST API: `POST /sessions`, `GET /sessions`, `DELETE /sessions/:id`
- WebSocket: per-session bidirectional stream
- SSE: event stream for session lifecycle events
- CLI: `draht gateway start --port 7878 --auth <token>`
- Designed to run over Tailscale (remote access from Quest/mobile)

### 2. Draht Flutter Client

Cross-platform Flutter app targeting:
- **Meta Quest 3** (Android/Flutter): spatial window UI, each session = floating panel
- **Mobile** (iOS/Android): tab/swipe UI, same codebase

Features:
- Connect to gateway via URL + token (stored securely)
- List active sessions
- Spawn new sessions with a prompt
- Real-time streaming output display per session
- Send follow-up prompts to any session
- Session status indicators (working / idle / done)
- Voice input (Quest + mobile)

---

## Stack

- **Gateway:** Bun, TypeScript, `@draht/coding-agent`, WebSocket (ws), Hono (HTTP)
- **Flutter client:** Flutter 3.x, Dart, `web_socket_channel`, `provider` or `riverpod`
- **Auth:** Bearer token, Tailscale for remote access
- **Target platforms:** Linux/macOS (gateway), Android/Quest 3 + iOS (client)

---

## Non-Goals

- No cloud hosting — local/self-hosted only
- No SST deploy
- No react-intl

---

## Success Criteria

- `draht gateway start` runs and accepts WebSocket connections
- Flutter app connects, lists sessions, spawns a new one, streams output
- App runs on Meta Quest 3 as standalone Android app
- Gateway ships as `packages/gateway` in the draht monorepo
