# @draht/gateway

> ⚠️ **Experimental** — API is unstable and subject to change.

The draht gateway is a lightweight WebSocket + SSE server that spawns and manages draht coding agent processes, exposing them over HTTP for remote clients.

## What it does

- Spawns draht agent processes on demand
- Streams agent stdout to connected WebSocket clients in real time
- Forwards client stdin to agent processes
- Exposes a REST API for session lifecycle management
- Server-Sent Events for session status fan-out

## Usage

```bash
bun src/cli.ts --port 7878 --auth <your-token>
```

## Client

[Adler](https://github.com/draht-dev/adler) — the eagle eye Flutter client for Android + Quest 3.

## Status

Experimental. Part of the [draht](https://github.com/draht-dev/draht) ecosystem.
