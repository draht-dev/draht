# Attachable Sessions - tmux-style Multi-Client Attachment

**Status**: Experimental, opt-in (`--attachable`)

This document describes the design and wire protocol. For user-facing documentation see
[docs/attachable-sessions.md](docs/attachable-sessions.md).

## Overview

Attachable sessions enable tmux-style attachment to a running draht session: several terminals
*of the same user, on the same machine* can attach to one session at the same time, see the same
output, and send input.

The socket and its lock file are owner-only (0600), so this is not a way to share a session with
other people - it is a way to reach your own session from another terminal, an editor, or a local
proxy.

## Quick Start

Attachable mode is off unless `--attachable` is passed; a normal `draht` run binds no socket.

```bash
# Terminal 1: Start an attachable session
draht --attachable "Help me build a feature"

# Terminal 2: List running sessions
draht --list-sessions

# Terminal 3: Attach to the session
draht --attach <session-id>

# All terminals see the same output in real-time!
```

## Features

- **Multi-client attachment**: several terminals of the same user can attach to one session
- **Input broadcasting**: input from any client is echoed to all others (tmux-style)
- **Real-time streaming**: all clients see assistant text, thinking deltas, and tool activity
- **Session discovery**: `--list-sessions` finds running attachable sessions
- **Automatic cleanup**: the socket and lock are removed on normal exit and on
  SIGINT/SIGTERM/SIGHUP; files left by a `SIGKILL` are reaped by the next discovery run
- **Single owner per session id**: a second process refuses to take over a live session's socket
- **Permission control**: socket and lock are 0600 inside a 0700 directory, and the socket is
  bound under a restrictive umask so it is never briefly world-accessible

Not implemented (see [Future Enhancements](#future-enhancements)): gateway/WebSocket bridging,
read-only enforcement, history replay, named sessions, and settings-file configuration.

## Architecture

```
┌──────────────────────────────────────────────┐
│  draht --attachable "Build feature"          │
│  ┌────────────────────────────────────────┐  │
│  │  Agent Session                         │  │
│  │  - LLM interaction                     │  │
│  │  - Tool execution                      │  │
│  │  - Session file persistence            │  │
│  └─────────────┬──────────────────────────┘  │
│                │                              │
│  ┌─────────────▼──────────────────────────┐  │
│  │  Socket Server                         │  │
│  │  Unix Domain Socket:                   │  │
│  │  ~/.draht/agent/sockets/<id>.sock     │  │
│  └─────────────┬──────────────────────────┘  │
└────────────────┼──────────────────────────────┘
                 │
        ┌────────┼────────┬────────┐
        │        │        │        │
   ┌────▼───┐ ┌─▼────┐ ┌─▼────┐ ┌─▼──────┐
   │Terminal│ │Adler │ │Term 3│ │Gateway │
   │   1    │ │(phone│ │      │ │ Proxy  │
   └────────┘ └──────┘ └──────┘ └────────┘
   
   All clients see:
   - Same output (real-time)
   - Each other's input (echoed)
   - Join/leave notifications
```

## Protocol

Communication uses JSON-over-Unix-socket with newline framing.

### Client → Server Messages

```typescript
// Attach to session
{
  "type": "attach",
  "clientId": "terminal-abc123",
  "mode": "read-write" | "read-only"
}

// Send input
{
  "type": "input",
  "data": "What files are in src/?",
  "clientId": "terminal-abc123"
}

// Detach gracefully
{
  "type": "detach",
  "clientId": "terminal-abc123"
}
```

### Server → Client Messages

```typescript
// Session metadata (on attach)
{
  "type": "session_metadata",
  "sessionId": "abc-123",
  "cwd": "/path/to/project",
  "createdAt": "2026-03-09T21:00:00.000Z"
}

// Output from agent
{
  "type": "output",
  "data": "Reading directory...",
  "stream": "stdout" | "stderr"
}

// Input from another client (tmux-style echo)
{
  "type": "input_echo",
  "data": "read src/",
  "clientId": "terminal-xyz"
}

// Client joined
{
  "type": "client_joined",
  "clientId": "adler-phone",
  "mode": "read-write"
}

// Client left
{
  "type": "client_left",
  "clientId": "terminal-xyz"
}

// Error
{
  "type": "error",
  "message": "Session not running",
  "code": "NOT_RUNNING"
}
```

## CLI Commands

### Start Attachable Session

```bash
draht --attachable "Your prompt here"
draht --attachable @prompt.md "Additional context"
```

**Output**:
```
🔗 Attachable session started: 2026-03-09T21-00-00-123Z_abc-123-def
   Socket: ~/.draht/agent/sockets/2026-03-09T21-00-00-123Z_abc-123-def.sock
   Attach: draht --attach 2026-03-09T21-00-00-123Z_abc-123-def
```

### List Attachable Sessions

```bash
draht --list-sessions
```

**Output**:
```
📡 Attachable Sessions

Found 2 running sessions:

  2026-03-09T21-00-00-123Z_abc-123-def
    CWD:     /Users/exe/project
    PID:     12345
    Uptime:  15m 23s
    Socket:  ~/.draht/agent/sockets/2026-03-09T21-00-00-123Z_abc-123-def.sock

  2026-03-09T20-30-00-456Z_xyz-789-ghi
    CWD:     /Users/exe/other-project
    PID:     12346
    Uptime:  45m 12s
    Socket:  ~/.draht/agent/sockets/2026-03-09T20-30-00-456Z_xyz-789-ghi.sock

Attach to a session: draht --attach <session-id>
```

### Attach to Session

The session id must be given in full, exactly as `--list-sessions` printed it. Partial ids are
not supported, and the value is validated (same rule as session ids elsewhere: alphanumerics,
`-`, `_`, `.`, starting and ending alphanumeric) before it is turned into a socket path.

```bash
draht --attach 2026-03-09T21-00-00-123Z_abc-123-def
```

**Output**:
```
Attaching to session 2026-03-09T21-00-00-123Z_abc-123-def...
Connected to session 2026-03-09T21-00-00-123Z_abc-123-def
CWD: /Users/exe/project
Created: 3/9/2026, 9:00:00 PM

Type messages to send input, Ctrl+D to detach

> _
```

## File Locations

```
~/.draht/agent/
├── sessions/              # Session JSONL files (existing)
│   └── --path--/
│       └── 2026-03-09T21-00-00-123Z_abc-123.jsonl
│
└── sockets/              # Socket files (NEW)
    ├── 2026-03-09T21-00-00-123Z_abc-123.sock   # Unix socket
    └── 2026-03-09T21-00-00-123Z_abc-123.lock   # PID lock file
```

### Lock File Format

```
12345
/Users/exe/project
2026-03-09T21:00:00.123Z
```

Line 1: PID (owner of the socket; used for takeover checks and stale cleanup)  
Line 2: CWD (the *session's* resolved working directory, not `process.cwd()`)  
Line 3: Created timestamp (ISO 8601)

The lock is created with `O_EXCL` and mode 0600. If it already exists, the recorded PID decides
what happens:

- PID alive and not ours: startup fails with a `SocketSessionBusyError` and the running owner is
  left untouched.
- PID dead (or our own leftover): the stale `.sock`/`.lock` pair is reaped and the socket is
  rebound.

## Gateway Integration (planned, not shipped here)

The socket server is designed so it *can* be discovered and proxied by `@draht/gateway`. Nothing
in this package implements that bridge:

```typescript
// Gateway discovers socket sessions
GET /sessions?discover=true
// Returns: gateway-spawned + socket-based sessions

// Gateway creates a WebSocket proxy to the socket
ws://gateway:7878/sessions/<socket-session-id>/ws
// Bridges to Unix socket transparently
```

Once such a bridge exists, a remote client could discover terminal-started sessions, attach over
WebSocket, and participate like any other client. Note that the Unix socket carries no
authentication of its own: any bridge that exposes it beyond the local user has to add one.

## Implementation Details

### Core Classes

- **`SocketServer`** (`src/core/socket-server/socket-server.ts`)
  - Manages Unix domain socket
  - Handles client connections
  - Broadcasts output, forwards input
  - Client join/leave notifications

- **`SocketClient`** (`src/core/socket-server/socket-client.ts`)
  - Connects to socket server
  - Implements client-side protocol
  - Used by `--attach` mode

- **`discoverSocketSessions()`** (`src/core/socket-server/discovery.ts`)
  - Scans socket directory
  - Reads lock files
  - Filters stale sessions (dead PIDs)

- **`makeSessionAttachable()`** (`src/core/socket-server/session-integration.ts`)
  - Wraps AgentSession with SocketServer
  - Subscribes to session events
  - Broadcasts output to clients
  - Forwards input to session

### Event Integration

```typescript
// Subscribe to session events
session.subscribe((event) => {
  if (event.type === "message_update") {
    // Streaming text/thinking deltas
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === "text_delta") {
      socketServer.broadcastOutput(assistantEvent.delta, "stdout");
    }
  } else if (event.type === "tool_execution_end") {
    // Tool results
    socketServer.broadcastOutput(event.result, "stdout");
  }
});

// Forward input from clients. prompt() rejects for ordinary reasons (for example a prompt sent
// while the agent is already streaming); an unhandled rejection would kill the whole agent, so
// the failure is reported to the client that sent the input instead.
socketServer.onInput((data, clientId) => {
  void Promise.resolve()
    .then(() => session.prompt(data))
    .catch((error) => socketServer.sendErrorToClient(clientId, `Prompt failed: ${error.message}`, "PROMPT_FAILED"));
});
```

### Lifecycle

`makeSessionAttachable()` returns a handle rather than a bare cleanup function:

- `stop()` - async teardown (close server, remove `.sock`/`.lock`), used by `main.ts`'s `finally`
- `stopSync()` - the same teardown without awaiting, for `process.on("exit")` and signal handlers
- `rebind(session, cwd)` - follow a session replacement

`registerAttachableSessionCleanup(handle)` installs the exit and signal hooks. Interactive, print,
and rpc mode all end in `process.exit()` and never return to `main()`, so cleanup cannot rely on a
`finally` alone. The signal handlers defer to any other listener for that signal (the modes'
graceful shutdown, or the Ctrl+Z SIGINT guard) and otherwise clean up and re-raise the signal with
the default disposition.

`AgentSessionRuntime.addSessionReplacedListener()` drives `rebind()`: `/new`, `/resume`, `/fork`,
and `/import` dispose the current `AgentSession` and install a new one with a new id. The socket
closes (attached clients get a `SESSION_REPLACED` error frame first) and a new socket is bound for
the replacement session, so `--list-sessions` never advertises a disposed session.

## Configuration

There is no settings-file configuration. The only switch is the `--attachable` flag; the
remaining values are hardcoded:

| Value | Setting |
|-------|---------|
| Socket directory | `<agent dir>/sockets` (`~/.draht/agent/sockets` by default) |
| Max clients | 10 per session |
| Input echo | on (tmux-style) |

## Security

- **Unix socket permissions**: 0600 (owner-only), applied by binding under a `0o177` umask so the
  socket never exists in a permissive mode, plus a `chmod` afterwards for platforms that ignore
  the umask on bind
- **Lock file permissions**: 0600, created with `O_EXCL`
- **Socket directory**: 0700 (owner-only), re-asserted on every start
- **Session id validation**: `--attach` values are validated before being turned into a path, so
  they cannot traverse out of the socket directory
- **No authentication**: trust is based on file system permissions only. Owner-only permissions
  are the entire security boundary; anything that proxies this socket must add its own auth
- **Local-only**: Unix sockets don't support remote connections

Future: optional per-session tokens for an additional security layer.

## Limitations

1. **Opt-in**: nothing is exposed unless `--attachable` is passed
2. **Single user**: 0600 permissions mean only the owning user can attach; this is not multi-user
   session sharing
3. **Local-only**: Unix domain sockets (no remote attachment)
4. **POSIX-only**: the socket path is a filesystem path, so Windows is not supported
5. **One live owner per session id**: a second `--attachable` process for the same id refuses to
   start instead of stealing the socket
6. **No session takeover**: can't kill other clients (by design)
7. **No read-only enforcement**: clients can claim read-only, and the server rejects their input,
   but the CLI always attaches read-write
8. **No replay**: attaching clients only see new output (not history)
9. **No input while streaming**: input that arrives mid-turn is rejected and the sender receives
   an error frame; it is not queued as a follow-up
10. **Session replacement disconnects clients**: `/new`, `/resume`, `/fork`, and `/import` move
    the socket to the new session id; attached clients must re-attach
11. **`SIGKILL` leaves files behind**: they are reaped the next time discovery runs

## Future Enhancements

### Phase 2: Gateway Socket Discovery
- [ ] Gateway scans socket directory
- [ ] Exposes socket sessions via REST API
- [ ] WebSocket bridge to Unix sockets

### Phase 3: Adler Integration
- [ ] Adler discovers socket sessions
- [ ] Attach UI for terminal sessions
- [ ] Multi-client indicators in UI

### Phase 4: Advanced Features
- [ ] Named sessions (`--attachable --name "my-feature"`)
- [ ] Session transfer (hand off to another user)
- [ ] Read-only mode enforcement
- [ ] History replay for late joiners
- [ ] TCP sockets (remote attachment with encryption)

## Troubleshooting

### "Failed to connect" when attaching

Check if session is still running:
```bash
draht --list-sessions
```

If socket exists but session isn't listed, the process may have crashed.  
Clean up manually:
```bash
rm ~/.draht/agent/sockets/<session-id>.sock
rm ~/.draht/agent/sockets/<session-id>.lock
```

### Socket permission denied

Ensure socket directory has correct permissions:
```bash
chmod 700 ~/.draht/agent/sockets
```

### Stale sockets

Socket files are cleaned up on process exit and on SIGINT/SIGTERM/SIGHUP, and `--list-sessions`
reaps any pair whose recorded PID is gone. If a socket keeps reappearing, check for a live process
still holding it:
```bash
ps aux | grep draht
```

Kill zombie sessions:
```bash
kill <pid>
```

## Testing

Automated coverage lives in `test/socket-server.test.ts`,
`test/socket-attachable-lifecycle.test.ts`, and `test/socket-server-permissions.test.ts`
(`bun run test`).

Manual check:

```bash
# Terminal 1
cd draht-mono/packages/coding-agent
bun run build
./dist/cli.js --attachable "List TypeScript files"

# Terminal 2
./dist/cli.js --list-sessions
./dist/cli.js --attach <session-id>

# Both terminals should see same output
# Input from Terminal 2 should echo in Terminal 1
```

## Related Files

- `src/core/socket-server/` - Socket server implementation
- `src/core/agent-session-runtime.ts` - `addSessionReplacedListener()` seam used for rebinding
- `src/cli/list-sessions.ts` - List command
- `src/cli/attach-mode.ts` - Attach command and `--attach` validation
- `src/cli/args.ts` - CLI flags
- `src/main.ts` - Integration point
- `.planning/attachable-sessions-prd.md` - Original PRD

## Documentation

- User guide: [docs/attachable-sessions.md](docs/attachable-sessions.md)
- Package README: [README.md](README.md)
- Gateway README: [../gateway/README.md](../gateway/README.md)
- PRD: [.planning/attachable-sessions-prd.md](.planning/attachable-sessions-prd.md)

---

**Status**: Experimental - API may change  
**Feedback**: https://github.com/draht-dev/draht/issues
