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
# Bind to all interfaces (default - Tailscale-friendly)
bun src/cli.ts --auth <your-token>

# Custom port
bun src/cli.ts --port 7878 --auth <your-token>

# Bind to specific interface (e.g., localhost only)
bun src/cli.ts --host 127.0.0.1 --auth <your-token>

# Bind to Tailscale IP directly
bun src/cli.ts --host 100.72.9.11 --auth <your-token>
```

### Tailscale Access

By default, the gateway binds to `0.0.0.0` (all interfaces), making it accessible over Tailscale:

```bash
# On your Mac
bun src/cli.ts --auth mytoken123

# From your phone/Quest 3 (replace with your Tailscale IP)
curl -H "Authorization: Bearer mytoken123" http://100.72.9.11:7878/health
```

Find your Tailscale IP with:
```bash
tailscale status | grep "$(hostname)"
```

## Client

[Adler](https://github.com/draht-dev/adler) — the eagle eye Flutter client for Android + Quest 3.

### Creating Sessions from Adler

Adler creates sessions with an empty body, which creates a placeholder session:

```http
POST /sessions HTTP/1.1
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

(empty body)
```

This creates a session with `status: "starting"` but no backing process. To spawn an actual draht process, send:

```json
{
  "command": ["draht", "start"]
}
```

## Status

Experimental. Part of the [draht](https://github.com/draht-dev/draht) ecosystem.
