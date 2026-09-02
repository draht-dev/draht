import { z } from "zod";

/**
 * The Phase 32 attach wire (R32-FLEET.4).
 *
 * Every message that crosses between the geist daemon and a renderer is
 * declared here, once, as a zod schema — nowhere else. `check:geist-protocol`
 * fails when a wire type is declared outside this package, when the daemon
 * accepts a frame no schema here validates, or when the relayed half of this
 * file drifts field-for-field from the socket wire it relays
 * (`packages/coding-agent/src/core/socket-server/types.ts`).
 *
 * Two directions, deliberately disjoint by type name:
 *   client → server  `hello` `pair_device` `authenticate` `attach` `input`
 *                    `detach` `permission_response` `fleet_resync` `session_resume`
 *                    `session_spawn` `registry_resync`
 *   server → client  `server_hello` `device_credential` `fleet` `fleet_delta`
 *                    `session_metadata` `output` `input_echo` `client_joined`
 *                    `client_left` `error` `protocol_error`
 *                    `permission_request` `permission_resolved`
 *                    `session_resumed` `session_spawned` `registry`
 *
 * `pair_device`, `authenticate` and `device_credential` are the device-credential
 * exchange added in `geist/0.2` (R33-REACH.5). They terminate at the daemon:
 * none of them is relayed to a draht session, so none appears in the mirror
 * table and the mirror clause is unaffected by them.
 *
 * Six of the server frames and two of the client frames are *relayed*: the
 * bridge forwards them between the renderer and a draht session's Unix socket
 * unchanged (R32-FLEET.3), so their fields are a field-for-field mirror of the
 * socket wire, and the mirror table in `scripts/check-geist-protocol.mjs`
 * fails the build if either side moves without the other.
 */

/**
 * The protocol family this file speaks. Carried verbatim in both handshake
 * frames so a renderer that speaks a different protocol is refused at the
 * first frame rather than at the first field it cannot find.
 */
export const GEIST_PROTOCOL_FAMILY = "geist/0.x";

/**
 * The member of the `geist/0.x` family this file currently *is*. Pre-1.0
 * members are not compatible with one another: any field-level change to a
 * schema in this file requires bumping this constant, adding a migration note
 * to `conformance/MIGRATIONS.md`, and regenerating the conformance corpus
 * (R32-FLEET.5). `check:geist-protocol` fails the build otherwise.
 */
export const GEIST_PROTOCOL_VERSION = "0.5";

const ProtocolFamilySchema = z.literal(GEIST_PROTOCOL_FAMILY);
const ProtocolVersionSchema = z.literal(GEIST_PROTOCOL_VERSION);

/**
 * Attach mode. Field-for-field mirror of `ClientMode` on the socket wire —
 * a read-only client may attach and watch but its `input` is refused by the
 * draht session itself, which answers with a relayed `error` frame.
 */
export const ClientModeSchema = z.enum(["read-write", "read-only"]);
export type ClientMode = z.infer<typeof ClientModeSchema>;

/**
 * The transport caps a daemon advertises in `server_hello` (R32-FLEET.6). A
 * renderer that knows the caps can chunk its own writes instead of discovering
 * them by being disconnected.
 */
export const TransportLimitsSchema = z.object({
	/** Largest single frame the daemon will decode, in bytes. */
	maxFrameBytes: z.number().int().positive(),
	/** Frames the daemon will hold for one slow client before it overflows. */
	maxOutboundFrames: z.number().int().positive(),
	/** Bytes of session output the daemon will buffer for one client. */
	maxBufferedOutputBytes: z.number().int().positive(),
});
export type TransportLimits = z.infer<typeof TransportLimitsSchema>;

/**
 * The caps a daemon uses when its host does not override them. 64 KiB matches
 * the per-message cap the gateway's WS route already enforces, so a renderer
 * written against these numbers behaves the same on either host.
 */
export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
	maxFrameBytes: 64 * 1024,
	maxOutboundFrames: 1024,
	maxBufferedOutputBytes: 4 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// client → server
// ---------------------------------------------------------------------------

/**
 * `hello` — the renderer's first frame. Nothing else is accepted before it;
 * a daemon answers anything else with a `handshake_required` `protocol_error`.
 */
export const HelloFrameSchema = z.object({
	type: z.literal("hello"),
	protocol: ProtocolFamilySchema,
	version: ProtocolVersionSchema,
	client: z.object({ name: z.string().min(1), version: z.string().min(1) }),
});
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

/**
 * `attach` — bind this connection to one live draht session. Field-for-field
 * mirror of the socket wire's `AttachMessage` plus exactly one declared
 * addition, `sessionId`: on the socket wire the session is implied by which
 * `<id>.sock` the client dialled, and on this wire it has to be named because
 * one daemon fronts the whole fleet.
 */
export const AttachFrameSchema = z.object({
	type: z.literal("attach"),
	sessionId: z.string().min(1),
	clientId: z.string().min(1),
	mode: ClientModeSchema,
	/**
	 * What this connection understands beyond the frames every renderer has
	 * always received — the socket wire's `AttachMessage.capabilities`, mirrored.
	 * Absent means "an older renderer", and an older renderer is sent nothing new.
	 */
	capabilities: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type AttachFrame = z.infer<typeof AttachFrameSchema>;

/** `input` — relayed to the session's stdin. Exact mirror of `InputMessage`. */
export const InputFrameSchema = z.object({
	type: z.literal("input"),
	data: z.string(),
	clientId: z.string().min(1),
});
export type InputFrame = z.infer<typeof InputFrameSchema>;

/** `detach` — graceful leave. Exact mirror of `DetachMessage`. */
export const DetachFrameSchema = z.object({
	type: z.literal("detach"),
	clientId: z.string().min(1),
});
export type DetachFrame = z.infer<typeof DetachFrameSchema>;

/**
 * `pair_device` — the bootstrap half of the device exchange (R33-REACH.5). A renderer
 * that has never been here before presents the single-use, short-TTL token it
 * read off the QR or deep link, names itself, and gets back a `device_credential`
 * bound to a device id the daemon assigns. The token is invalidated at exchange:
 * a replay is answered with `not_authenticated` on the replaying connection only,
 * and the device already bound by the first exchange is undisturbed (R33-REACH.7).
 *
 * Deliberately NOT relayed. The bootstrap exchange terminates at the daemon and
 * never reaches a draht session's Unix socket, so this frame is absent from the
 * mirror table in `scripts/check-geist-protocol.mjs` on purpose.
 */
export const PairDeviceFrameSchema = z.object({
	type: z.literal("pair_device"),
	/** Single-use, short-TTL. Never carried in a URL, query string or log line (R33-REACH.3). */
	bootstrapToken: z.string().min(1),
	/**
	 * How this device names itself, so `geist devices list|revoke` has something
	 * a human can recognize (R33-REACH.6). Descriptive only: the daemon assigns
	 * the device id, a renderer never claims one at pair time.
	 */
	device: z.object({ name: z.string().min(1), platform: z.string().min(1) }),
});
export type PairDeviceFrame = z.infer<typeof PairDeviceFrameSchema>;

/**
 * `authenticate` — the reconnect half of the device exchange. An already-paired
 * renderer presents the credential it was last issued for its device id; the
 * daemon answers with a `device_credential` carrying a rotated value, so a
 * credential observed on one connection is dead by the next (R33-REACH.5).
 * A revoked device is refused here and at its next frame (R33-REACH.6).
 *
 * Not relayed, for the same reason as `pair_device`.
 */
export const AuthenticateFrameSchema = z.object({
	type: z.literal("authenticate"),
	deviceId: z.string().min(1),
	credential: z.string().min(1),
});
export type AuthenticateFrame = z.infer<typeof AuthenticateFrameSchema>;

// ---------------------------------------------------------------------------
// server → client
// ---------------------------------------------------------------------------

/**
 * `server_hello` — the daemon's answer to `hello`, carrying its caps and, since
 * `geist/0.4`, what it is willing to be asked.
 *
 * `capabilities` is the DAEMON's half of the negotiation `attach.capabilities`
 * already established in `0.3` for the renderer's half: the same pattern, the
 * other direction. Before it there was no channel through which a daemon could
 * say it accepts `fleet_resync` — and a renderer discovering that by sending one
 * to a daemon that does not have it gets `unknown_type` and close 1008, which
 * kills the connection rather than the frame.
 *
 * It is REQUIRED, not optional, and it is required so that the NEXT addition
 * costs nothing: from `0.4` onward a daemon that gains a verb advertises it here
 * and a renderer that does not recognize the string simply does not use it — no
 * `GEIST_PROTOCOL_VERSION` bump, and therefore no `version_mismatch` cliff that
 * hard-refuses every cached renderer at `hello`. A daemon with nothing extra to
 * declare sends `[]`; it may not omit the field, because "absent" would mean
 * "pre-0.4" and there is no pre-0.4 daemon that speaks 0.4.
 *
 * Elements are opaque tokens a renderer matches exactly. Nothing here is a
 * permission: a capability says a frame will be UNDERSTOOD, never that the
 * connection sending it has earned anything. The auth gate is unchanged.
 */
export const ServerHelloFrameSchema = z.object({
	type: z.literal("server_hello"),
	protocol: ProtocolFamilySchema,
	version: ProtocolVersionSchema,
	server: z.object({ name: z.string().min(1), version: z.string().min(1) }),
	limits: TransportLimitsSchema,
	capabilities: z.array(z.string().max(64)).max(32),
});
export type ServerHelloFrame = z.infer<typeof ServerHelloFrameSchema>;

/**
 * `device_credential` — the daemon's single answer to BOTH `pair_device` and
 * `authenticate`, carrying the rotated value (R33-REACH.5). One frame for both
 * so a renderer has one place to persist from: it stores `deviceId` and
 * `credential` and re-presents them in `authenticate` on the next connect,
 * whether this is its first exchange or its hundredth.
 *
 * The credential is a bearer value. It crosses this wire as a first message and
 * nowhere else — never a URL, query string, `Referer` or log line (R33-REACH.3)
 * — and the conformance corpus normalizes it rather than committing one.
 *
 * Not relayed: the daemon issues it, the socket wire has never heard of it.
 */
export const DeviceCredentialFrameSchema = z.object({
	type: z.literal("device_credential"),
	deviceId: z.string().min(1),
	/** The rotated value. The one this replaces is dead the moment this is sent. */
	credential: z.string().min(1),
	issuedAt: z.string().min(1),
	/** After this instant the daemon refuses the credential and the device re-bootstraps. */
	expiresAt: z.string().min(1),
});
export type DeviceCredentialFrame = z.infer<typeof DeviceCredentialFrameSchema>;

/**
 * Where a fleet row came from, and therefore what can be done with it
 * (R35-ALWAYS.7).
 *
 *   - `"socket"` — a live `<id>.sock` + `.lock` pair with a live pid behind it.
 *   - `"history"` — a session file on disk with no such pair. It was either
 *     never attachable or its process is gone; either way nothing is listening.
 *
 * TWO VALUES, AND NEITHER OF THEM IS `"live"`. The phase acceptance text names
 * `origin:socket` and `origin:history` verbatim, the corpus freezes those two
 * strings, and a renderer switches on them. `"live"` was the drafting word and
 * it is not on this wire.
 *
 * The discriminator is OBSERVABLE, not declared: there is no marker in a session
 * header that says which build wrote it (every header is format version 3), so
 * "predates socket registration" is not a thing any reader can see. What a reader
 * CAN see is whether a live socket pair exists for the header's id right now, and
 * that is exactly what this field reports.
 */
export const SessionOriginSchema = z.enum(["socket", "history"]);
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;

/**
 * The working tree's state as the last completed probe saw it (R35-ALWAYS.8).
 *
 * FOUR VALUES, NEVER A BOOLEAN, and never coerced back into one:
 *
 *   - `"clean"` — a git repository with nothing to commit.
 *   - `"dirty"` — a git repository with changes.
 *   - `"no_repo"` — the cwd is not inside a git repository. Its own value
 *     because it is the ordinary case, not a failure: on the machine this was
 *     measured against, 54 of the 55 non-zero `git status` exits across 107 live
 *     cwds were "not a git repository". Folding that into `unknown` would make
 *     the majority of the fleet read as broken.
 *   - `"unknown"` — a repository exists but git refused or did not answer inside
 *     the probe deadline. It MUST NOT collapse to `clean`: a probe that timed out
 *     knows nothing, and "clean" is the one answer a human acts on.
 */
export const SessionStatusSchema = z.enum(["clean", "dirty", "no_repo", "unknown"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * One session as the fleet sees it (R32-FLEET.2, R35-ALWAYS.7). The socket path
 * is deliberately absent — a renderer never needs a filesystem path, and this
 * frame reaches a phone.
 *
 * Since `geist/0.4` a row is no longer necessarily a LIVE row: `origin` says
 * where it came from and `attachable` / `resumable` say what may be done with
 * it. The three are carried separately rather than derived from one another
 * because a renderer must not have to know the derivation — and because they can
 * legitimately disagree (a live socket whose session file was deleted is
 * attachable and not resumable).
 *
 * `pid` is OPTIONAL from `0.4`, and that is a BREAKING field change rather than
 * an addition: a `history` row has no process, so a required `pid` could only be
 * satisfied by inventing one. Anything reading `pid` must handle its absence.
 */
export const AttachableSessionSchema = z.object({
	id: z.string().min(1),
	cwd: z.string().min(1),
	/** Absent for `origin: "history"` — there is no process. Present for a live socket. */
	pid: z.number().int().positive().optional(),
	startedAt: z.string().min(1),
	origin: SessionOriginSchema,
	/** A live socket is listening and `attach` will reach it. */
	attachable: z.boolean(),
	/** A session file exists that `session_resume` could start a new process from. */
	resumable: z.boolean(),
	status: SessionStatusSchema,
	/**
	 * When `status` was observed, ISO-8601, or null if it never was.
	 *
	 * Every status value AGES: the probe is deadline-bounded and its result is
	 * cached, so "clean" without a timestamp is a claim about an unstated moment.
	 * This is also the debounce basis for status deltas — a value that has not
	 * moved does not become a `fleet_delta` just because it was re-read.
	 */
	statusAt: z.string().min(1).max(64).nullable(),
});
export type AttachableSession = z.infer<typeof AttachableSessionSchema>;

/**
 * `fleet` — the whole fleet as one snapshot: live attachable sessions with dead
 * PIDs already filtered out, plus, since `geist/0.4`, historical rows. The same
 * body `GET /fleet` returns, so the list has one shape whether it arrived over
 * HTTP or was pushed down the socket.
 *
 * `epoch` + `seq` exist so a snapshot and the `fleet_delta` frames that follow it
 * are ORDERABLE ON ONE CONNECTION. Without them a renderer that receives a
 * snapshot and a delta has no way to tell which one describes the later world,
 * and a resync races the deltas it was meant to replace. `epoch` changes whenever
 * the observer restarts or loses continuity (its own identity, not a clock);
 * `seq` increases monotonically within an epoch. A frame carrying an epoch a
 * renderer has not seen means "throw away what you have and take this snapshot".
 */
export const FleetFrameSchema = z.object({
	type: z.literal("fleet"),
	sessions: z.array(AttachableSessionSchema),
	/** Identity of the observer run this snapshot came from. Opaque. */
	epoch: z.string().min(1),
	/** Monotonic within `epoch`. A delta with a lower `seq` is stale. */
	seq: z.number().int().nonnegative(),
});
export type FleetFrame = z.infer<typeof FleetFrameSchema>;

/**
 * One change to the fleet since the last frame on this connection.
 *
 * `appeared` AND `changed` CARRY THE FULL SESSION BODY, NEVER JUST AN ID — and a
 * client must REPLACE the row it holds rather than merge into it.
 *
 * That is not stylistic. Resuming a session reuses the SAME session id with a NEW
 * pid and a NEW `startedAt` (verified by running it), so the ordinary trace for
 * one key across a resume is `disappeared(X)` then `appeared(X)`. A client that
 * coalesces the pair on id — or that merges the `appeared` body into the row it
 * already had — keeps the dead pid and shows a process that no longer exists as
 * the one you are talking to. Replacing wholesale is what makes that impossible.
 *
 * `disappeared` carries only an id because there is nothing left to describe.
 */
export const FleetDeltaChangeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("appeared"), session: AttachableSessionSchema }),
	z.object({ kind: z.literal("disappeared"), id: z.string().min(1) }),
	z.object({ kind: z.literal("changed"), session: AttachableSessionSchema }),
]);
export type FleetDeltaChange = z.infer<typeof FleetDeltaChangeSchema>;

/**
 * `fleet_delta` — what moved, so a renderer stays current without reconnecting
 * (R35-ALWAYS.10). Ordered against the `fleet` snapshot by the same
 * `epoch` + `seq` pair.
 *
 * A gap in `seq`, or an `epoch` the renderer has not seen, is not something to
 * patch over: send `fleet_resync` and take the snapshot that answers it.
 *
 * `epoch` AND `seq` ARE REQUIRED HERE EXACTLY AS THEY ARE ON THE SNAPSHOT, and
 * that symmetry is the ordering property itself, not a tidiness. Optional would
 * not weaken this frame slightly: a delta with no `seq` cannot be placed against
 * the snapshot it follows, so "a gap in `seq`" becomes a sentence with no
 * referent and the `fleet_resync` the paragraph above prescribes can never be
 * triggered — a renderer would apply deltas in arrival order and call the result
 * current. The snapshot's pair was pinned by a test from the start and this one
 * was pinned by nothing; `test/wire-0.4-fields.test.ts` now refuses a
 * `fleet_delta` missing either, in both spellings a weakening takes.
 */
export const FleetDeltaFrameSchema = z.object({
	type: z.literal("fleet_delta"),
	/** Required, not optional. See above — the delta is unorderable without it. */
	epoch: z.string().min(1),
	/** Required, not optional. Monotonic within `epoch`; a lower `seq` is stale. */
	seq: z.number().int().nonnegative(),
	changes: z.array(FleetDeltaChangeSchema).min(1).max(256),
});
export type FleetDeltaFrame = z.infer<typeof FleetDeltaFrameSchema>;

/** `session_metadata` — relayed. Exact mirror of `SessionMetadataMessage`. */
export const SessionMetadataFrameSchema = z.object({
	type: z.literal("session_metadata"),
	sessionId: z.string(),
	cwd: z.string(),
	createdAt: z.string(),
});
export type SessionMetadataFrame = z.infer<typeof SessionMetadataFrameSchema>;

/** `output` — relayed. Exact mirror of `OutputMessage`. */
export const OutputFrameSchema = z.object({
	type: z.literal("output"),
	data: z.string(),
	stream: z.enum(["stdout", "stderr"]),
});
export type OutputFrame = z.infer<typeof OutputFrameSchema>;

/** `input_echo` — relayed. Exact mirror of `InputEchoMessage`. */
export const InputEchoFrameSchema = z.object({
	type: z.literal("input_echo"),
	data: z.string(),
	clientId: z.string(),
});
export type InputEchoFrame = z.infer<typeof InputEchoFrameSchema>;

/** `client_joined` — relayed. Exact mirror of `ClientJoinedMessage`. */
export const ClientJoinedFrameSchema = z.object({
	type: z.literal("client_joined"),
	clientId: z.string(),
	mode: ClientModeSchema,
});
export type ClientJoinedFrame = z.infer<typeof ClientJoinedFrameSchema>;

/** `client_left` — relayed. Exact mirror of `ClientLeftMessage`. */
export const ClientLeftFrameSchema = z.object({
	type: z.literal("client_left"),
	clientId: z.string(),
});
export type ClientLeftFrame = z.infer<typeof ClientLeftFrameSchema>;

/**
 * `error` — relayed. Exact mirror of `ErrorMessage`: an error raised by the
 * draht session, e.g. a read-only client that tried to type. Distinct from
 * `protocol_error`, which is raised by the daemon about this connection.
 */
export const ErrorFrameSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
	code: z.string().optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

/**
 * The closed set of transport-level failures (R32-FLEET.6). Closed on purpose:
 * a renderer switches on these, and a free-form string would push it back to
 * matching on prose.
 */
export const ProtocolErrorCodeSchema = z.enum([
	/** Frame exceeded `limits.maxFrameBytes`. */
	"frame_too_large",
	/** Not JSON, or JSON that no schema for this direction validates. */
	"invalid_frame",
	/** JSON with a `type` this direction does not declare. */
	"unknown_type",
	/** A frame arrived before `hello`. */
	"handshake_required",
	/** `hello` named a protocol family or 0.x member this daemon does not speak. */
	"version_mismatch",
	/**
	 * Credentials absent or rejected; raised before any Unix socket is opened.
	 * The first-message answer to a bad `pair_device` or `authenticate`, to a replayed
	 * bootstrap token, and to any `attach` on a connection that has not completed
	 * the exchange (R33-REACH.3, R33-REACH.5). Refusing here drops only the
	 * offending connection: a device already bound elsewhere is undisturbed
	 * (R33-REACH.7).
	 */
	"not_authenticated",
	/** `attach` named a session that is not live. */
	"unknown_session",
	/** This client's outbound queue passed `limits.maxOutboundFrames`. */
	"outbound_queue_overflow",
	/** This client's buffered output passed `limits.maxBufferedOutputBytes`. */
	"buffered_output_overflow",
]);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

/**
 * `protocol_error` — the daemon is about to drop *this* connection and says
 * why in a code a renderer can switch on. Other attached clients are
 * untouched: overflow is per-client, never per-session (R32-FLEET.6).
 */
export const ProtocolErrorFrameSchema = z.object({
	type: z.literal("protocol_error"),
	code: ProtocolErrorCodeSchema,
	message: z.string(),
});
export type ProtocolErrorFrame = z.infer<typeof ProtocolErrorFrameSchema>;

/**
 * The one-for-one hand mirror of `NEUTRALIZED_FORBIDDEN_RANGES` in
 * `packages/coding-agent/src/core/socket-server/safe-text.ts` — THAT FILE IS THE
 * SOURCE OF TRUTH. This package must keep zero `@draht/*` dependencies, so the
 * table cannot be imported; any edit there has to be repeated here by hand and
 * the two must stay equivalent code point for code point.
 *
 * C0 + DEL + C1, soft hyphen, the Arabic letter mark, the zero-width and
 * directional-marker blocks, the bidi isolates and overrides, the variation
 * selectors, the BOM, the interlinear annotation anchors and the tag characters.
 *
 * Expressed as a `.regex()` CHECK rather than a `.refine()` on purpose, and it
 * matters twice over:
 *
 *   - it is a PREDICATE, never a `.transform()`. A transform would rewrite the
 *     value, which changes the inferred type and makes decode→encode
 *     non-idempotent, and the conformance goldens compare byte-wise.
 *   - a `.refine()` wraps the field in `ZodEffects`, whose structure the mirror
 *     gate (`scripts/check-geist-protocol.mjs`) cannot compare against a socket
 *     wire `string` — every refined field would silently degrade to an opaque
 *     shape. A regex check leaves the field a `ZodString`, so the gate keeps
 *     comparing it field-for-field while the predicate is still enforced.
 *
 * `NeutralizedGraphemeBound` below folds the length bound into that same check,
 * for the same two reasons.
 */
const NEUTRALIZED_FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
	[0x0000, 0x001f], // C0 controls, including TAB, LF, CR and ESC
	[0x007f, 0x007f], // DEL
	[0x0080, 0x009f], // C1 controls, including CSI (U+009B)
	[0x00ad, 0x00ad], // SOFT HYPHEN
	[0x061c, 0x061c], // ARABIC LETTER MARK
	[0x200b, 0x200d], // ZWSP, ZWNJ, ZWJ
	[0x200e, 0x200f], // LRM, RLM
	[0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
	[0x2060, 0x2060], // WORD JOINER
	[0x2066, 0x2069], // LRI, RLI, FSI, PDI
	[0xfe00, 0xfe0f], // variation selectors VS1..VS16
	[0xfeff, 0xfeff], // ZWNBSP / BOM
	[0xfff9, 0xfffb], // interlinear annotation anchor/separator/terminator
	[0xe0000, 0xe007f], // tag characters
];

/**
 * The forbidden table as one negated, `u`-flagged character class: "this string
 * carries no code point from the table above".
 *
 * Built from the table rather than typed out as a regex literal so the two
 * cannot drift from each other by a keystroke — and so a reader comparing this
 * file against `safe-text.ts` is comparing two tables, not a table against a
 * wall of escapes.
 */
const NEUTRALIZED_TEXT = new RegExp(
	`^[^${NEUTRALIZED_FORBIDDEN_RANGES.map(([first, last]) =>
		first === last ? codePointEscape(first) : `${codePointEscape(first)}-${codePointEscape(last)}`,
	).join("")}]*$`,
	"u",
);

function codePointEscape(codePoint: number): string {
	return `\\u{${codePoint.toString(16)}}`;
}

/**
 * Grapheme-cluster segmentation — the SAME unit `boundedSafeText` bounds by in
 * `packages/coding-agent/src/core/socket-server/safe-text.ts`. `Intl.Segmenter`
 * ships with both Node and Bun, so counting the producer's unit costs this
 * package nothing, which matters: it must keep zero `@draht/*` dependencies, so
 * importing the counterpart is not an option and hand-mirroring is the contract.
 */
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Grapheme clusters in `value`. Linear, and it never materializes the segments. */
function graphemeCount(value: string): number {
	const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
	let count = 0;
	while (!segments.next().done) count++;
	return count;
}

/**
 * The whole `safeText` predicate: "neutralized, AND no longer than
 * `maxGraphemes` GRAPHEME CLUSTERS".
 *
 * COUNTING CLUSTERS IS THE POINT. `boundedSafeText(raw, 512)` bounds by grapheme
 * clusters, and a `z.string().max(512)` bounds by UTF-16 code units. One
 * legitimate cluster is routinely several code units — an astral emoji is two, a
 * flag four, a base with combining marks unboundedly many — so a code-unit cap
 * REFUSES text the producer constructed as valid. The daemon answers a frame no
 * schema validates by closing the connection with 1008, which is precisely the
 * phone-killing failure the capability gate was added to prevent, reintroduced
 * through a units mismatch. The two sides now count the same unit, so there is
 * nothing left to convert. Counting clusters is also all this does: the frame's
 * SIZE is bounded by the producer's byte ceiling, never by this check.
 *
 * Handed to `.regex()` as a `RegExp` SUBCLASS rather than written as the
 * `.refine()` this obviously wants to be, for the reason spelled out over
 * `NEUTRALIZED_FORBIDDEN_RANGES`: `.refine()` wraps the field in `ZodEffects`,
 * and the mirror gate then reads `opaque:ZodEffects` where the socket wire says
 * `string` and fails clause C of `scripts/check-geist-protocol.mjs` — measured,
 * not assumed. A subclass IS a `RegExp`, keeps the field a `ZodString`, and the
 * only method zod's regex check calls on it is `test`.
 *
 * A PREDICATE, never a transform: it inspects and refuses, it never rewrites, so
 * decode → encode stays byte-identical and the conformance goldens keep comparing.
 *
 * Both halves ride in ONE check on purpose. A second check would read as a second
 * rule, and the rule here is single: this is text `safe-text.ts` could have
 * produced.
 */
class NeutralizedGraphemeBound extends RegExp {
	readonly maxGraphemes: number;

	constructor(maxGraphemes: number) {
		super(NEUTRALIZED_TEXT.source, NEUTRALIZED_TEXT.flags);
		this.maxGraphemes = maxGraphemes;
	}

	override test(value: string): boolean {
		return super.test(value) && graphemeCount(value) <= this.maxGraphemes;
	}
}

/**
 * Attacker-influenced free text: bounded IN GRAPHEME CLUSTERS, and neutralized
 * before it got here.
 *
 * COUNTERPART: `boundedSafeText` in
 * `packages/coding-agent/src/core/socket-server/safe-text.ts`, which CONSTRUCTS
 * the text this only re-asserts. Its `maxGraphemes` argument and this one must
 * stay the same kind of number; the moment either stops counting grapheme
 * clusters, valid frames start being refused. `wire.test.ts` pins the unit and
 * every budget below, and `schema-fingerprint.json` records this check by its
 * pattern and its bound, so neither can move without the version gate seeing it.
 *
 * THIS BOUND IS IN DISPLAY UNITS AND BOUNDS NO BYTES. One cluster may carry
 * unboundedly many combining marks, so a frame every field of which satisfies
 * this predicate can still be hundreds of kilobytes. What keeps the bytes small
 * is the SECOND bound the producer applies at construction — `boundedSafeText`
 * bounds graphemes and UTF-8 bytes, whichever binds first — not anything in this
 * file. `decode`'s `maxFrameBytes` is a transport backstop with whatever value
 * its caller passed, and the attach bridge passes
 * `max(maxFrameBytes, maxBufferedOutputBytes)` = 4 MiB when it decodes a session
 * line, so a 383 KB permission frame passes decode and is refused later, at the
 * fit step, by dropping the renderer's connection.
 */
function safeText(maxGraphemes: number) {
	return z
		.string()
		.regex(
			new NeutralizedGraphemeBound(maxGraphemes),
			`must be at most ${maxGraphemes} grapheme clusters and carry no control, bidi or invisible code point that should have been neutralized before the wire`,
		);
}

/**
 * One answer a permission ask offers. Mirror of the socket wire's
 * `PermissionOption`.
 *
 * Named `…Relay…` only to stay out of the way of the unrelated, rejected-seam
 * `PermissionOptionSchema` this package still exports from `messages.ts`.
 */
export const PermissionRelayOptionSchema = z.object({
	id: z.string().min(1).max(128),
	label: safeText(200),
});
export type PermissionRelayOption = z.infer<typeof PermissionRelayOptionSchema>;

/**
 * `permission_request` — relayed. Exact mirror of `PermissionRequestMessage`.
 *
 * Every free-text field is bounded in grapheme clusters, the unit the producer
 * bounds by, so no frame `safe-text.ts` constructed is refused by THIS schema for
 * its length.
 *
 * That is a statement about clusters and nothing else. The bytes are bounded at
 * CONSTRUCTION, by the byte ceiling `boundedSafeText` applies alongside its
 * grapheme budget; nothing here re-asserts it, because a byte check in a schema
 * cannot tell a producer that stayed inside its budget from one that did not — it
 * can only refuse, and refusing a permission frame drops the renderer. With that
 * ceiling the whole frame is at most ~46 KB by that arithmetic (36 KB measured
 * for the worst witness), against the 64 KiB
 * `maxFrameBytes` the bridge fits it to; a permission frame that somehow does not
 * fit is refused there rather than chunked into halves a renderer would have to
 * reassemble before it could show anybody what it is approving.
 */
export const PermissionRequestFrameSchema = z.object({
	type: z.literal("permission_request"),
	requestId: z.string().min(1).max(128),
	method: z.enum(["confirm", "select", "input"]),
	toolCallId: z.string().min(1).max(128),
	toolName: safeText(128),
	cwd: safeText(1024),
	title: safeText(200),
	message: safeText(4000),
	command: safeText(4000).optional(),
	path: safeText(1024).optional(),
	operation: safeText(128).optional(),
	/** True when any field above had to be elided to fit its bound. */
	truncated: z.boolean(),
	options: z.array(PermissionRelayOptionSchema).max(16),
	requestedAt: z.string().min(1).max(64),
	/** Advisory rendering data only — the session's own timer is the one clock. */
	deadline: z.string().max(64).nullable(),
});
export type PermissionRequestFrame = z.infer<typeof PermissionRequestFrameSchema>;

/**
 * `permission_resolved` — relayed. Exact mirror of `PermissionResolvedMessage`.
 *
 * `answered` is the NEUTRAL member, added in `geist/0.4` to close the gap
 * `geist/0.3` shipped with and documented at both ends (ROADMAP.md, "Owner:
 * whoever next opens the wire"). A `select` or an `input` carries no permission
 * semantics — no option of theirs declares a `decision`, and answering one grants
 * and refuses nothing — so before this member existed the wire had to state such
 * an ending in a word that was false in one direction or the other: `cancelled`
 * for an ask that was ANSWERED and whose tool call RAN, or `approved` for a grant
 * nobody ever made. With a `tool_permission` detail attached — which nothing stops
 * an extension doing — that false word reached the durable audit row.
 *
 * IT GRANTS NOTHING. Every consumer must read it fail-closed: `answered` is not
 * `approved`, and code that treats "not denied" as permission is wrong about this
 * member first. `chosenOptionId` carries the choice that was actually made, which
 * is the whole of what an answered `select` means.
 */
export const PermissionResolvedFrameSchema = z.object({
	type: z.literal("permission_resolved"),
	requestId: z.string().min(1).max(128),
	decision: z.enum(["approved", "denied", "cancelled", "expired", "answered"]),
	chosenOptionId: z.string().max(128).nullable(),
	surface: safeText(64),
	clientId: z.string().max(128).nullable(),
});
export type PermissionResolvedFrame = z.infer<typeof PermissionResolvedFrameSchema>;

/**
 * `permission_response` — relayed. Exact mirror of `PermissionResponseMessage`.
 *
 * `clientId` is overwritten by the bridge with the id this connection attached
 * with, exactly as `input` and `detach` are, so one client cannot answer as
 * another.
 */
export const PermissionResponseFrameSchema = z.object({
	type: z.literal("permission_response"),
	clientId: z.string().min(1).max(128),
	requestId: z.string().min(1).max(128),
	optionId: z.string().min(1).max(128),
});
export type PermissionResponseFrame = z.infer<typeof PermissionResponseFrameSchema>;

// ---------------------------------------------------------------------------
// geist/0.4 — resync and resume
// ---------------------------------------------------------------------------

/**
 * `fleet_resync` — "I lost the thread; send me the whole fleet again."
 *
 * A DISTINCT POST-AUTHENTICATION VERB, and it has to be one. Neither of the two
 * obvious ways to spell it without a new frame works, both confirmed live against
 * a running daemon:
 *
 *   - a repeated `hello` is refused `invalid_frame` + close 1008, because the
 *     connection has already completed its handshake;
 *   - an unknown type is refused `unknown_type` + close 1008, which KILLS the
 *     connection — the exact outcome a resync exists to avoid.
 *
 * It carries no fields. A resync is not a query: there is one fleet, the daemon
 * knows it, and letting a renderer name a filter would be a second projection to
 * keep honest. The answer is a `fleet` snapshot carrying the current
 * `epoch` + `seq`, and everything the renderer held before it is discarded.
 *
 * Not relayed. It terminates at the daemon; no draht session has ever heard of it.
 */
export const FleetResyncFrameSchema = z.object({
	type: z.literal("fleet_resync"),
});
export type FleetResyncFrame = z.infer<typeof FleetResyncFrameSchema>;

/**
 * `session_resume` — start a process for a historical session (R35-ALWAYS.9).
 *
 * AN ID AND NOTHING ELSE. No path, no command, no argv, no cwd, no environment.
 * That is the whole of what keeps this from being an arbitrary-execution surface:
 * the daemon resolves the id against its own history index and constructs the
 * argv itself, so the worst a caller can name is a session that exists or one
 * that does not. A `path` field here — even a validated one — would make the
 * renderer a party to what executes, and this frame reaches a phone.
 *
 * Not relayed: it is answered by the daemon, which spawns; it never crosses to a
 * session's Unix socket.
 */
export const SessionResumeFrameSchema = z.object({
	type: z.literal("session_resume"),
	sessionId: z.string().min(1).max(128),
});
export type SessionResumeFrame = z.infer<typeof SessionResumeFrameSchema>;

/**
 * Why a `session_resume` ended the way it did. A closed set, for the same reason
 * `ProtocolErrorCodeSchema` is one: a renderer switches on these, and a free-form
 * string pushes it back to matching on prose.
 *
 *   - `resumed` — a process was started and has joined the fleet.
 *   - `already_live` — that id is already `origin: "socket"`; attach instead.
 *   - `not_found` — no session with that id is known.
 *   - `cwd_missing` — the session exists but the directory it ran in does not.
 *   - `refused` — policy said no (an untrusted project, a cap, a revoked device).
 *   - `spawn_failed` — the process could not be started.
 *   - `timeout` — it was started but did not join the fleet inside the deadline.
 *
 * `ok` is carried alongside rather than derived by the renderer: exactly one code
 * (`resumed`) is a success today, and a renderer that inferred success from the
 * code would have to be re-taught every time the set grows.
 */
export const SessionResumeCodeSchema = z.enum([
	"resumed",
	"already_live",
	"not_found",
	"cwd_missing",
	"refused",
	"spawn_failed",
	"timeout",
]);
export type SessionResumeCode = z.infer<typeof SessionResumeCodeSchema>;

/**
 * `session_resumed` — the answer to exactly one `session_resume`.
 *
 * `message` is human-facing prose and goes through the same `safeText` predicate
 * every other attacker-influenceable string on this wire does: a spawn failure
 * quotes a path and an errno, and a path is an attacker-influenceable string.
 */
export const SessionResumedFrameSchema = z.object({
	type: z.literal("session_resumed"),
	sessionId: z.string().min(1).max(128),
	ok: z.boolean(),
	code: SessionResumeCodeSchema,
	message: safeText(512),
});
export type SessionResumedFrame = z.infer<typeof SessionResumedFrameSchema>;

// geist/0.5 — spawn and registry

/** A key into the daemon's OWN registry, constrained so it can never read as a path fragment or prose. */
export const RegistryIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * TWO OPAQUE IDS AND NOTHING ELSE (R36-SPAWN.1): the daemon resolves both against
 * its own user-owned registry and builds the argv itself. A `path`, `cwd`, `argv`
 * or `env` here would make the renderer a party to what executes. Not relayed.
 */
export const SessionSpawnFrameSchema = z.object({
	type: z.literal("session_spawn"),
	harnessId: RegistryIdSchema,
	projectId: RegistryIdSchema,
});
export type SessionSpawnFrame = z.infer<typeof SessionSpawnFrameSchema>;

export const RegistryResyncFrameSchema = z.object({
	type: z.literal("registry_resync"),
});
export type RegistryResyncFrame = z.infer<typeof RegistryResyncFrameSchema>;

export const SessionSpawnCodeSchema = z.enum([
	"spawned",
	"unknown_harness",
	"unknown_project",
	"refused",
	"spawn_failed",
	"timeout",
]);
export type SessionSpawnCode = z.infer<typeof SessionSpawnCodeSchema>;

/** `sessionId` is OPTIONAL: the DAEMON mints it, so it crosses ONLY when a process was started. */
export const SessionSpawnedFrameSchema = z.object({
	type: z.literal("session_spawned"),
	sessionId: z.string().min(1).max(128).optional(),
	ok: z.boolean(),
	code: SessionSpawnCodeSchema,
	message: safeText(512),
});
export type SessionSpawnedFrame = z.infer<typeof SessionSpawnedFrameSchema>;

/** One harness. IT CARRIES NO `cmd`: an executable path tells a client what to attack and buys a picker nothing. */
export const RegistryHarnessSchema = z.object({
	id: RegistryIdSchema,
	isDefault: z.boolean(),
});
export type RegistryHarness = z.infer<typeof RegistryHarnessSchema>;

export const RegistryProjectSchema = z.object({
	id: RegistryIdSchema,
	name: safeText(200),
	root: safeText(1024),
});
export type RegistryProject = z.infer<typeof RegistryProjectSchema>;

export const RegistryFrameSchema = z.object({
	type: z.literal("registry"),
	harnesses: z.array(RegistryHarnessSchema).max(64),
	projects: z.array(RegistryProjectSchema).max(256),
});
export type RegistryFrame = z.infer<typeof RegistryFrameSchema>;

// ---------------------------------------------------------------------------
// unions, decoding, encoding
// ---------------------------------------------------------------------------

export const ClientFrameSchema = z.discriminatedUnion("type", [
	HelloFrameSchema,
	PairDeviceFrameSchema,
	AuthenticateFrameSchema,
	AttachFrameSchema,
	InputFrameSchema,
	DetachFrameSchema,
	PermissionResponseFrameSchema,
	FleetResyncFrameSchema,
	SessionResumeFrameSchema,
	SessionSpawnFrameSchema,
	RegistryResyncFrameSchema,
]);
export type GeistClientFrame = z.infer<typeof ClientFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion("type", [
	ServerHelloFrameSchema,
	DeviceCredentialFrameSchema,
	FleetFrameSchema,
	SessionMetadataFrameSchema,
	OutputFrameSchema,
	InputEchoFrameSchema,
	ClientJoinedFrameSchema,
	ClientLeftFrameSchema,
	ErrorFrameSchema,
	ProtocolErrorFrameSchema,
	PermissionRequestFrameSchema,
	PermissionResolvedFrameSchema,
	FleetDeltaFrameSchema,
	SessionResumedFrameSchema,
	SessionSpawnedFrameSchema,
	RegistryFrameSchema,
]);
export type GeistServerFrame = z.infer<typeof ServerFrameSchema>;

/**
 * The declared type name of every member, per direction. Derived from the
 * unions rather than typed out again, so the corpus gate's "one golden per
 * message type per direction" requirement cannot fall behind a schema that was
 * added to a union and nowhere else.
 */
export type GeistClientFrameType = GeistClientFrame["type"];
export type GeistServerFrameType = GeistServerFrame["type"];

export const CLIENT_FRAME_TYPES: readonly GeistClientFrameType[] = ClientFrameSchema.options.map(
	(option) => option.shape.type.value,
);

export const SERVER_FRAME_TYPES: readonly GeistServerFrameType[] = ServerFrameSchema.options.map(
	(option) => option.shape.type.value,
);

/** Frame decoding either yields a validated frame or the reason it did not. */
export type DecodeResult<TFrame> =
	| { readonly ok: true; readonly frame: TFrame }
	| { readonly ok: false; readonly code: ProtocolErrorCode; readonly message: string };

function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
		.join("; ");
}

function decode<TFrame>(
	schema: { safeParse(value: unknown): z.SafeParseReturnType<unknown, TFrame> },
	known: readonly string[],
	direction: string,
	raw: string,
	limits: TransportLimits,
): DecodeResult<TFrame> {
	const bytes = new TextEncoder().encode(raw).length;
	if (bytes > limits.maxFrameBytes) {
		return {
			ok: false,
			code: "frame_too_large",
			message: `frame is ${bytes} bytes, cap is ${limits.maxFrameBytes}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, code: "invalid_frame", message: `frame is not JSON: ${(error as Error).message}` };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, code: "invalid_frame", message: "frame is not a JSON object" };
	}

	const discriminator = (parsed as { type?: unknown }).type;
	if (typeof discriminator !== "string" || !known.includes(discriminator)) {
		return {
			ok: false,
			code: "unknown_type",
			message: `no ${direction} schema declares type ${JSON.stringify(discriminator)}`,
		};
	}

	const result = schema.safeParse(parsed);
	if (!result.success) {
		// A handshake frame that failed on `protocol` or `version` is a peer
		// speaking a different protocol, not a malformed one. Renderers act on
		// that differently — reconnect vs upgrade — so it gets its own code.
		const handshakeFields = result.error.issues.some(
			(issue) => issue.path[0] === "protocol" || issue.path[0] === "version",
		);
		if (handshakeFields && (discriminator === "hello" || discriminator === "server_hello")) {
			return { ok: false, code: "version_mismatch", message: describeIssues(result.error) };
		}
		return { ok: false, code: "invalid_frame", message: describeIssues(result.error) };
	}
	return { ok: true, frame: result.data };
}

/**
 * Decode one renderer → daemon frame. This is the *only* way a daemon may turn
 * received bytes into a frame: anything a schema in this file does not validate
 * comes back as a typed refusal, never as a partially-trusted object. Unknown
 * fields are dropped rather than carried, so no caller-supplied bytes ride
 * along inside an otherwise-valid frame.
 */
export function decodeClientFrame(
	raw: string,
	limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS,
): DecodeResult<GeistClientFrame> {
	return decode(ClientFrameSchema, CLIENT_FRAME_TYPES, "client→server", raw, limits);
}

/** Decode one daemon → renderer frame, under the same rules. */
export function decodeServerFrame(
	raw: string,
	limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS,
): DecodeResult<GeistServerFrame> {
	return decode(ServerFrameSchema, SERVER_FRAME_TYPES, "server→client", raw, limits);
}

/** Serialize a frame for the wire. WS frames are already delimited — no newline. */
export function encodeFrame(frame: GeistClientFrame | GeistServerFrame): string {
	return JSON.stringify(frame);
}

/** Build a validated `protocol_error`. Throws on a code outside the closed set. */
export function protocolError(code: ProtocolErrorCode, message: string): ProtocolErrorFrame {
	return ProtocolErrorFrameSchema.parse({ type: "protocol_error", code, message });
}
