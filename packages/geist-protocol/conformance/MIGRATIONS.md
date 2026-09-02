# geist wire — 0.x migration notes

Every member of the `geist/0.x` family gets a section here, and the gate
(`npm run check:geist-protocol`) fails until the section for the current
`GEIST_PROTOCOL_VERSION` exists. Pre-1.0 members are not compatible with one
another: a renderer speaking `0.1` is refused by a `0.2` daemon at the
handshake rather than at the first field it cannot find, which is why every
change has to be written down here.

Adding a member:

1. bump `GEIST_PROTOCOL_VERSION` in `packages/geist-protocol/src/wire.ts`
2. add a `## geist/<version>` section below saying what moved and what a
   renderer has to do about it
3. `bun scripts/generate-geist-conformance.mjs` — re-records the corpus from a
   running daemon into `conformance/geist-<version>/`

Older members' directories stay committed. They are the record of what the wire
actually was, not scaffolding.

## geist/0.5

Start work from the phone (R36-SPAWN.1, R36-SPAWN.3). Four added message types,
none changed, none removed:

- client → server: `session_spawn` (`harnessId`, `projectId`, and nothing else)
  and `registry_resync` (no fields)
- server → client: `session_spawned` (`sessionId?`, `ok`, `code`, `message`) and
  `registry` (`harnesses[]` of `{id, isDefault}`, `projects[]` of
  `{id, name, root}`)

`session_spawn` CARRIES TWO OPAQUE REGISTRY IDS AND NOTHING ELSE, for the same
reason `session_resume` carries one id: the daemon resolves both against its own
user-owned registry and constructs the argv itself, so the worst a caller can
name is an entry that exists or one that does not. There is no `path`, no `cwd`,
no `argv` and no `env` on this frame, and the decoder drops any that are sent —
recorded as `session-spawn-before-auth` in `rejected-frames.json`.

`session_spawned.sessionId` IS OPTIONAL, and it is the one shape difference from
`session_resumed`, whose id the client supplied. Here the daemon MINTS the id, so
a refusal has none to name: it crosses ONLY when a process was started. That
direction is a producer invariant no schema can state, so the bridge enforces it
— an id offered alongside a refusing code is dropped, and so is one too long for
the wire, because reporting a started process as `spawn_failed` is the worse lie.
`code` is a closed set: `spawned`, `unknown_harness`, `unknown_project`,
`refused`, `spawn_failed`, `timeout`, and `ok` is true for exactly one of them.

A REGISTRY ROW THE WIRE WOULD REFUSE IS DROPPED, NOT REPAIRED. `geist.yaml`
declares `projects` and `agents` as maps whose KEYS nothing constrains, while
`RegistryIdSchema` bounds an id at 64 characters of `[A-Za-z0-9._-]` after a
leading alphanumeric; the arrays are capped at 64 harnesses and 256 projects. A
key like `bin/draht` or `draht mono`, or a 257th project, is left out of the
`registry` frame rather than renamed into one the renderer could not spawn.

A HARNESS ROW CARRIES NO `cmd`. An executable path tells a client what to attack
and buys a picker nothing — the same reasoning that keeps the socket path off a
fleet row. A project `root` does cross, because the fleet row already carries
`cwd` and a picker showing two projects of the same name cannot otherwise tell
them apart.

None of the four new types is relayed — they are answered by the daemon and never
cross to a draht session's Unix socket — so none has a row in `MIRRORED_FRAMES`.

**THE CLIFF, STATED PLAINLY.** `ProtocolVersionSchema` is a `z.literal`, so a
daemon speaking `0.5` refuses a cached `0.4` renderer at `hello` with
`version_mismatch` and closes 1008. There is no negotiation and no fallback, and
the console's forget-credential path handles `not_authenticated` only: **the fix
is a page reload**, which fetches the new bundle. Anyone holding an old tab open
at the moment of deploy sees a connection that closes immediately until they
reload.

**What a renderer has to do.**

1. Reload, once. See the cliff above.
2. Read `server_hello.capabilities` before sending `session_spawn` or
   `registry_resync`. The strings are `session-spawn` and `registry`, each
   advertised only when the daemon has the port behind it. An undeclared type is
   refused `unknown_type` and the connection is CLOSED, so probing for a verb
   costs the connection.
3. Do not read `sessionId` off a `session_spawned` without checking it is there.
   A refusal has no id, and `ok` is what says which happened.
   An id missing from an `ok: true` answer means the process started and the
   fleet stream is the only place its id will appear.
4. Expect the session itself to arrive as a `fleet_delta appeared`, not on this
   frame: `session_spawned` says a process was started, and the fleet stream is
   what says it joined.

## geist/0.4

Default-on, history and honest liveness (R35-ALWAYS.7, R35-ALWAYS.8,
R35-ALWAYS.10, R35-ALWAYS.9), plus the neutral permission member Phase 34 shipped
without. Four added message types, four changed ones, none removed:

- server → client: `fleet_delta` (`epoch`, `seq`, `changes[]` of
  `appeared` / `changed` / `disappeared`) and `session_resumed` (`sessionId`,
  `ok`, `code`, `message`)
- client → server: `fleet_resync` (no fields) and `session_resume` (`sessionId`,
  and nothing else)
- changed: `server_hello` gains a REQUIRED `capabilities: string[]`; `fleet`
  gains `epoch` and `seq`; every fleet row gains `origin`, `attachable`,
  `resumable`, `status` and `statusAt` **and its `pid` becomes optional**;
  `permission_resolved.decision` gains `answered`

None of the four new types is relayed — they are answered by the daemon and never
cross to a draht session's Unix socket — so none has a row in `MIRRORED_FRAMES`.
`permission_resolved` does, and its socket-wire counterpart
(`packages/coding-agent/src/core/socket-server/types.ts`) moved with it.

**THE CLIFF, STATED PLAINLY.** `ProtocolVersionSchema` is a `z.literal`, so a
daemon speaking `0.4` refuses a cached `0.3` renderer at `hello` with
`version_mismatch` and closes 1008. There is no negotiation and no fallback. The
console's forget-credential path handles `not_authenticated` only, so it does not
recover from this: **the fix is a page reload**, which fetches the new bundle.
Anyone holding an old tab open at the moment of deploy sees a connection that
closes immediately until they reload.

`capabilities` on `server_hello` exists so this is the LAST such cliff for a
while. It is the daemon-side counterpart of the `attach.capabilities` `0.3`
introduced for renderers: from here a daemon that gains a verb advertises the
string, a renderer that does not know the string does not send it, and neither
side needs a version bump. It is required rather than optional on purpose —
"absent" would have to mean "pre-0.4", and there is no pre-0.4 daemon that speaks
0.4. A daemon with nothing extra to say sends `[]`. A capability is never a
permission: it says a frame will be understood, not that the connection sending
it has earned anything.

**What a renderer has to do.**

1. Reload, once. See the cliff above.
2. Read `server_hello.capabilities` before sending `fleet_resync` or
   `session_resume`. An undeclared type is refused `unknown_type` and the
   connection is CLOSED, so probing for a verb costs the connection.
3. Stop assuming a fleet row is live. `origin` is `"socket"` or `"history"` —
   never `"live"`, which was a drafting word and is not on this wire — and
   `attachable` / `resumable` say what may be done with the row. **`pid` is now
   optional**: a history row has no process, and code that read `session.pid`
   unconditionally is the thing this bump breaks quietest.
4. Treat `status` as four values, never a boolean, and never coerce `unknown`
   into `clean`. `no_repo` is the ORDINARY case, not a failure — on the machine
   this was measured against, 54 of 55 non-zero `git status` exits across 107
   live cwds were "not a git repository" — and `unknown` means a repository
   exists but git refused or did not answer inside the probe deadline. Show
   `statusAt` with it: every value is cached and therefore ages, and `null` means
   never observed.
5. Order `fleet` and `fleet_delta` by `epoch` + `seq`. A frame whose `epoch` you
   have not seen means "discard everything and take this snapshot"; a gap in
   `seq` means send `fleet_resync` and take the snapshot that answers it. Do not
   patch over a gap.
6. **REPLACE rows on a delta, never merge them, and never coalesce on id.**
   `appeared` and `changed` carry the full session body for exactly this reason:
   resuming a session reuses the SAME id with a NEW pid and `startedAt`, so the
   ordinary trace across a resume is `disappeared(X)` then `appeared(X)`. A
   client that merges keeps the dead pid and shows a process that no longer
   exists as the one it is talking to.
7. Handle `answered` on `permission_resolved`. **It grants nothing** — read it
   fail-closed, exactly as `denied`; only `approved` is permission. It closes the
   gap `0.3` shipped and documented at both ends: a `select` or an `input` offers
   no vocabulary that grants or refuses, so the wire had to state such an ending
   as `cancelled` (false — the ask was answered and its tool call RAN) or
   `approved` (false — nobody granted anything). With a `tool_permission` detail
   attached, which nothing stops an extension doing, that false word reached the
   durable audit row. What was actually chosen travels, as always, in
   `chosenOptionId`.
8. `session_resume` carries an id AND NOTHING ELSE — no path, no argv, no cwd, no
   environment. That is what keeps it from being an arbitrary-execution surface:
   the daemon resolves the id against its own index and builds the argv itself.
   Undeclared fields are dropped by the decoder, so smuggling one changes
   nothing. The answer is one `session_resumed` with a closed-set `code`; read
   `ok` rather than inferring success from the code, so a future code does not
   silently read as a success.

The corpus for this member records a fleet carrying BOTH kinds of row, a real
`fleet_delta` (a second session is really started and really stopped, and the
frames are the diff of two observations of a real directory), a `fleet_resync`
round trip, both honestly-reachable `session_resume` verdicts, and a
`permission_resolved` carrying `answered`. The reference daemon does not spawn and
does not probe git, and its header says exactly which parts of the 0.4 projection
are real and which are modelled.

## geist/0.3

The permission relay (R34-PERM.1, R34-PERM.4). Three added message types, one
changed one, none removed:

- server → client: `permission_request` (`requestId`, `method`, `toolCallId`,
  `toolName`, `cwd`, `title`, `message`, optional `command` / `path` /
  `operation`, `truncated`, `options[]`, `requestedAt`, `deadline`) and
  `permission_resolved` (`requestId`, `decision`, `chosenOptionId`, `surface`,
  `clientId`)
- client → server: `permission_response` (`clientId`, `requestId`, `optionId`)
- changed: `attach` gains an optional `capabilities: string[]`

All three ARE relayed — unlike the `0.2` device exchange, they cross to a draht
session's Unix socket — so each has a row in `MIRRORED_FRAMES` and the mirror
clause holds it field-for-field against
`packages/coding-agent/src/core/socket-server/types.ts`.

**What a renderer has to do.**

1. Send `capabilities: ["permission-relay"]` in `attach`. This is not decoration:
   a session sends `permission_request` and `permission_resolved` **only** to
   clients that declared it. A renderer that omits it keeps exactly the `0.2`
   frame set and is never sent a frame it cannot decode — which is the point, in
   the other direction too. A bridge built before `0.3` writes an attach line
   with no `capabilities` at all, so a new draht never kills it with a
   `protocol_error unknown_type` and close 1008.
2. Render `permission_request` and answer with `permission_response` naming one
   of the `options[].id` values that ask carried. An answer never names a
   decision — what an id means is fixed by the ask that offered it — and the
   `clientId` a renderer writes is overwritten by the bridge with the id this
   connection attached with, so one client cannot answer as another.
3. Take the dialog down on `permission_resolved`, whoever won. `decision` is
   `approved` | `denied` | `cancelled` | `expired`; `chosenOptionId` and
   `clientId` are null for the two outcomes no client chose.
4. Treat `deadline` as rendering data. It is advisory: real expiry binds to the
   session's own fail-closed timer, and a renderer that ignores the field changes
   no outcome.
5. Expect a reply to an unknown client frame. The socket wire gained a default
   case, so an answer for a request that is not pending comes back as a relayed
   `error` with code `PERMISSION_UNKNOWN_REQUEST`, and an undeclared client
   message type as `UNKNOWN_MESSAGE_TYPE`, instead of vanishing silently.

Every free-text field of the two server frames is bounded and carries a
neutralization predicate: no C0/DEL/C1 control, bidi override or invisible code
point survives to a surface. **The bound counts GRAPHEME CLUSTERS, not UTF-16
code units** — the unit `boundedSafeText` bounds by, so a legitimate emoji or
combining sequence is not refused for being several code units wide. **Bytes are
bounded separately, at construction, not by any check in this file**: one cluster
admits unboundedly many combining marks, so `boundedSafeText` also caps each
field's UTF-8 length (4 bytes per cluster, at most 4096 per field), which is what
keeps a whole `permission_request` under the 64 KiB `maxFrameBytes` the bridge
refuses a permission frame past rather than splitting it. The predicate is a
`.regex()` check hand-mirrored
from `NEUTRALIZED_FORBIDDEN_RANGES` in
`packages/coding-agent/src/core/socket-server/safe-text.ts` (this package keeps
zero `@draht/*` dependencies). It is a predicate, never a transform — a
transform would make decode→encode non-idempotent and these goldens compare
byte-wise.

## geist/0.2

The device-credential exchange (R33-REACH.3, R33-REACH.5). Three added message
types, no changed and no removed ones:

- client → server: `pair_device` (`bootstrapToken`, `device.name`, `device.platform`)
  and `authenticate` (`deviceId`, `credential`)
- server → client: `device_credential` (`deviceId`, `credential`, `issuedAt`,
  `expiresAt`) — the single answer to both

None of the three is relayed. They terminate at the daemon and never reach a
draht session's Unix socket, so none is in `MIRRORED_FRAMES` and the socket wire
did not move with this bump.

**What a renderer has to do.** A `0.1` renderer sent `hello` and was attached.
A `0.2` renderer has one more step, and two behaviours changed around it:

1. `hello` is answered with `server_hello` **and nothing else**. `fleet` no
   longer follows the handshake — nothing about the fleet reaches a connection
   that has not completed the exchange.
2. Send `pair_device` with the single-use bootstrap token from the QR or deep link on a
   first-ever connect, or `authenticate` with the stored `deviceId` +
   `credential` on every later one. Either is answered with `device_credential`,
   then `fleet`.
3. Persist the `deviceId` and `credential` out of that frame, replacing what was
   stored: every exchange rotates the credential, so the value just presented is
   dead the moment the answer arrives. Re-present the new one next time.
4. `attach`, `input` and `detach` before the exchange are refused with a
   `not_authenticated` `protocol_error` and the connection is dropped. So is a
   replayed bootstrap token — spend-on-use — while the device bound by the first
   exchange keeps its credential and its stream (R33-REACH.7).

No credential appears in a URL, query string or log line; it crosses this wire
as a message and nowhere else (R33-REACH.3). The corpus normalizes the recorded
credentials and their `issuedAt`/`expiresAt` instants rather than committing
real bearer values.

## geist/0.1

First published member — the Phase 32 attach wire (R32-FLEET.4, R32-FLEET.5).
Nothing to migrate from.

Thirteen message types, in two directions that share no type name:

- client → server: `hello` `attach` `input` `detach`
- server → client: `server_hello` `fleet` `session_metadata` `output`
  `input_echo` `client_joined` `client_left` `error` `protocol_error`

`input`, `detach`, `session_metadata`, `output`, `input_echo`, `client_joined`,
`client_left` and `error` are field-for-field mirrors of the draht socket wire
(`packages/coding-agent/src/core/socket-server/types.ts`) — the bridge relays
them unchanged. `attach` is that wire's `AttachMessage` plus exactly one
declared addition, `sessionId`, because one daemon fronts the whole fleet where
a Unix socket implied its own session.
