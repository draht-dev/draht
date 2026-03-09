# PRD: Attachable Sessions (tmux-style multi-attach)

## Vision

Enable draht sessions to be attached/detached from multiple clients simultaneously, just like `tmux attach`. Any session (gateway-spawned or terminal-started) can be discovered and attached by Adler, other terminals, or the gateway itself.

## User Stories

### US-1: Start Attachable Session from Terminal
**As a** developer  
**I want** to start a draht session with `--attachable`  
**So that** I can later attach to it from Adler or another terminal

```bash
# Start an attachable session
draht --attachable "Help me build a feature"

# Session creates socket: ~/.draht/agent/sockets/<session-id>.sock
# Other clients can now attach to this session
```

### US-2: Discover Running Sessions
**As a** user  
**I want** the gateway to discover all running attachable sessions  
**So that** Adler can list and attach to terminal-started sessions

```bash
# Terminal 1: Start session
draht --attachable "Refactor code"

# Gateway API:
GET /sessions?discover=true
# Returns: all gateway sessions + all socket-based sessions
```

### US-3: Multi-Client Attach (Surveillance Mode)
**As a** user  
**I want** to attach multiple clients to the same session  
**So that** I can monitor from Adler while working in terminal, or share sessions with others

```bash
# Terminal 1: Primary session
draht --attachable "Debug issue"

# Terminal 2: Attach read-only
draht --attach <session-id>

# Adler: Attach via gateway WebSocket
# All clients see same output + each other's input
```

### US-4: Resume via Socket vs Session File
**As a** user  
**I want** to attach to a running session OR resume a stopped one  
**So that** I can continue work seamlessly

```bash
# Running session: attach via socket
draht --attach <session-id>  # Connects to socket

# Stopped session: resume via file
draht --continue  # Loads JSONL file
```

### US-5: Input Echo/Broadcast
**As a** user watching a session  
**I want** to see input from all attached clients  
**So that** I can see what commands others are typing (tmux behavior)

```
Terminal 1: types "read package.json"
Terminal 2: sees "read package.json" echoed
Adler: sees "read package.json" in output
```

## Architecture

### Socket Location
```
~/.draht/agent/sockets/
  <session-id>.sock      # Unix domain socket per session
  <session-id>.lock      # Lock file with PID for cleanup
```

### Session Process Structure
```
draht --attachable
  │
  ├─ Agent Core (existing)
  │   ├─ Tool execution
  │   ├─ LLM interaction
  │   └─ Session file writing
  │
  └─ Socket Server (NEW)
      ├─ Unix domain socket listener
      ├─ Client connection manager
      ├─ Output broadcaster (fan-out)
      └─ Input aggregator (fan-in)
```

### Protocol (JSON-over-socket)

```typescript
// Client → Server
{
  "type": "attach",
  "clientId": "adler-abc123",
  "mode": "read-write" | "read-only"
}

{
  "type": "input",
  "data": "What files are in src/?",
  "clientId": "terminal-xyz"
}

{
  "type": "detach",
  "clientId": "adler-abc123"
}

// Server → Client
{
  "type": "output",
  "data": "Reading directory...",
  "stream": "stdout" | "stderr"
}

{
  "type": "input_echo",
  "data": "read src/",
  "clientId": "terminal-xyz"  // Who typed it
}

{
  "type": "client_joined",
  "clientId": "adler-abc123",
  "mode": "read-write"
}

{
  "type": "client_left",
  "clientId": "terminal-xyz"
}

{
  "type": "session_metadata",
  "id": "abc-123",
  "cwd": "/path",
  "createdAt": "..."
}
```

### Gateway Integration

```typescript
// Gateway SessionManager enhancement
class SessionManager {
  // Existing: in-memory sessions it spawned
  #sessions = new Map<string, Session>();
  
  // NEW: Discover socket-based sessions
  discoverSocketSessions(): SocketSession[] {
    // Scan ~/.draht/agent/sockets/
    // Return metadata for each .sock file
  }
  
  // NEW: Attach to existing socket session
  attachToSocket(sessionId: string): SocketSessionProxy {
    // Connect to socket
    // Return proxy that implements Session interface
  }
}
```

### CLI Flags

```bash
# New flags
--attachable              # Start session with socket server
--attach <session-id>     # Attach to running session
--list-sessions           # List all attachable sessions
--detach                  # Detach from session (Ctrl+D)
```

## Implementation Phases

### Phase 1: Socket Server Core
- [ ] Create `SocketServer` class in `@draht/coding-agent`
- [ ] Add socket lifecycle management (create, bind, listen, cleanup)
- [ ] Implement client connection handling
- [ ] Add basic broadcast mechanism

### Phase 2: Protocol Implementation
- [ ] Define TypeScript protocol types
- [ ] Implement JSON message framing over sockets
- [ ] Add input/output multiplexing
- [ ] Handle client join/leave events

### Phase 3: CLI Integration
- [ ] Add `--attachable` flag to spawn socket server
- [ ] Add `--attach <session-id>` for client mode
- [ ] Add `--list-sessions` to discover sockets
- [ ] Implement socket-based I/O mode

### Phase 4: Gateway Discovery
- [ ] Add socket discovery to gateway SessionManager
- [ ] Create `SocketSessionProxy` class
- [ ] Expose socket sessions via REST API
- [ ] Add WebSocket bridge for socket sessions

### Phase 5: Adler Integration
- [ ] Update Adler to request discovery
- [ ] Show terminal-started sessions in UI
- [ ] Support attaching to socket sessions
- [ ] Display multi-client indicators

### Phase 6: Polish
- [ ] Add read-only mode
- [ ] Socket cleanup on crash (PID lock files)
- [ ] Reconnection handling
- [ ] Performance testing with many clients

## Configuration

```jsonc
// ~/.draht/agent/settings.json
{
  "experimental": {
    "attachableSessions": {
      "enabled": true,
      "socketDir": "~/.draht/agent/sockets",
      "defaultMode": "attachable",  // or "isolated"
      "maxClients": 10,
      "broadcastInputEcho": true
    }
  }
}
```

## Security Considerations

- **Socket permissions**: 0600 (owner-only)
- **PID lock files**: Prevent orphaned sockets
- **Client authentication**: Optional token per session
- **Read-only mode**: Prevent accidental input from observers

## Success Criteria

1. ✅ Can start `draht --attachable` from terminal
2. ✅ Gateway discovers and lists socket sessions
3. ✅ Adler can attach to terminal-started sessions
4. ✅ Multiple clients see same output in real-time
5. ✅ Input from any client is echoed to all others
6. ✅ Sessions survive client detach/reattach
7. ✅ Clean socket cleanup on session exit

## Non-Goals

- Sharing sessions across machines (local-only via Unix sockets)
- Recording/playback (use session files for that)
- Session branching/forking
- Peer-to-peer client communication (server mediates all)

## Future Enhancements

- **Named sessions**: `draht --attachable --name "my-feature"`
- **Session groups**: Group related sessions
- **Broadcast mode**: One writer, many read-only observers
- **Session transfer**: Hand off session to another user
- **TCP sockets**: Remote attachment over network (with encryption)

---

**Status**: Designed, ready for implementation  
**Experimental flag**: `experimental.attachableSessions.enabled`  
**Target packages**: `@draht/coding-agent`, `@draht/gateway`, `adler`
