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
 *      The dial happens only after `hello`, after `attach`, and after the named
 *      session is found live in the fleet. Authentication is the host's job and
 *      happens earlier still, on the upgrade request.
 *   3. **Every bound is per-connection.** An overflowing renderer is dropped
 *      alone; the session keeps streaming to everyone else.
 *   4. **Identity is the daemon's.** A relayed frame carries the client id this
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
	type GeistServerFrame,
	type ProtocolErrorCode,
	protocolError,
	ServerFrameSchema,
	type TransportLimits,
} from "@draht/geist-protocol";
import { buildFleetFrame, listAttachableSessions } from "./socket-sessions.js";

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

		if (!this.#greeted && frame.type !== "hello") {
			this.#refuse("handshake_required", `expected hello, got ${frame.type}`);
			return;
		}

		switch (frame.type) {
			case "hello": {
				if (this.#greeted) {
					this.#refuse("invalid_frame", "hello was already sent on this connection");
					return;
				}
				this.#greeted = true;
				this.#emit({
					type: "server_hello",
					protocol: GEIST_PROTOCOL_FAMILY,
					version: GEIST_PROTOCOL_VERSION,
					server: this.#server,
					limits: this.#limits,
				});
				this.#emit(buildFleetFrame(this.#socketDir));
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
			case "input":
			case "detach": {
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
				// what stops one client speaking — or detaching — as another.
				if (!this.#writeSession(session, `${encodeFrame({ ...frame, clientId })}\n`)) return;
				if (frame.type === "detach") {
					this.#detached = true;
					session.end();
					this.#session = null;
					this.#conn.close(CLOSE_NORMAL, "detached");
					this.#closed = true;
				}
				return;
			}
		}
	}

	/** The renderer went away. Release the session socket. */
	close(): void {
		this.#closed = true;
		this.#clearDrainTimer();
		const session = this.#session;
		this.#session = null;
		try {
			session?.end();
		} catch {
			// The session may already be gone; nothing to unwind.
		}
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

		const socket = connect(join(this.#socketDir, `${frame.sessionId}.sock`));
		this.#session = socket;
		this.#sessionId = frame.sessionId;
		// The one place a client id is taken from a frame. Every relay after this
		// uses the pinned copy — see `#clientId`.
		this.#clientId = frame.clientId;

		// `sessionId` is this wire's one declared addition to the socket wire's
		// attach: it names which socket to dial and does not travel down it.
		socket.write(`${JSON.stringify({ type: "attach", clientId: frame.clientId, mode: frame.mode })}\n`);

		socket.on("data", (chunk) => this.#onSessionData(chunk.toString()));
		socket.on("error", () => {
			if (this.#closed) return;
			this.#refuse("unknown_session", `session ${JSON.stringify(frame.sessionId)} is not accepting connections`);
		});
		socket.on("close", () => {
			if (this.#closed || this.#detached) return;
			// Not a protocol failure — the agent process ended. Say so on the
			// relayed error channel and close normally.
			this.#emit({ type: "error", message: "the session ended", code: "SESSION_ENDED" });
			this.#closed = true;
			this.#clearDrainTimer();
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
		if (frame.type !== "output" || Buffer.byteLength(encodeFrame(frame)) <= cap) return [frame];

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
