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
