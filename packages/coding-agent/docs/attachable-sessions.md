# Attachable sessions

Attachable sessions expose a running draht session on a Unix domain socket so you can watch it
and type into it from another terminal on the same machine — tmux-style, but for one agent
session instead of a shell.

The feature is **experimental** and **opt-in**: nothing binds a socket unless you pass
`--attachable`.

## Flags

| Flag | Description |
|------|-------------|
| `--attachable` | Expose this session on an owner-only Unix socket |
| `--attach <session-id>` | Attach to a running attachable session |
| `--list-sessions` | List running attachable sessions and exit |

## Workflow

```bash
# Terminal 1 — start a session that can be attached to
draht --attachable "Refactor the auth module"

# Terminal 2 — find it
draht --list-sessions

# Terminal 2 — attach (Ctrl+D detaches, the session keeps running)
draht --attach 01a01648-3e02-757f-b63d-fa987c4245a6
```

Attached clients receive streamed assistant text, thinking deltas, tool starts, and tool
results. Anything an attached client types is sent to the agent as a prompt and echoed to the
other attached clients.

Session ids must be given in full — `--attach` takes the exact id shown by `--list-sessions`,
not a prefix.

## Files

```text
~/.draht/agent/sockets/
├── <session-id>.sock   # Unix domain socket, mode 0600
└── <session-id>.lock   # PID, cwd, and creation time of the owning process, mode 0600
```

The directory is created with mode 0700.

## Security model

- The socket and its lock file are owner-only (0600) in an owner-only directory (0700), and the
  socket is bound under a restrictive umask so it is never briefly world-accessible.
- There is no authentication beyond those file permissions: anyone who can open the socket can
  drive your agent, so this is a *single-user, single-machine* feature, not a way to share a
  session with other people.
- Unix domain sockets are local only; nothing is exposed on the network.

## Lifecycle

- The socket is removed when the session exits normally, on Ctrl+C/Ctrl+D quit, and on
  SIGINT/SIGTERM/SIGHUP.
- `SIGKILL` (or a power loss) leaves the `.sock` and `.lock` behind. The next `--list-sessions`
  notices that the recorded PID is gone and deletes both files.
- Only one live process can own a session id at a time. A second `--attachable` run for the
  same session id refuses to start rather than stealing the socket from the running one.
- `/new`, `/resume`, `/fork`, and `/import` replace the session. The old socket is closed —
  attached clients receive a `Session replaced` error and are disconnected — and a new socket is
  bound for the new session id. Run `--list-sessions` again and re-attach.

## Limitations

- Attaching shows output from that moment on; there is no replay of earlier conversation.
- Input sent while the agent is already streaming is rejected, and the sending client receives
  an error frame (`Prompt failed: Agent is already processing…`). Wait for the turn to finish.
- Read-only mode exists in the protocol, but the CLI always attaches read-write.
- Windows is not supported for `--attachable` (Unix domain sockets and the signal handling this
  relies on are POSIX-only).

For the wire protocol and internals, see
[ATTACHABLE_SESSIONS.md](https://github.com/draht-dev/draht/blob/main/packages/coding-agent/ATTACHABLE_SESSIONS.md).
