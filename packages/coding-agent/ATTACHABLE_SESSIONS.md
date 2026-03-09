# Attachable Sessions - tmux-style Multi-Client Attachment

**Status**: ✅ Implemented (Experimental)  
**Version**: 1.0.0  
**Date**: March 9, 2026

## Overview

Attachable sessions enable tmux-style multi-client attachment to draht sessions. Multiple users or terminals can attach to the same running session simultaneously, seeing the same output and being able to send input.

## Quick Start

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

✅ **Multi-client attachment**: Multiple terminals/users can attach to the same session  
✅ **Input broadcasting**: Input from any client is echoed to all others (tmux-style)  
✅ **Real-time streaming**: All clients see output as it happens  
✅ **Session discovery**: Find all running attachable sessions  
✅ **Gateway integration**: Ready for Adler (Flutter) client integration  
✅ **Automatic cleanup**: Socket files are cleaned up on exit  
✅ **Permission control**: Socket files are owner-only (0600)  

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

```bash
draht --attach 2026-03-09T21-00-00-123Z_abc-123-def
# Or use partial ID (unique prefix)
draht --attach 2026-03-09T21-00
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

Line 1: PID (for stale socket cleanup)  
Line 2: CWD (working directory)  
Line 3: Created timestamp (ISO 8601)

## Gateway Integration

The socket server is designed to be discovered and proxied by `@draht/gateway`:

```typescript
// Gateway discovers socket sessions
GET /sessions?discover=true
// Returns: gateway-spawned + socket-based sessions

// Gateway creates a WebSocket proxy to the socket
ws://gateway:7878/sessions/<socket-session-id>/ws
// Bridges to Unix socket transparently
```

This enables Adler (Flutter client) to:
1. Discover terminal-started sessions
2. Attach to them over WebSocket
3. See output and send input
4. Participate in multi-client sessions

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

// Forward input from clients
socketServer.onInput((data, clientId) => {
  void session.prompt(data);
});
```

## Configuration

Currently hardcoded (future: settings.json):

```typescript
{
  experimental: {
    attachableSessions: {
      enabled: true,           // Global enable/disable
      socketDir: "~/.draht/agent/sockets",
      maxClients: 10,          // Per session
      broadcastInputEcho: true // tmux-style input echo
    }
  }
}
```

## Security

- **Unix socket permissions**: 0600 (owner-only)
- **Socket directory**: 0700 (owner-only)
- **No authentication**: Trust based on file system permissions
- **Local-only**: Unix sockets don't support remote connections

Future: Optional per-session tokens for additional security layer.

## Limitations

1. **Local-only**: Unix domain sockets (no remote attachment)
2. **No session takeover**: Can't kill other clients (by design)
3. **No read-only enforcement**: Clients can claim read-only but server doesn't enforce
4. **No replay**: Attaching clients only see new output (not history)

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

Socket files should auto-cleanup on process exit. If not, check for zombie processes:
```bash
ps aux | grep draht
```

Kill zombie sessions:
```bash
kill <pid>
```

## Testing

```bash
# Terminal 1
cd draht-mono/packages/coding-agent
npm run build
./dist/cli.js --attachable "List TypeScript files"

# Terminal 2  
./dist/cli.js --list-sessions
./dist/cli.js --attach <session-id>

# Both terminals should see same output
# Input from Terminal 2 should echo in Terminal 1
```

## Related Files

- `src/core/socket-server/` - Socket server implementation
- `src/cli/list-sessions.ts` - List command
- `src/cli/attach-mode.ts` - Attach command
- `src/cli/args.ts` - CLI flags
- `src/main.ts` - Integration point
- `.planning/attachable-sessions-prd.md` - Original PRD

## Documentation

- Main README: [README.md](../../README.md)
- Gateway README: [../gateway/README.md](../gateway/README.md)
- PRD: [.planning/attachable-sessions-prd.md](.planning/attachable-sessions-prd.md)

---

**Status**: Experimental - API may change  
**Feedback**: https://github.com/draht-dev/draht/issues
