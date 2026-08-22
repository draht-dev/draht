/**
 * The socket↔renderer attach bridge (R32-FLEET.1, R32-FLEET.3, R32-FLEET.6).
 *
 * One `AttachBridge` fronts one renderer connection. It speaks the geist wire
 * to the renderer and the draht socket wire to one live `<id>.sock`, and it is
 * the only thing between them:
 *
 *   renderer ──geist wire──▶ AttachBridge ──socket wire──▶ draht session
 *            ◀──────────────              ◀──────────────
 *
 * Four properties this file exists to hold, each proved by a test that drives
 * it rather than by the comment:
 *
 *   1. **Nothing becomes a frame except through `decodeClientFrame` /
 *      `decodeServerFrame`.** Bytes no exported schema validates are answered
 *      with a typed `protocol_error` and this connection is dropped. That
 *      applies to the socket side too: a socket-wire line that has drifted is
 *      refused *here*, so drift surfaces at the bridge instead of on a phone.
 *      Size is not drift — `maxFrameBytes` bounds the renderer's direction, and
 *      oversized session output is chunked rather than refused.
 *   2. **No session socket is opened for a connection that has not earned it.**
 *      The dial happens only after `hello`, after this connection has proved
 *      who it is, after `attach`, and after the named session is found live in
 *      the fleet.
 *   3. **Authentication is a gate, not a hint** (R33-REACH.3, R33-REACH.5). A
 *      bridge given a {@link DeviceAuthenticator} answers `hello` with
 *      `server_hello` and *nothing else* — the fleet is session data, so it
 *      waits — and accepts exactly two frames next: `pair_device` and
 *      `authenticate`. Anything else is `not_authenticated` and this
 *      connection is dropped. One attempt per connection, so one socket is not
 *      an online guessing oracle; a bounded window, so an idle unauthenticated
 *      connection does not sit there; and the identity that results is a field
 *      on this object, so two bridges in one process cannot see each other's
 *      (R33-REACH.7). And a gate that only opens is not a gate: `authorize` is
 *      asked before every *outbound* frame as well, which is where a revocation
 *      catches a connection that has stopped talking, and {@link
 *      AttachBridge.refuse} lets a host that observed one end it with no frame
 *      moving in either direction (R33-REACH.6).
 *   4. **Every bound is per-connection.** An overflowing renderer is dropped
 *      alone; the session keeps streaming to everyone else.
 *   5. **Identity is the daemon's.** A relayed frame carries the client id this
 *      connection attached with, never one the caller wrote into the frame, so
 *      no client can type or detach as another.
 *
 * Host-agnostic on purpose: the renderer side is the {@link RendererConnection}
 * port, so the same bridge runs behind the gateway's `Bun.serve` WebSocket today
 * and behind whatever hosts it after Phase 38, without moving the code across
 * the boundary gate.
 */

import { connect, type Socket } from "node:net";
import { join } from "node:path";
import {
	type AttachFrame,
	DEFAULT_TRANSPORT_LIMITS,
	decodeClientFrame,
	decodeServerFrame,
	encodeFrame,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistClientFrame,
	type GeistServerFrame,
	type ProtocolErrorCode,
	protocolError,
	ServerFrameSchema,
	type TransportLimits,
} from "@draht/geist-protocol";
import type { FleetSource, FleetUpdate } from "./fleet-observer.js";
import { buildFleetFrame, listAttachableSessions, sessionFilesAreOurs } from "./socket-sessions.js";

/**
 * The capability the session gates permission-frame emission on. A literal here
 * rather than an import: `packages/coding-agent` is on the far side of the
 * boundary gate, so this bridge cannot import its
 * `PERMISSION_RELAY_CAPABILITY` — it has to speak the same string.
 */
const PERMISSION_RELAY_CAPABILITY = "permission-relay";

/**
 * The capability a RENDERER declares in `attach` to be sent `fleet_delta`
 * (R35-ALWAYS.10).
 *
 * Gated rather than unconditional, and gated on the renderer's own declaration,
 * for the reason every other addition to this wire has been: a client built
 * before this frame existed re-validates everything the daemon sends and
 * `ServerFrameSchema.parse` of a type it does not know is a decode failure. An
 * old renderer therefore keeps receiving exactly one snapshot and nothing else,
 * which is precisely what it received before.
 *
 * `attach` is where it is declared because `attach` is the only client frame
 * with a `capabilities` field — `hello` has none. The consequence is deliberate
 * and stated so a reader does not mistake it for an oversight: a connection that
 * never attaches to a session is never sent deltas. It still has `fleet_resync`,
 * which is the pull half of the same mechanism.
 */
const FLEET_DELTA_CAPABILITY = "fleet-delta";

/**
 * The relayed frames that must never be chunked. See {@link AttachBridge.#fit}.
 */
const PERMISSION_FRAME_TYPES: ReadonlySet<string> = new Set(["permission_request", "permission_resolved"]);

/**
 * The renderer end of one attached connection, as the bridge needs it.
 *
 * `bufferedBytes` is the whole reason this is a port rather than a `WebSocket`:
 * the bound in R32-FLEET.6 is "bytes this host has accepted from us and not yet
 * put on the wire", which only the host can answer.
 */
export interface RendererConnection {
	/** Bytes handed to the host that have not reached the network yet. */
	bufferedBytes(): number;
	/** Put one encoded frame on the wire. */
	send(text: string): void;
	/** Drop this connection. `code` is a WebSocket close code. */
	close(code: number, reason: string): void;
}

/**
 * Who this connection has proved itself to be.
 *
 * Deliberately one field. Everything an authorization policy needs hangs off
 * the device id via the registry; copying device metadata in here would put a
 * second, staler copy of it in every bridge.
 */
export interface AttachIdentity {
	deviceId: string;
}

/**
 * What an authenticator answers with. The success branch carries exactly the
 * body of a `device_credential` frame, because that is what the client is owed:
 * the credential it just earned, already rotated (R33-REACH.5).
 *
 * `reason` on the failure branch is for the *host's* audit trail. It never
 * reaches the wire — see {@link AttachBridge.#spendAttempt} for why telling a
 * caller which way its credential was wrong is an oracle.
 */
export type DeviceAuthResult =
	| { ok: true; deviceId: string; credential: string; issuedAt: string; expiresAt: string }
	| { ok: false; reason?: string };

/**
 * The device store as this bridge needs it — the port `DeviceRegistry` fills.
 *
 * A port rather than a direct dependency for the usual boundary reason (a
 * bridge that opened the credential file would be a second writer of it), and
 * synchronous on purpose: `receive()` is called from a socket's message
 * callback and frame order is load-bearing, so an authentication that returned
 * a promise would let the frame after it overtake the gate.
 */
export interface DeviceAuthenticator {
	/** Spend a bootstrap token for a device id and its first credential. */
	pair(input: { bootstrapToken: string; device: { name: string; platform: string } }): DeviceAuthResult;
	/** Verify an already-issued credential and rotate it. */
	authenticate(input: { deviceId: string; credential: string }): DeviceAuthResult;
	/**
	 * Whether a device that already authenticated has since been barred
	 * (R33-REACH.6).
	 *
	 * Separate from {@link DeviceAuthenticator.authenticate} because the question
	 * is different: `authenticate` asks whether a *secret* is good, and a
	 * connection that is merely receiving output presents no secret to ask about.
	 * This asks about an identity, which is the only thing an attached connection
	 * still has.
	 *
	 * Optional, because a store may genuinely be unable to answer — and a store
	 * that cannot is not thereby a store that says "no". The host is expected to
	 * notice the absence and say so; see `createFleetRoutes`.
	 */
	isRevoked?(deviceId: string): boolean;
	/**
	 * Be told when the store changed underneath this process, so a revocation
	 * reaches a connection that is sending nothing.
	 *
	 * Optional for the same reason as {@link DeviceAuthenticator.isRevoked}, and
	 * with the same consequence when absent: the refusal still holds on the
	 * device's next inbound frame and on the next frame emitted to it, but a
	 * silent connection to a silent session keeps its socket until one of those
	 * happens.
	 *
	 * @returns an unsubscribe the host calls when the connection ends.
	 */
	subscribe?(listener: () => void): () => void;
}

/**
 * A credential the host read off the upgrade request — `Authorization: Bearer`
 * or the `geist.bearer.<base64url>` subprotocol, the only two sources
 * R33-REACH.3 leaves standing. The host decodes it into this pair; the bridge
 * verifies it down exactly the same path as an `authenticate` frame, so a
 * header-authenticated client and a first-message one are the same client to
 * everything downstream.
 */
export interface PresentedCredential {
	deviceId: string;
	credential: string;
}

/**
 * One authorization question. Asked of every frame in both directions, which
 * is what makes this the single seam a per-device policy attaches to rather
 * than a set of call sites a later change can miss.
 */
export type AuthorizationRequest =
	| {
			direction: "inbound";
			frame: GeistClientFrame;
			identity: AttachIdentity | null;
			sessionId: string | null;
	  }
	| {
			direction: "outbound";
			frame: GeistServerFrame;
			identity: AttachIdentity | null;
			sessionId: string | null;
	  };

/** The answer. A refusal names the code the client is disconnected with. */
export type AuthorizationVerdict = { allow: true } | { allow: false; code?: ProtocolErrorCode; message?: string };

/** Default pre-auth window: a connection that says nothing for this long is dropped. */
export const DEFAULT_AUTH_DEADLINE_MS = 5_000;

export interface AttachBridgeOptions {
	/** Directory the fleet publishes itself in. See `resolveSocketDir`. */
	socketDir: string;
	/** The renderer this bridge fronts. */
	connection: RendererConnection;
	/** Name and version this daemon advertises in `server_hello`. */
	server?: { name: string; version: string };
	/** Transport caps. Defaults to the protocol's published defaults. */
	limits?: TransportLimits;
	/** How often a paused session is re-checked while the renderer drains. */
	drainCheckMs?: number;
	/**
	 * The device store this bridge authenticates against.
	 *
	 * Its **presence is the switch**: a bridge given one requires a credential
	 * before it will say anything but `server_hello`, and a bridge given none is
	 * one whose host already authenticated the upgrade request — which is what
	 * the gateway's bearer middleware does today — and behaves exactly as it did
	 * before this gate existed.
	 */
	devices?: DeviceAuthenticator;
	/**
	 * A credential the host found on the upgrade request. Verified at `hello`,
	 * and it spends this connection's one attempt just as a first message would.
	 */
	presentedCredential?: PresentedCredential;
	/**
	 * How long an unauthenticated connection may sit here. Defaults to 5s. The
	 * window exists because an authenticated connection is bounded by everything
	 * else in this file and an unauthenticated one is bounded by nothing.
	 */
	authDeadlineMs?: number;
	/**
	 * Consulted on every inbound frame and before every outbound emit. Absent
	 * means "authentication is the whole policy"; present means this hook has
	 * the last word, in both directions, on every frame.
	 *
	 * The outbound half is what R33-REACH.6 rests on. "Refused at its next
	 * frame" is inbound-only, and a revoked device that sends nothing has no
	 * next frame — so the check that actually stops a stolen phone reading a
	 * transcript is the one asked before each emit, on an identity rather than
	 * on a credential.
	 *
	 * A hook that throws refuses the frame. Failing closed is the only safe
	 * reading of a policy that could not answer.
	 */
	authorize?: (request: AuthorizationRequest) => AuthorizationVerdict;
	/**
	 * How to ask this host's session socket how many bytes it has accepted from
	 * us and not yet flushed.
	 *
	 * Defaults to `writableLength`, node's documented answer. It is an option
	 * because the answer is the *host's*, not this module's, and hosts differ:
	 * measured on 2026-08-19, Bun's `node:net` against a Unix peer that never
	 * reads reports `writableLength` back at 0 immediately and fires the write
	 * callback, i.e. it buffers internally and tells us nothing — so on that host
	 * the bound below is inert and the per-frame byte cap is what holds. A test
	 * supplies a host that does report a backlog, which is what proves the
	 * policy; nothing here can prove another runtime's bookkeeping.
	 */
	backlogBytes?: (socket: Socket) => number;
	/**
	 * The daemon's single fleet observer (R35-ALWAYS.10).
	 *
	 * Its ABSENCE is the switch, exactly as `devices` is. Given one, this bridge
	 * never scans the socket directory itself: the `hello` snapshot, the answer
	 * to `fleet_resync` and every `fleet_delta` come from that one observer, so
	 * they share an `epoch`, their `seq` values are consecutive, and the daemon
	 * has ONE reader — and therefore one reaper — of a directory whose reader
	 * deletes files. Given none, the bridge falls back to `buildFleetFrame`,
	 * which is what it did before the observer existed: one snapshot at `hello`
	 * and nothing after it.
	 */
	fleet?: FleetSource;
}

/** WebSocket close code for a policy violation — every typed refusal uses it. */
const CLOSE_POLICY_VIOLATION = 1008;
/** WebSocket close code for "the thing you were watching went away". */
const CLOSE_GOING_AWAY = 1001;
/** Normal closure — a detach the renderer asked for. */
const CLOSE_NORMAL = 1000;

const DEFAULT_DRAIN_CHECK_MS = 25;

export class AttachBridge {
	readonly #socketDir: string;
	readonly #conn: RendererConnection;
	readonly #limits: TransportLimits;
	/**
	 * Caps applied to a line read off the SESSION socket.
	 *
	 * `maxFrameBytes` is a bound on what a RENDERER may send this daemon — the
	 * one direction with an untrusted peer and no flow control. It says nothing
	 * about how much a draht session may print, and one ordinary tool result (a
	 * large file read, a long diff) is one socket-wire line however long it is.
	 * Measuring session output against that cap and calling the excess protocol
	 * drift would disconnect every attached client for output none of them asked
	 * for, so session lines are bounded by the buffered-output limit instead and
	 * anything past `maxFrameBytes` is chunked on the way out ({@link
	 * AttachBridge.#fit}).
	 */
	readonly #sessionLimits: TransportLimits;
	readonly #server: { name: string; version: string };
	readonly #drainCheckMs: number;
	readonly #backlogBytes: (socket: Socket) => number;
	readonly #devices: DeviceAuthenticator | null;
	readonly #presented: PresentedCredential | null;
	readonly #authDeadlineMs: number;
	readonly #authorize: ((request: AuthorizationRequest) => AuthorizationVerdict) | null;

	/**
	 * Who this connection is, or null while it is nobody.
	 *
	 * A field, not a module-level map keyed by anything: one daemon fronts a
	 * whole fleet and runs many bridges at once, and an identity kept anywhere
	 * but here would be one connection's credential deciding another
	 * connection's access the moment two handshakes overlap (R33-REACH.7).
	 */
	#identity: AttachIdentity | null = null;
	/** Whether this connection may send anything beyond the two auth frames. */
	#authenticated: boolean;
	/** Whether this connection's one authentication attempt has been used. */
	#authSpent = false;
	#authTimer: ReturnType<typeof setTimeout> | null = null;

	#greeted = false;
	#closed = false;
	#detached = false;
	#session: Socket | null = null;
	#sessionId: string | null = null;
	/**
	 * The id this connection attached with, pinned server-side.
	 *
	 * Every relayed frame is stamped with this rather than with whatever
	 * `clientId` the inbound frame carried: the session authorises by client id
	 * (read-only mode, and which client a `detach` disconnects), so honouring a
	 * caller-supplied id would let any client on a public wire type as another
	 * and detach another.
	 */
	#clientId: string | null = null;
	#sessionBuffer = "";
	#paused = false;
	#drainTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Frames handed to a renderer that has not flushed anything since. Reset the
	 * moment its buffer empties, so this counts backlog depth rather than
	 * lifetime traffic.
	 */
	#queuedFrames = 0;
	/** The same count, for frames this client has queued toward the session. */
	#queuedSessionFrames = 0;

	/** The daemon's one fleet observer, or null on a bridge given none. */
	readonly #fleet: FleetSource | null;
	/** Drops this connection's delta subscription. Null while not subscribed. */
	#unsubscribeFleet: (() => void) | null = null;
	/**
	 * The `seq` of the last fleet frame — snapshot or delta — this connection was
	 * sent, or -1 before any.
	 *
	 * Kept so the moment a connection SUBSCRIBES cannot open a gap. `hello`
	 * snapshots and `attach` subscribes, and the fleet may well have moved
	 * between them; without this the client's first delta would carry a `seq`
	 * two or more past its snapshot, and its only correct response would be the
	 * `fleet_resync` this field makes unnecessary.
	 */
	#fleetSeqSent = -1;

	constructor(options: AttachBridgeOptions) {
		this.#socketDir = options.socketDir;
		this.#conn = options.connection;
		this.#limits = options.limits ?? DEFAULT_TRANSPORT_LIMITS;
		this.#sessionLimits = {
			...this.#limits,
			maxFrameBytes: Math.max(this.#limits.maxFrameBytes, this.#limits.maxBufferedOutputBytes),
		};
		this.#server = options.server ?? { name: "geist-attach-bridge", version: GEIST_PROTOCOL_VERSION };
		this.#drainCheckMs = options.drainCheckMs ?? DEFAULT_DRAIN_CHECK_MS;
		this.#backlogBytes = options.backlogBytes ?? ((socket) => socket.writableLength);
		this.#devices = options.devices ?? null;
		this.#presented = options.presentedCredential ?? null;
		this.#authDeadlineMs = options.authDeadlineMs ?? DEFAULT_AUTH_DEADLINE_MS;
		this.#authorize = options.authorize ?? null;
		this.#fleet = options.fleet ?? null;
		// No device store means the host authenticated the upgrade request; see
		// `AttachBridgeOptions.devices`. Anything else and this connection starts
		// out as nobody, on a clock.
		this.#authenticated = this.#devices === null;
		if (!this.#authenticated) this.#startAuthTimer();
	}

	/**
	 * The device this connection authenticated as, or null. Null on an
	 * authenticated bridge too, when the host — not a device credential — is
	 * what vouched for the connection.
	 */
	get identity(): AttachIdentity | null {
		return this.#identity;
	}

	/** Whether this connection has passed the gate, however it passed it. */
	get authenticated(): boolean {
		return this.#authenticated;
	}

	/** The session this connection is attached to, or null before `attach`. */
	get sessionId(): string | null {
		return this.#sessionId;
	}

	/** Whether the session is currently paused because the renderer is behind. */
	get sessionPaused(): boolean {
		return this.#paused;
	}

	/**
	 * Handle one frame from the renderer.
	 *
	 * @param raw - The frame exactly as it arrived. Never parsed by the caller:
	 *              the byte cap is enforced on these bytes.
	 */
	receive(raw: string): void {
		if (this.#closed) return;

		const decoded = decodeClientFrame(raw, this.#limits);
		if (!decoded.ok) {
			this.#refuse(decoded.code, decoded.message);
			return;
		}
		const frame = decoded.frame;

		if (!this.#allowed({ direction: "inbound", frame, identity: this.#identity, sessionId: this.#sessionId })) return;

		if (!this.#greeted && frame.type !== "hello") {
			this.#refuse("handshake_required", `expected hello, got ${frame.type}`);
			return;
		}

		// The gate. Three frame types exist before a credential does: the
		// handshake, and the two halves of the exchange. Everything else — every
		// frame that would reach a session, and the fleet listing that would
		// describe one — is refused here, above the switch, so no later case can
		// be added below it that forgets to ask.
		if (
			!this.#authenticated &&
			frame.type !== "hello" &&
			frame.type !== "pair_device" &&
			frame.type !== "authenticate"
		) {
			this.#refuse("not_authenticated", `${frame.type} before this connection presented a credential`);
			return;
		}

		switch (frame.type) {
			case "hello": {
				if (this.#greeted) {
					this.#refuse("invalid_frame", "hello was already sent on this connection");
					return;
				}
				// A credential from the upgrade request is spent before a single
				// word is said back, so a bad one costs the client the handshake it
				// had not earned rather than merely the frame after it.
				let credential: GeistServerFrame | null = null;
				if (!this.#authenticated && this.#presented !== null) {
					credential = this.#spendAttempt(
						this.#authenticateWith(this.#presented),
						"the credential presented on the upgrade request",
					);
					if (credential === null) return;
				}
				this.#greeted = true;
				this.#emit({
					type: "server_hello",
					protocol: GEIST_PROTOCOL_FAMILY,
					version: GEIST_PROTOCOL_VERSION,
					server: this.#server,
					limits: this.#limits,
					// `geist/0.4` requires the field and forbids omitting it: absent would
					// mean "pre-0.4", and there is no pre-0.4 daemon that speaks 0.4. What
					// is declared here is exactly what this daemon WILL ANSWER, never what
					// a later task intends to: advertising a verb that is not wired yet
					// buys a renderer a frame that is silently ignored, which is worse
					// than the renderer knowing it cannot ask. `session-resume` joins this
					// list in the task that implements it.
					capabilities: this.#capabilities(),
				});
				if (credential !== null) this.#emit(credential);
				// The fleet is session data: which sessions exist, where they run
				// and under which pid. It goes out once this connection is somebody
				// and not a frame earlier.
				if (this.#authenticated) this.#emitFleetSnapshot();
				return;
			}
			case "pair_device": {
				this.#exchange("the bootstrap token", (devices) =>
					devices.pair({ bootstrapToken: frame.bootstrapToken, device: frame.device }),
				);
				return;
			}
			case "authenticate": {
				this.#exchange("the credential", (devices) =>
					devices.authenticate({ deviceId: frame.deviceId, credential: frame.credential }),
				);
				return;
			}
			case "attach": {
				if (this.#session) {
					this.#refuse("invalid_frame", "this connection is already attached");
					return;
				}
				this.#attach(frame);
				return;
			}
			case "fleet_resync": {
				// A DISTINCT VERB, and it has to be one: a repeated `hello` is refused
				// `invalid_frame` and an unknown type is refused `unknown_type`, both
				// with close 1008 — and killing the connection is the exact outcome a
				// resync exists to avoid. So this case answers and RETURNS: nothing
				// below closes anything, and a client that has lost the thread keeps
				// the socket, the session it is attached to, and its place in the
				// stream.
				//
				// Accepted at any point after authentication, including while
				// attached, because that is when it is needed: a phone that slept
				// through a delta is still attached to a session it is watching.
				this.#emitFleetSnapshot();
				return;
			}
			case "input":
			case "detach":
			case "permission_response": {
				const session = this.#session;
				const clientId = this.#clientId;
				if (!session || !clientId) {
					this.#refuse("invalid_frame", `${frame.type} before attach`);
					return;
				}
				// Exact mirrors of the socket wire: validated, then relayed with one
				// field overwritten. Re-encoding rather than forwarding the received
				// bytes is what guarantees no undeclared field rides along, and
				// stamping `clientId` with the id this connection attached with is
				// what stops one client speaking — or detaching, or ANSWERING A
				// PERMISSION — as another. An answer that could name someone else's
				// client id would be an approval attributable to a phone that never
				// gave it.
				if (!this.#writeSession(session, `${encodeFrame({ ...frame, clientId })}\n`)) return;
				if (frame.type === "detach") {
					this.#detached = true;
					session.end();
					this.#session = null;
					this.#unsubscribe();
					this.#conn.close(CLOSE_NORMAL, "detached");
					this.#closed = true;
				}
				return;
			}
		}
	}

	/**
	 * Refuse this connection because something *outside* it changed
	 * (R33-REACH.6).
	 *
	 * Every other refusal in this file is provoked by a frame — one arriving, or
	 * one about to leave. A revocation is provoked by neither: it happens in
	 * another process, to a connection that may be sending nothing and receiving
	 * nothing, and the whole point of R33-REACH.6 is that such a connection is
	 * cut anyway. So the host, which is what can observe the store, gets a way to
	 * say so.
	 *
	 * The client is told with the same typed `protocol_error` any other refusal
	 * uses and the same 1008 close, because from the phone's side this is not a
	 * special event: it is the daemon declining to keep talking to it, and a
	 * renderer that already handles `not_authenticated` handles this without
	 * knowing the difference.
	 *
	 * Idempotent, and a no-op on a connection that is already closing.
	 *
	 * @param code    - The typed refusal the client is given.
	 * @param message - Operator-facing detail. Carries no finding id and no
	 *                  credential material.
	 */
	refuse(code: ProtocolErrorCode, message: string): void {
		this.#refuse(code, message);
	}

	/** The renderer went away. Release the session socket. */
	close(): void {
		this.#closed = true;
		this.#clearDrainTimer();
		this.#clearAuthTimer();
		// Alongside the session socket, and for the same reason: a listener held
		// by the observer for a connection that is gone is a leak that also keeps
		// the observer's poll armed.
		this.#unsubscribe();
		const session = this.#session;
		this.#session = null;
		try {
			session?.end();
		} catch {
			// The session may already be gone; nothing to unwind.
		}
	}

	/**
	 * Both halves of the device exchange, which differ only in what the client
	 * presented — `run` is the half. Neither half is relayed: the exchange
	 * terminates here and a draht session never hears about it.
	 *
	 * @param present - What was presented, for the refusal message. Never why it
	 *                  failed; see {@link AttachBridge.#spendAttempt}.
	 * @param run     - The store call this half makes. Not invoked unless this
	 *                  connection still has an attempt to spend.
	 */
	#exchange(present: string, run: (devices: DeviceAuthenticator) => DeviceAuthResult): void {
		const devices = this.#devices;
		if (devices === null) {
			this.#refuse("not_authenticated", "this daemon does not exchange device credentials on the wire");
			return;
		}
		// One attempt per connection, checked before the store is touched. A
		// socket that could be guessed on twice could be guessed on forever, and
		// the cost of a fresh connection per guess is the whole point.
		if (this.#authSpent) {
			this.#refuse("not_authenticated", "this connection has already spent its one authentication attempt");
			return;
		}

		const credential = this.#spendAttempt(run(devices), present);
		if (credential === null) return;

		this.#emit(credential);
		this.#emitFleetSnapshot();
	}

	/** What this daemon will answer, as `server_hello.capabilities` (`geist/0.4`). */
	#capabilities(): string[] {
		// Conditional on the observer, because without one there is no delta
		// stream and no state for a resync to answer FROM — the fallback path
		// emits one snapshot at `hello` and nothing after it. A daemon that
		// declared `fleet-delta` anyway would be promising a stream it has no
		// producer for.
		return this.#fleet === null ? [] : [FLEET_DELTA_CAPABILITY];
	}

	/**
	 * Send the current fleet, and remember where in the stream that left this
	 * client.
	 *
	 * The observer's `refreshNow()` is the ONE scan in this daemon; a bridge with
	 * no observer falls back to `buildFleetFrame`, which scans per connection —
	 * the behaviour this class had before, kept so a host that constructs a
	 * bridge alone still gets a fleet listing.
	 */
	#emitFleetSnapshot(): void {
		const frame = this.#fleet === null ? buildFleetFrame(this.#socketDir) : this.#fleet.refreshNow();
		this.#fleetSeqSent = frame.seq;
		this.#emit(frame);
	}

	/**
	 * Start feeding this connection `fleet_delta` frames.
	 *
	 * Called from `attach`, which is where the renderer declares it understands
	 * them. The snapshot-first step is the ordering guarantee at the seam: if the
	 * fleet moved between this connection's `hello` and its `attach`, the client
	 * is re-based on a fresh snapshot BEFORE the subscription, so the first delta
	 * it sees carries `snapshot.seq + 1` rather than a gap it would have to
	 * recover from.
	 */
	#subscribeToFleet(): void {
		const fleet = this.#fleet;
		if (fleet === null || this.#unsubscribeFleet !== null) return;
		// Both of these are synchronous, and the runtime is single-threaded, so no
		// tick can land between them. That is what makes "the snapshot and the
		// deltas that follow it come from the same observer" true by construction
		// rather than by a lock.
		if (fleet.seq !== this.#fleetSeqSent) this.#emitFleetSnapshot();
		if (this.#closed) return;
		this.#unsubscribeFleet = fleet.subscribe((update) => this.#onFleetUpdate(update));
	}

	/** Release this connection's delta subscription. Idempotent. */
	#unsubscribe(): void {
		const stop = this.#unsubscribeFleet;
		this.#unsubscribeFleet = null;
		try {
			stop?.();
		} catch {
			// A subscription that cannot be released is not a reason to fail a close.
		}
	}

	/**
	 * One observer transition, as this connection sees it.
	 *
	 * FAN-OUT BUDGET (R32-FLEET.6). A burst of session churn must not spend a
	 * phone's output budget and get the phone disconnected for it. Two bounds,
	 * and both of them replace a backlog with a single authoritative frame rather
	 * than dropping anything:
	 *
	 *   - the observer already coalesces a whole tick into ONE delta, and hands
	 *     over a snapshot instead when a tick moved more rows than one delta frame
	 *     may carry;
	 *   - here, a connection whose buffer is already half the cap is sent the
	 *     snapshot rather than the delta. A renderer replaces wholesale on a
	 *     snapshot, so the frames it did not receive cost it nothing — and one
	 *     snapshot is bounded by the fleet size, while a backlog of deltas is
	 *     bounded by how long the phone has been slow.
	 */
	#onFleetUpdate(update: FleetUpdate): void {
		if (this.#closed) return;
		if (update.kind === "snapshot") {
			this.#fleetSeqSent = update.snapshot.seq;
			this.#emit(update.snapshot);
			return;
		}
		if (this.#conn.bufferedBytes() >= Math.floor(this.#limits.maxBufferedOutputBytes / 2)) {
			this.#emitFleetSnapshot();
			return;
		}
		this.#fleetSeqSent = update.delta.seq;
		this.#emit(update.delta);
	}

	/** Verify a credential the host read off the upgrade request. */
	#authenticateWith(presented: PresentedCredential): DeviceAuthResult {
		const devices = this.#devices;
		if (devices === null) return { ok: false, reason: "no device store" };
		return devices.authenticate({ deviceId: presented.deviceId, credential: presented.credential });
	}

	/**
	 * Spend this connection's one attempt on `result`.
	 *
	 * The refusal message says only *which* credential was rejected, never why.
	 * "no such device", "wrong credential" and "a credential you already rotated
	 * away" are three different facts about the store, and handing a caller the
	 * difference turns one connection into a lookup service; the store already
	 * raised the one outcome worth waking up for as an audit event, where it
	 * belongs.
	 *
	 * @returns the `device_credential` frame the client has earned, or null when
	 *          the connection has been refused and is already closing.
	 */
	#spendAttempt(result: DeviceAuthResult, what: string): GeistServerFrame | null {
		this.#authSpent = true;
		if (!result.ok) {
			this.#refuse("not_authenticated", `${what} was rejected`);
			return null;
		}
		this.#authenticated = true;
		this.#identity = { deviceId: result.deviceId };
		this.#clearAuthTimer();
		return {
			type: "device_credential",
			deviceId: result.deviceId,
			credential: result.credential,
			issuedAt: result.issuedAt,
			expiresAt: result.expiresAt,
		};
	}

	/**
	 * Put one frame to the authorization hook, in either direction.
	 *
	 * A hook that throws is a hook that could not answer, and the only safe
	 * reading of that is no: a policy failure that silently allowed the frame
	 * would be indistinguishable from no policy at all.
	 *
	 * @returns false when the frame was refused and this connection is closing.
	 */
	#allowed(request: AuthorizationRequest): boolean {
		const authorize = this.#authorize;
		if (authorize === null) return true;
		let verdict: AuthorizationVerdict;
		try {
			verdict = authorize(request);
		} catch {
			this.#refuse("not_authenticated", `${request.frame.type} could not be authorized`);
			return false;
		}
		if (verdict.allow) return true;
		this.#refuse(
			verdict.code ?? "not_authenticated",
			verdict.message ?? `${request.frame.type} is not permitted on this connection`,
		);
		return false;
	}

	/** The pre-auth window. Starts with the connection, dies with the credential. */
	#startAuthTimer(): void {
		const timer = setTimeout(() => {
			this.#authTimer = null;
			if (this.#closed || this.#authenticated) return;
			this.#refuse("not_authenticated", `no credential within ${this.#authDeadlineMs}ms`);
		}, this.#authDeadlineMs);
		// Like the drain poll: never the reason a daemon refuses to exit.
		timer.unref?.();
		this.#authTimer = timer;
	}

	#clearAuthTimer(): void {
		if (this.#authTimer === null) return;
		clearTimeout(this.#authTimer);
		this.#authTimer = null;
	}

	/**
	 * Dial the named session — but only once the fleet confirms it is live.
	 *
	 * The fleet check is not an optimisation: a `<id>.sock` left by a dead
	 * process still exists on disk, and connecting to one would hang a renderer
	 * on a session that can never answer.
	 */
	#attach(frame: AttachFrame): void {
		// The id becomes a path component. The liveness check below already
		// confines it to names `readdir` produced, which cannot contain a
		// separator — but the confinement is stated here too, so a later change to
		// how liveness is decided cannot quietly turn this into a path traversal.
		if (/[/\\]/.test(frame.sessionId) || frame.sessionId === "." || frame.sessionId === "..") {
			this.#refuse("unknown_session", `${JSON.stringify(frame.sessionId)} is not a session id`);
			return;
		}
		const live = listAttachableSessions(this.#socketDir).some((session) => session.id === frame.sessionId);
		if (!live) {
			this.#refuse("unknown_session", `no live attachable session ${JSON.stringify(frame.sessionId)}`);
			return;
		}
		// And the same restatement for ownership (R35-ALWAYS.3): both files this dial
		// depends on are re-`lstat`ed here, between the liveness answer and the
		// `connect()`, and must both belong to this uid. `listAttachableSessions` has
		// already applied that rule — this is the copy that survives a change to how
		// liveness is decided, in the one place where being wrong means handing another
		// uid's socket a read-write attachment.
		if (!sessionFilesAreOurs(this.#socketDir, frame.sessionId)) {
			this.#refuse("unknown_session", `no live attachable session ${JSON.stringify(frame.sessionId)}`);
			return;
		}

		const socket = connect(join(this.#socketDir, `${frame.sessionId}.sock`));
		this.#session = socket;
		this.#sessionId = frame.sessionId;
		// The one place a client id is taken from a frame. Every relay after this
		// uses the pinned copy — see `#clientId`.
		this.#clientId = frame.clientId;

		// `sessionId` is this wire's one declared addition to the socket wire's
		// attach: it names which socket to dial and does not travel down it.
		// `capabilities` is THIS BRIDGE's declaration, not the renderer's: it says
		// this process can decode and relay the geist/0.3 permission frames, which
		// is what makes the session willing to emit them at all. A bridge built
		// before 0.3 writes this line without the field, so a newer draht never
		// sends it a frame it would have to refuse — and never kills it with a
		// `protocol_error unknown_type` and close 1008.
		socket.write(
			`${JSON.stringify({ type: "attach", clientId: frame.clientId, mode: frame.mode, capabilities: [PERMISSION_RELAY_CAPABILITY] })}\n`,
		);

		socket.on("data", (chunk) => this.#onSessionData(chunk.toString()));
		socket.on("error", () => {
			if (this.#closed) return;
			this.#refuse("unknown_session", `session ${JSON.stringify(frame.sessionId)} is not accepting connections`);
		});
		// The fleet subscription is armed here and NOT at `hello`, because `attach`
		// is the only client frame carrying `capabilities` — see
		// `FLEET_DELTA_CAPABILITY`. Armed after the dial, so a connection refused
		// above never becomes a subscriber.
		//
		// SCOPE, stated here so a later reader does not widen it by accident:
		// R35-ALWAYS.10's "without reconnecting" is scoped to the FLEET LIST for
		// Phase 35. This bridge still allows one `attach` per connection and still
		// CLOSES the WebSocket on `detach` (see the `detach` case above). Making
		// `attach` re-callable is a second wire-semantics change and is out of
		// scope; what is in scope is that a connection learns the fleet moved
		// without dropping the socket, which is what the subscription below does.
		if (frame.capabilities?.includes(FLEET_DELTA_CAPABILITY) === true) this.#subscribeToFleet();

		socket.on("close", () => {
			if (this.#closed || this.#detached) return;
			// Not a protocol failure — the agent process ended. Say so on the
			// relayed error channel and close normally.
			this.#emit({ type: "error", message: "the session ended", code: "SESSION_ENDED" });
			this.#closed = true;
			this.#clearDrainTimer();
			this.#unsubscribe();
			this.#conn.close(CLOSE_GOING_AWAY, "session_ended");
		});
	}

	/** Newline-framed socket wire in; validated geist frames out. */
	#onSessionData(chunk: string): void {
		if (this.#closed) return;
		this.#sessionBuffer += chunk;
		const lines = this.#sessionBuffer.split("\n");
		this.#sessionBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			if (this.#closed) return;
			const decoded = decodeServerFrame(line, this.#sessionLimits);
			if (!decoded.ok) {
				// The socket wire produced something this protocol does not declare.
				// Refusing here is the point: drift surfaces at the bridge rather
				// than being relayed onward as an undeclared shape. Size is not
				// drift — see `#sessionLimits`.
				this.#refuse(decoded.code, `socket wire: ${decoded.message}`);
				return;
			}
			for (const frame of this.#fit(decoded.frame)) {
				if (this.#closed) return;
				this.#emit(frame);
			}
		}
	}

	/**
	 * Split one relayed frame into frames that each fit `maxFrameBytes`.
	 *
	 * `output` is the only frame a session can legitimately make oversized — one
	 * tool result is one socket-wire line however long it is — and its `data` is
	 * a stream, so a renderer that appends the pieces sees exactly the bytes the
	 * session wrote. Every other frame is small by construction and passes
	 * through untouched.
	 */
	#fit(frame: GeistServerFrame): GeistServerFrame[] {
		const cap = this.#limits.maxFrameBytes;
		if (frame.type !== "output" || Buffer.byteLength(encodeFrame(frame)) <= cap) {
			// A permission ask is small BY CONSTRUCTION — every free-text field is built
			// through `boundedSafeText`, which bounds graphemes AND UTF-8 bytes, and the
			// sum of those bounds is well under this cap (the arithmetic is written out
			// over MAX_FIELD_BYTES in coding-agent's `safe-text.ts`). Note the bound is
			// enforced at CONSTRUCTION, not by a `.max()` in the wire schema: `safeText`
			// there is a single grapheme-counting regex check, because a code-unit
			// `.max()` refused strings the producer considered valid. If a frame ever is
			// not, it is REFUSED rather than split: half an ask is a dialog showing
			// half a command with an Approve button under it, which is worse than no
			// dialog at all. The refusal drops only this connection.
			if (PERMISSION_FRAME_TYPES.has(frame.type) && Buffer.byteLength(encodeFrame(frame)) > cap) {
				this.#refuse("frame_too_large", `a ${frame.type} frame must be small by construction; this one is not`);
				return [];
			}
			return [frame];
		}

		// Everything but `data`, so the first guess at a slice length is the one
		// that would be exact for ASCII rather than a binary search from the top.
		const overhead = Buffer.byteLength(encodeFrame({ ...frame, data: "" }));
		const budget = Math.max(1, cap - overhead);
		const parts: GeistServerFrame[] = [];
		let rest = frame.data;
		while (rest.length > 0) {
			// A JSON string never encodes to fewer bytes than it has characters, so
			// no slice longer than `budget` can fit; from there halve until it does.
			// `take > 1` keeps this making progress even for a cap so small that a
			// single escaped character does not fit.
			let take = Math.min(rest.length, budget);
			while (take > 1 && Buffer.byteLength(encodeFrame({ ...frame, data: rest.slice(0, take) })) > cap) {
				take = Math.ceil(take / 2);
			}
			parts.push({ ...frame, data: rest.slice(0, take) });
			rest = rest.slice(take);
		}
		return parts;
	}

	/**
	 * The only way a frame leaves this bridge: bounded, validated, encoded.
	 *
	 * Both caps are checked before the send, so an overflow costs the renderer
	 * one refusal frame rather than the backlog that caused it.
	 */
	#emit(frame: GeistServerFrame): void {
		if (this.#closed) return;
		// Asked before the frame is encoded, let alone sent: a frame this
		// connection may not see must not exist on its wire, and a client that is
		// refused mid-stream is told so rather than left holding a transcript with
		// a hole in it. `protocol_error` does not come through here — a refusal
		// has to reach the client even when the policy that caused it says no.
		if (!this.#allowed({ direction: "outbound", frame, identity: this.#identity, sessionId: this.#sessionId }))
			return;
		const text = encodeFrame(ServerFrameSchema.parse(frame));
		const buffered = this.#conn.bufferedBytes();

		if (buffered === 0) {
			this.#queuedFrames = 0;
		} else {
			if (buffered + Buffer.byteLength(text) > this.#limits.maxBufferedOutputBytes) {
				this.#refuse(
					"buffered_output_overflow",
					`buffered output would pass ${this.#limits.maxBufferedOutputBytes} bytes`,
				);
				return;
			}
			this.#queuedFrames += 1;
			if (this.#queuedFrames > this.#limits.maxOutboundFrames) {
				this.#refuse(
					"outbound_queue_overflow",
					`more than ${this.#limits.maxOutboundFrames} frames are queued for this client`,
				);
				return;
			}
		}

		this.#conn.send(text);
		this.#applyBackpressure();
	}

	/**
	 * Relay one line to the session, bounded.
	 *
	 * The other half of R32-FLEET.6's two-way backpressure. When the *session*
	 * is the slow end — a draht process not draining its socket — node would
	 * grow an unbounded write buffer on this client's behalf. It does not get to:
	 * the same two caps that bound the renderer's backlog bound this one, and a
	 * client that passes them is disconnected with the same typed code.
	 *
	 * A WebSocket gives its host no way to stop the peer sending, so a refusal is
	 * the only bound available in this direction; the session direction, which
	 * does have flow control, is paused instead of dropped
	 * ({@link AttachBridge.#applyBackpressure}). How far behind the session is
	 * comes from {@link AttachBridgeOptions.backlogBytes} — see its note on what
	 * a host that reports nothing means for this bound.
	 *
	 * @returns false when the frame was refused and this connection is closing.
	 */
	#writeSession(session: Socket, line: string): boolean {
		const pending = this.#backlogBytes(session);
		if (pending === 0) {
			this.#queuedSessionFrames = 0;
		} else {
			if (pending + Buffer.byteLength(line) > this.#limits.maxBufferedOutputBytes) {
				this.#refuse(
					"buffered_output_overflow",
					`the session has not drained ${pending} buffered bytes; cap is ${this.#limits.maxBufferedOutputBytes}`,
				);
				return false;
			}
			this.#queuedSessionFrames += 1;
			if (this.#queuedSessionFrames > this.#limits.maxOutboundFrames) {
				this.#refuse(
					"outbound_queue_overflow",
					`more than ${this.#limits.maxOutboundFrames} frames are queued for the session`,
				);
				return false;
			}
		}
		session.write(line);
		return true;
	}

	/**
	 * Backpressure toward the session.
	 *
	 * A renderer that is falling behind stops the session's socket rather than
	 * growing a buffer on its behalf — the queue cap above is the last resort,
	 * not the first line of defence. The session resumes as soon as the renderer
	 * has drained past the low-water mark.
	 */
	#applyBackpressure(): void {
		const session = this.#session;
		if (!session) return;
		const highWater = Math.max(1, Math.floor(this.#limits.maxBufferedOutputBytes / 2));
		if (!this.#paused && this.#conn.bufferedBytes() >= highWater) {
			this.#paused = true;
			session.pause();
			this.#scheduleDrainCheck();
		}
	}

	#scheduleDrainCheck(): void {
		if (this.#drainTimer !== null) return;
		const timer = setTimeout(() => {
			this.#drainTimer = null;
			if (this.#closed || !this.#paused) return;
			const lowWater = Math.max(1, Math.floor(this.#limits.maxBufferedOutputBytes / 4));
			if (this.#conn.bufferedBytes() <= lowWater) {
				this.#paused = false;
				this.#session?.resume();
				return;
			}
			this.#scheduleDrainCheck();
		}, this.#drainCheckMs);
		// A drain poll must never be the reason a daemon refuses to exit.
		timer.unref?.();
		this.#drainTimer = timer;
	}

	#clearDrainTimer(): void {
		if (this.#drainTimer === null) return;
		clearTimeout(this.#drainTimer);
		this.#drainTimer = null;
	}

	/**
	 * Answer with a typed refusal and drop only this connection.
	 *
	 * The refusal itself bypasses the outbound caps: it is one small frame, and
	 * a client that overflowed has to be told why or it learns nothing from
	 * being disconnected.
	 */
	#refuse(code: ProtocolErrorCode, message: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearDrainTimer();
		this.#clearAuthTimer();
		this.#unsubscribe();
		try {
			this.#conn.send(encodeFrame(protocolError(code, message)));
		} catch {
			// The renderer is already gone — the close below is still correct.
		}
		this.#conn.close(CLOSE_POLICY_VIOLATION, code);
		const session = this.#session;
		this.#session = null;
		try {
			session?.end();
		} catch {
			// Nothing to unwind.
		}
	}
}
