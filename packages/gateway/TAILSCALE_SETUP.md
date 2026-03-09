# Tailscale Setup for draht-gateway

## Overview

The draht gateway binds to `0.0.0.0` by default, making it accessible over your Tailscale network. This allows you to access it from Adler on your phone or Quest 3.

## Quick Start

### 1. Find Your Tailscale IP

```bash
tailscale status
```

Look for your machine's IP (starts with `100.`):
```
100.72.9.11    omf            execute008@  macOS  -
```

Your Tailscale IP is: `100.72.9.11`

### 2. Start the Gateway

```bash
cd draht-mono/packages/gateway
bun start --auth YOUR_SECRET_TOKEN
```

You should see:
```json
{"level":"info","timestamp":"2026-03-09T21:37:40.361Z","message":"draht-gateway listening","host":"0.0.0.0","port":7878}
```

Note: `"host":"0.0.0.0"` means it's listening on all interfaces (including Tailscale).

### 3. Test from Another Device

From your phone, Quest 3, or another computer on your Tailnet:

```bash
# Test health endpoint (no auth required)
curl http://100.72.9.11:7878/health

# Expected response:
{"status":"ok","sessions":0,"uptime":0.123,"version":"0.1.0"}

# Test authenticated endpoint
curl -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
     http://100.72.9.11:7878/sessions

# Expected response:
{"sessions":[]}
```

If you get a response, it's working! 🎉

## Common Issues

### ❌ Connection Refused / Timeout

**Problem**: Gateway is not accessible over Tailscale.

**Solution**:

1. **Check gateway is running**:
   ```bash
   curl http://localhost:7878/health
   ```
   If this fails, the gateway isn't running.

2. **Check Tailscale is active**:
   ```bash
   tailscale status
   ```
   Should show connected devices.

3. **Check firewall** (macOS):
   ```bash
   # Allow incoming connections on port 7878
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which bun)
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which bun)
   ```

4. **Verify binding**:
   ```bash
   lsof -i :7878
   ```
   Should show process listening on `*:7878` (not `127.0.0.1:7878`).

### ❌ Gateway Binds to Localhost Only

**Problem**: Gateway shows `"host":"127.0.0.1"` in logs.

**Solution**: Don't use `--host 127.0.0.1`. Either:
- Omit `--host` (defaults to `0.0.0.0`)
- Or explicitly use `--host 0.0.0.0`

```bash
# ✅ Good (binds to all interfaces)
bun start --auth mytoken

# ✅ Good (explicit)
bun start --host 0.0.0.0 --auth mytoken

# ❌ Bad (localhost only, no Tailscale)
bun start --host 127.0.0.1 --auth mytoken
```

### ❌ Tailscale IP Changed

**Problem**: Your Tailscale IP changed and clients can't connect.

**Solution**: Tailscale IPs are usually stable, but if it changes:

1. Find new IP:
   ```bash
   tailscale status | grep "$(hostname)"
   ```

2. Update clients (Adler settings) with new IP.

**Better**: Use MagicDNS (Tailscale's DNS):
```bash
# Instead of: http://100.72.9.11:7878
# Use:        http://omf.tail-scale.ts.net:7878
```

Find your hostname in `tailscale status` (second column).

## Security Considerations

### ✅ Tailscale Security Model

- **Encrypted**: All Tailscale traffic is encrypted (WireGuard)
- **Authenticated**: Only your Tailnet devices can connect
- **Private**: Not exposed to the public internet

### ✅ Gateway Security Model

- **Bearer token**: All API endpoints (except `/health`) require auth
- **CORS enabled**: Allows browser-based clients (Quest browser)
- **No credentials**: Token is passed in `Authorization` header

### 🔒 Best Practices

1. **Use a strong token**:
   ```bash
   # Generate a secure token
   openssl rand -base64 32
   ```

2. **Store token securely**:
   ```bash
   # In Adler: Settings > Gateways > Bearer Token
   # Don't commit tokens to git
   # Don't share tokens publicly
   ```

3. **Monitor access**:
   ```bash
   # Gateway logs all requests
   {"level":"info","timestamp":"...","message":"..."}
   ```

4. **Rotate tokens**:
   - Change token periodically
   - Update Adler settings with new token

## Advanced Configuration

### Bind to Specific Interface

If you have multiple network interfaces and want to bind to a specific one:

```bash
# Bind to Tailscale IP only
bun start --host 100.72.9.11 --auth mytoken

# Bind to localhost only (for testing)
bun start --host 127.0.0.1 --auth mytoken

# Bind to all interfaces (default)
bun start --host 0.0.0.0 --auth mytoken
```

### Use MagicDNS

Enable MagicDNS in your Tailscale admin console, then:

```bash
# Find your hostname
tailscale status

# Use hostname instead of IP
curl http://omf.tail-scale.ts.net:7878/health
```

Benefits:
- Survives IP changes
- Easier to remember
- Works across all Tailnet devices

### Custom Port

```bash
# Use a different port
bun start --port 8080 --auth mytoken

# Access from clients
curl http://100.72.9.11:8080/health
```

## Testing from Adler

### Configure Gateway in Adler

1. Open Adler app
2. Tap **Add Gateway**
3. Enter:
   - **Name**: "My Mac" (or any friendly name)
   - **Gateway URL**: `http://100.72.9.11:7878`
   - **Bearer Token**: `YOUR_SECRET_TOKEN`
4. Toggle **Connect automatically** on

### Verify Connection

You should see:
- Green dot next to gateway name (connected)
- Session count (e.g., "0 sessions")
- Uptime (e.g., "5m 23s")

### Troubleshooting Adler Connection

If Adler can't connect:

1. **Test from same device** (phone/Quest):
   - Open browser on device
   - Visit: `http://100.72.9.11:7878/health`
   - Should see JSON response

2. **Check Tailscale on device**:
   - Install Tailscale app on phone/Quest
   - Login with same account
   - Verify device appears in `tailscale status`

3. **Check token**:
   - Copy-paste token exactly (no extra spaces)
   - Tokens are case-sensitive

## Network Architecture

```
┌─────────────────────────────────────┐
│  Your Mac (100.72.9.11)             │
│  ┌───────────────────────────────┐  │
│  │  draht-gateway                │  │
│  │  Listening on: 0.0.0.0:7878   │  │
│  │  (all interfaces)             │  │
│  └───────────┬───────────────────┘  │
└──────────────┼──────────────────────┘
               │
        ┌──────┴──────┐
        │  Tailscale  │
        │  (encrypted)│
        └──────┬──────┘
               │
    ┌──────────┼──────────┬───────────┐
    │          │          │           │
┌───▼──┐   ┌──▼───┐   ┌──▼───┐   ┌──▼────┐
│Phone │   │Quest3│   │Laptop│   │Server │
│Adler │   │Adler │   │ curl │   │  API  │
└──────┘   └──────┘   └──────┘   └───────┘

All devices must:
✓ Be on same Tailnet
✓ Have Tailscale running
✓ Know your Mac's Tailscale IP
```

## Monitoring

### View Gateway Logs

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
  "host": "0.0.0.0",
  "port": 7878
}
```

### Check Active Sessions

```bash
curl -H "Authorization: Bearer mytoken" \
     http://100.72.9.11:7878/sessions | jq
```

### Monitor Events (SSE)

```bash
curl -H "Authorization: Bearer mytoken" \
     -N http://100.72.9.11:7878/events
```

## Performance

### Latency

Typical round-trip times over Tailscale:
- Same network: 1-5ms
- Different networks: 20-100ms
- Cross-continent: 100-300ms

### Bandwidth

Gateway bandwidth usage:
- Health checks: < 1 KB/request
- Session list: ~1 KB/session
- Streaming output: ~10-50 KB/s per session
- WebSocket: minimal overhead

### Concurrent Connections

Default limits:
- Max sessions: No hard limit (memory-bound)
- Max WebSocket connections: No hard limit
- Max SSE connections: No hard limit

## Production Deployment

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

## Related Documentation

- [Gateway README](README.md) - API documentation
- [Gateway SPEC](SPEC.md) - Architecture details
- [Adler README](../../adler/README.md) - Client setup

---

**Need help?** Open an issue: https://github.com/draht-dev/draht/issues
