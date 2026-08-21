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
point survives to a surface. The predicate is a `.regex()` check hand-mirrored
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
