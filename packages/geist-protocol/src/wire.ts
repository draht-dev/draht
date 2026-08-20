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
 *   client → server  `hello` `pair_device` `authenticate` `attach` `input` `detach`
 *   server → client  `server_hello` `device_credential` `fleet`
 *                    `session_metadata` `output` `input_echo` `client_joined`
 *                    `client_left` `error` `protocol_error`
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
export const GEIST_PROTOCOL_VERSION = "0.2";

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

/** `server_hello` — the daemon's answer to `hello`, carrying its caps. */
export const ServerHelloFrameSchema = z.object({
	type: z.literal("server_hello"),
	protocol: ProtocolFamilySchema,
	version: ProtocolVersionSchema,
	server: z.object({ name: z.string().min(1), version: z.string().min(1) }),
	limits: TransportLimitsSchema,
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
 * One live attachable draht session as the fleet sees it (R32-FLEET.2): the
 * four fields the `<id>.sock` + `.lock` contract actually knows. The socket
 * path is deliberately absent — a renderer never needs a filesystem path, and
 * this frame reaches a phone.
 */
export const AttachableSessionSchema = z.object({
	id: z.string().min(1),
	cwd: z.string().min(1),
	pid: z.number().int().positive(),
	startedAt: z.string().min(1),
});
export type AttachableSession = z.infer<typeof AttachableSessionSchema>;

/**
 * `fleet` — every live attachable session, dead PIDs already filtered out.
 * The same body `GET /fleet` returns, so the list has one shape whether it
 * arrived over HTTP or was pushed down the socket.
 */
export const FleetFrameSchema = z.object({
	type: z.literal("fleet"),
	sessions: z.array(AttachableSessionSchema),
});
export type FleetFrame = z.infer<typeof FleetFrameSchema>;

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
