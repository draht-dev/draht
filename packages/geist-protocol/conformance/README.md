# geist wire conformance corpus

Recorded, not written. Every file under `geist-<version>/` came out of a real
daemon over a real transport: `scripts/geist-conformance/reference-daemon.mjs`
bound to a loopback port, relaying a real draht `SocketServer` over a real Unix
socket, driven by real WebSocket clients
(`scripts/geist-conformance/record.mjs`).

Regenerate with:

```
bun scripts/generate-geist-conformance.mjs
```

Verify with (also runs inside `npm run check`):

```
npm run check:geist-protocol
```

## What is in a version directory

| File | What it is |
|---|---|
| `schema-fingerprint.json` | structural descriptor of every exported wire schema at recording time — the thing that makes "no wire change without a 0.x bump" mechanical |
| `transcript.json` | the whole ordered session, both directions, as it crossed the wire |
| `rejected-frames.json` | bytes the daemon refused, with the typed `protocol_error` code it answered — the executable half of "the daemon accepts no frame an exported schema does not validate" |
| `client-to-server/<type>.json` | one golden per declared client message type |
| `server-to-client/<type>.json` | one golden per declared server message type |

## The two normalized fields

A recording has exactly two values it cannot hold fixed: the draht session's
real pid, and the real creation timestamps. Those are substituted from the
declared table in `scripts/geist-conformance/record.mjs` (`pid` → `1`,
`createdAt`/`startedAt` → `1970-01-01T00:00:00.000Z`) and every golden that
carries one lists it in its own `normalizedFields`, so a substituted field is
never mistaken for a recorded one. Everything else — session id, client ids,
the session's reported cwd, byte counts inside refusal messages — is fixed by
the recording script, so byte-equality is a meaningful gate rather than a
formatting check.
