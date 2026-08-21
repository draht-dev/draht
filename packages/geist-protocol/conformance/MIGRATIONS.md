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
