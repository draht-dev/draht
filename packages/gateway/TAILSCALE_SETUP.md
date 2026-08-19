# Tailscale Setup for draht-gateway

## Overview

The draht gateway binds to **loopback (`127.0.0.1`) only**. Remote devices —
Adler on your phone or Quest 3 — reach it through `tailscale serve`, which
publishes the loopback listener onto your tailnet.

This is not an inconvenience to be worked around. `POST /sessions/:id/input`
drives a `draht` agent process with your user's privileges, and that agent runs
tools on your behalf, so a gateway bound to a reachable interface is remote code
execution for anyone holding a bearer token. Loopback + `tailscale serve` is the
supported path.

> **Scope note.** The loopback-by-default bind posture described here is the
> gateway's own. It does **not** close the `GSEC-04` finding in
> `.planning/geist/SECURITY-2026-07-13.md`: that finding's named component is
> the **pairing server**, which this package does not contain. The pairing
> finding remains open and is tracked separately.

### Why `tailscale serve` and not a wider bind

| | `--host 0.0.0.0` / `--host 100.x` | `tailscale serve` |
|---|---|---|
| Transport | plain `http://` / `ws://` | `https://` / `wss://` with a **real Let's Encrypt certificate** |
| Address | raw `100.x` IP that can change | stable **MagicDNS** name |
| Exposure | every interface the process can see | tailnet only, via the Tailscale daemon |
| Quest browser / iOS clients | **do not work** | work |

That last row is the practical one. The Quest browser and iOS WebView clients
refuse WebSocket connections that are not `wss://` with a certificate they
trust. A bare `ws://100.72.9.11:7878` will not connect from those clients no
matter how the gateway is bound. `tailscale serve` gives you both the TLS
termination and the stable hostname those clients require.

> **Never use `tailscale funnel` for the gateway.** Funnel publishes the service
> to the *public internet*, which turns a token leak into world-reachable remote
> code execution. Use `tailscale serve` (tailnet-only) exclusively.

## Quick Start

### 1. Start the gateway on loopback

```bash
cd draht-mono/packages/gateway
bun start --auth YOUR_SECRET_TOKEN
```

You should see:
```json
{"level":"info","timestamp":"2026-03-09T21:37:40.361Z","message":"draht-gateway listening","host":"127.0.0.1","port":7878}
```

`"host":"127.0.0.1"` is correct. Nothing off this machine can reach it yet.

### 2. Publish it to your tailnet

```bash
tailscale serve --bg http://127.0.0.1:7878
```

Check what got published:

```bash
tailscale serve status
```

You will get an `https://<machine>.<tailnet>.ts.net/` URL. Find the exact name
with:

```bash
tailscale status
```

(the second column is your MagicDNS hostname). MagicDNS must be enabled in your
Tailscale admin console.

### 3. Test from another device

From your phone, Quest 3, or another computer on your tailnet:

```bash
# Health endpoint (no auth required)
curl https://your-machine.your-tailnet.ts.net/health

# Expected response:
{"status":"ok","sessions":0,"uptime":0.123,"version":"0.1.0"}

# Authenticated endpoint
curl -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
     https://your-machine.your-tailnet.ts.net/sessions

# Expected response:
{"sessions":[]}
```

If you get a response, it's working. 🎉

### 4. Make it survive reboots

`tailscale serve --bg` config persists across restarts of `tailscaled`. To take
it down:

```bash
tailscale serve --https=443 off
```

## Common Issues

### ❌ Connection Refused / Timeout

1. **Check the gateway is running locally**:
   ```bash
   curl http://127.0.0.1:7878/health
   ```
   If this fails, the gateway isn't running.

2. **Check the serve mapping exists**:
   ```bash
   tailscale serve status
   ```
   You should see your `https://…ts.net` name mapped to `http://127.0.0.1:7878`.

3. **Check Tailscale is active on both ends**:
   ```bash
   tailscale status
   ```
   Both this machine and the client device must appear and be online.

4. **Check MagicDNS**: if the hostname does not resolve on the client, enable
   MagicDNS in the Tailscale admin console, or test with the `100.x` address of
   the machine (`https://` will fail certificate validation against a raw IP,
   which is itself the reason to use MagicDNS).

You should **not** need a macOS firewall exception. `tailscale serve` proxies
from the Tailscale daemon to loopback, so no new listening socket is opened on
an external interface.

### ❌ "Refusing to bind non-loopback host …"

This is intentional. You passed `--host` with a non-loopback value, or your
`~/.draht/gateway.config.json` still contains an old `"host": "0.0.0.0"`.

Fix the config file:

```json
{
  "host": "127.0.0.1"
}
```

and use `tailscale serve` as above. Only if you genuinely cannot, see
[Escape hatch](#escape-hatch---allow-non-loopback) below.

### ❌ Quest / iOS client won't connect but curl works

Those clients require `wss://` with a trusted certificate. Confirm you are
pointing them at the `https://…ts.net` MagicDNS name and **not** at a
`http://100.x:7878` address.

### ❌ Tailscale IP changed

Stop using IPs. The MagicDNS name from `tailscale serve` is stable and survives
address changes.

## Security Considerations

### ✅ Tailscale security model

- **Encrypted**: all tailnet traffic is WireGuard-encrypted
- **Authenticated**: only your tailnet devices can connect
- **Private**: not exposed to the public internet — *as long as you use `serve`,
  not `funnel`*

### ✅ Gateway security model

- **Loopback by default**: the process itself is unreachable off-box
- **Bearer token**: all API endpoints except `/health` require auth
- **CORS enabled**: allows browser-based clients (Quest browser)

### ⚠️ Known limitation

`POST /sessions` no longer accepts a caller-supplied `command` array — the route
that shape-checked one and handed it to `Bun.spawn` was removed in R32-FLEET.8,
and a body still carrying `command` is refused with 400. Nothing in a request
body decides what gets executed.

That is a removed exposure, not a solved one. **A bearer token is still
equivalent to shell access as your user**: `POST /sessions/:id/input` drives a
`draht` agent, and the agent runs tools. Treat the token as a root-equivalent
secret and keep the bind on loopback.

### 🔒 Best practices

1. **Use a strong token**:
   ```bash
   openssl rand -base64 32
   ```

2. **Store it securely** — in Adler under Settings → Gateways → Bearer Token.
   Don't commit tokens to git; don't share them.

3. **Rotate tokens** periodically and update Adler.

4. **Monitor access** — the gateway logs every request as JSON.

## Escape hatch: `--allow-non-loopback`

> ⚠️ **Read this whole section before using the flag.** It disables the only
> containment boundary the gateway currently has.

If you must bind a non-loopback interface — for example a hermetic CI box on an
isolated network segment where a Tailscale daemon cannot run — pass the flag
explicitly:

```bash
bun start --host 0.0.0.0 --auth YOUR_TOKEN --allow-non-loopback
```

The gateway will start and print a loud warning. What you are accepting:

- every process and device that can route to that interface can reach
  `POST /sessions`;
- with a valid bearer token, that is **arbitrary command execution as your
  user** — not by naming a command in the request (that path is gone), but by
  steering the `draht` agent that `POST /sessions/:id/input` drives;
- the transport is plain `http://` / `ws://` unless you put your own TLS
  terminator in front, so the bearer token crosses the wire in cleartext.

Loopback is exactly `127.0.0.1`, `::1`, and `localhost`. Everything else —
including `0.0.0.0` and every Tailscale `100.x` address — requires this flag.
Embedding the gateway as a library is no way around it: `createServer` and
`startGateway` refuse the same hosts unless you pass `allowNonLoopback: true`, and
an app from `createServer` that you bind yourself still answers `403` to any
request from off this machine unless you passed it.
Binding the Tailscale address directly is **not** the recommended path: it gives
you no TLS and no MagicDNS name, so Quest and iOS clients still cannot use it.

## Advanced Configuration

### Custom port

```bash
bun start --port 8080 --auth mytoken
tailscale serve --bg http://127.0.0.1:8080
```

The public MagicDNS URL stays on 443 regardless of the local port.

### Serving under a path prefix

If you want several services on one machine:

```bash
tailscale serve --bg --set-path /gateway http://127.0.0.1:7878
# → https://your-machine.your-tailnet.ts.net/gateway
```

Make sure the client is configured with the full prefixed URL.

## Testing from Adler

### Configure the gateway in Adler

1. Open Adler
2. Tap **Add Gateway**
3. Enter:
   - **Name**: "My Mac" (or any friendly name)
   - **Gateway URL**: `https://your-machine.your-tailnet.ts.net`
   - **Bearer Token**: `YOUR_SECRET_TOKEN`
4. Toggle **Connect automatically** on

### Verify connection

You should see:
- Green dot next to the gateway name (connected)
- Session count (e.g. "0 sessions")
- Uptime (e.g. "5m 23s")

### Troubleshooting the Adler connection

1. **Test from the same device**: open the browser on the phone/Quest and visit
   `https://your-machine.your-tailnet.ts.net/health`. You should see JSON.
2. **Check Tailscale on the device**: install the Tailscale app, log in with the
   same account, and confirm the device appears in `tailscale status`.
3. **Check the URL scheme**: it must be `https://`, not `http://`.
4. **Check the token**: copy-paste exactly, no extra spaces; tokens are
   case-sensitive.

## Network Architecture

```
┌──────────────────────────────────────────────┐
│  Your Mac                                    │
│  ┌────────────────────────────────────────┐  │
│  │  draht-gateway                         │  │
│  │  Listening on: 127.0.0.1:7878          │  │
│  │  (loopback only — unreachable off-box) │  │
│  └───────────────▲────────────────────────┘  │
│                  │ loopback proxy            │
│  ┌───────────────┴────────────────────────┐  │
│  │  tailscaled — `tailscale serve`        │  │
│  │  https://mac.tailnet.ts.net (TLS 443)  │  │
│  └───────────────┬────────────────────────┘  │
└──────────────────┼───────────────────────────┘
                   │
            ┌──────┴──────┐
            │  Tailscale  │
            │ (WireGuard) │
            └──────┬──────┘
                   │
    ┌──────────┬───┴──────┬───────────┐
    │          │          │           │
┌───▼──┐   ┌──▼───┐   ┌──▼───┐   ┌───▼───┐
│Phone │   │Quest3│   │Laptop│   │Server │
│Adler │   │Adler │   │ curl │   │  API  │
└──────┘   └──────┘   └──────┘   └───────┘

All devices must:
✓ Be on the same tailnet
✓ Have Tailscale running
✓ Use the https:// MagicDNS name (not a raw 100.x IP)
```

## Monitoring

### View gateway logs

```bash
cd draht-mono/packages/gateway
bun start --auth mytoken 2>&1 | jq
```

This pretty-prints JSON logs:
```json
{
  "level": "info",
  "timestamp": "2026-03-09T21:37:40.361Z",
  "message": "draht-gateway listening",
  "host": "127.0.0.1",
  "port": 7878
}
```

### Check active sessions

```bash
curl -H "Authorization: Bearer mytoken" \
     https://your-machine.your-tailnet.ts.net/sessions | jq
```

### Monitor events (SSE)

```bash
curl -H "Authorization: Bearer mytoken" \
     -N https://your-machine.your-tailnet.ts.net/events
```

## Performance

### Latency

Typical round-trip times over Tailscale:
- Same network: 1-5ms
- Different networks: 20-100ms
- Cross-continent: 100-300ms

`tailscale serve` adds a local proxy hop; it is not measurable next to the above.

### Bandwidth

- Health checks: < 1 KB/request
- Session list: ~1 KB/session
- Streaming output: ~10-50 KB/s per session
- WebSocket: minimal overhead

### Concurrent connections

Default limits:
- Max sessions: `maxSessions` in config (default 100)
- Max WebSocket connections: no hard limit (memory-bound)
- Max SSE connections: no hard limit (memory-bound)

## Production Deployment

Both examples keep the gateway on loopback and rely on `tailscale serve` for
reachability.

### systemd Service (Linux)

```ini
[Unit]
Description=draht-gateway
After=network.target tailscaled.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/draht-mono/packages/gateway
ExecStart=/usr/bin/bun start --auth YOUR_TOKEN
ExecStartPost=/usr/bin/tailscale serve --bg http://127.0.0.1:7878
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### launchd (macOS)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.draht.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>start</string>
        <string>--auth</string>
        <string>YOUR_TOKEN</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/draht-mono/packages/gateway</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Run `tailscale serve --bg http://127.0.0.1:7878` once; the mapping persists.

## Config File Reference

`~/.draht/gateway.config.json`:

```json
{
  "$schema": "https://draht.io/gateway.schema.json",
  "port": 7878,
  "host": "127.0.0.1",
  "tokens": {
    "default": "your-secret-token"
  },
  "allowedPaths": ["~/", "~/projects", "~/code"],
  "maxSessions": 100,
  "idleTimeout": 255
}
```

Keep `host` on `127.0.0.1`. Any other value is a non-loopback bind and the
gateway will refuse to start without `--allow-non-loopback`, whether the value
came from this file or from the `--host` flag.

## Related Documentation

- [Gateway README](README.md) - API documentation
- [Gateway SPEC](SPEC.md) - Architecture details
- [Adler README](../../adler/README.md) - Client setup

---

**Need help?** Open an issue: https://github.com/draht-dev/draht/issues
