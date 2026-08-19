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
# Default: binds loopback (127.0.0.1) only
bun src/cli.ts --auth <your-token>

# Custom port
bun src/cli.ts --port 7878 --auth <your-token>

# Write a starter config and exit
bun src/cli.ts --init-config
```

Every value-taking flag (`--port`, `--host`, `--auth`, `--token`) refuses a
value that is itself a flag, so `--auth --allow-non-loopback` errors instead of
quietly using the literal string `--allow-non-loopback` as the bearer token and
dropping the opt-in.

### Configuration

`--init-config` creates `~/.draht/gateway.config.json` and prints the path, or
prints that the file already exists and leaves it untouched. Either way it exits
`0`. The generated file holds a bearer token that is equivalent to shell access
as your user, so it is written `0600` inside a `0700` directory.

Creation is not the only moment that matters: an install upgraded from a version
that predates that rule still carries the world-readable file the old code wrote.
So every load also repairs an over-permissive config — `0644` becomes `0600`, and
a `~/.draht` left at `0755` becomes `0700` — and says on stderr what it changed.
The repair only ever removes group and other bits, never adds any; it skips a
symlinked config path and a directory that is not `~/.draht`; and where mode bits
do not describe access (Windows) or cannot be changed, it warns instead of failing
the load.

The config file is type-checked on load. A field present with the wrong type
(`"host": 123`) is reported by name and file and stops startup, rather than
degrading silently or crashing inside the bind guard.

### Security: loopback by default

`POST /sessions` accepts an arbitrary `command` array and spawns it with your
user's privileges. A gateway bound to a reachable interface is therefore remote
code execution for anyone holding a bearer token.

Because of that the gateway binds `127.0.0.1` by default and **refuses to start**
on a non-loopback host unless you pass `--allow-non-loopback`:

```bash
$ bun src/cli.ts --host 0.0.0.0 --auth mytoken
Refusing to bind non-loopback host '0.0.0.0'.
...
```

Loopback means exactly `127.0.0.1`, `::1`, or `localhost`. Everything else —
`0.0.0.0`, LAN addresses, and Tailscale `100.x` addresses — is non-loopback.

The guard also fires for a host that came from `~/.draht/gateway.config.json`,
so an older config file still carrying `"host": "0.0.0.0"` will be caught too.

It is enforced on the library surface as well, not only in argv parsing:
`createServer({ host })` and `startGateway({ host })` refuse a non-loopback host
unless the embedder passes `allowNonLoopback: true`.

```ts
import { startGateway } from "@draht/gateway";

// Throws: Refusing to bind non-loopback host '0.0.0.0'.
startGateway({ port: 7878, host: "0.0.0.0", authToken });
```

Prefer `startGateway`: it owns the `Bun.serve` call, so the refusal happens before
a socket exists. `createServer` hands back an `app` that *you* bind, and a returned
hostname is only advice — `Bun.serve` with no `hostname` binds every interface
while still reporting `server.hostname === "localhost"`. So the app carries the
posture itself: without `allowNonLoopback`, any request whose peer is not on this
machine is answered `403` and the first one is logged. Serving the app off-box
therefore exposes nothing; it does not silently work.

**Scope:** this is the gateway's own bind posture. It is *not* a closure of the
`GSEC-04` finding in `.planning/geist/SECURITY-2026-07-13.md`, whose named
component is the pairing server — code this package does not contain. That
pairing finding remains open and is tracked separately.

### Tailscale Access

Do **not** widen the bind to reach the gateway from another device. Keep it on
loopback and put `tailscale serve` in front of it:

```bash
# On your Mac: gateway stays on loopback
bun src/cli.ts --auth mytoken123

# Publish it to your tailnet (TLS-terminated, MagicDNS name)
tailscale serve --bg http://127.0.0.1:7878

# From your phone/Quest 3
curl -H "Authorization: Bearer mytoken123" https://your-machine.your-tailnet.ts.net/health
```

`tailscale serve` terminates TLS with a real certificate on a stable MagicDNS
name. Quest-browser and iOS clients need that: they require `wss://` with a
trusted certificate, and a bare `ws://100.x` address will not work for them.

Never use `tailscale funnel` — that publishes the gateway to the public internet.

See [TAILSCALE_SETUP.md](TAILSCALE_SETUP.md) for the full walkthrough, including
the `--allow-non-loopback` escape hatch and when it is (rarely) appropriate.

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
