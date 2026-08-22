/**
 * The geist attach daemon the conformance corpus is recorded from
 * (R32-FLEET.4, R32-FLEET.5).
 *
 * It is a real daemon: it binds a real loopback listener, upgrades real
 * WebSockets behind real bearer auth, dials the real `<id>.sock` of a real
 * draht session, and relays the socket wire in both directions. Every byte the
 * corpus contains came out of this process over that transport — nothing in
 * `packages/geist-protocol/conformance/` is typed by hand.
 *
 * Two properties this file exists to guarantee, both of which
 * `scripts/check-geist-protocol.mjs` re-proves on every run:
 *
 *   1. Nothing becomes a frame except through `decodeClientFrame`. Bytes that
 *      no exported schema validates are answered with a typed `protocol_error`
 *      and the connection is closed — before any Unix socket is opened, and
 *      without touching any other client.
 *   2. Nothing leaves except through `ServerFrameSchema`. Relayed socket-wire
 *      lines are re-validated and re-encoded rather than forwarded blind, so a
 *      drift on the socket side surfaces here instead of on a phone.
 *
 * It imports `@draht/geist-protocol` and node builtins and nothing else — no
 * `@draht/coding-agent`, no kernel — so the bridge that replaces it in
 * `packages/geist-core` can be a like-for-like swap under
 * `check-geist-boundary.mjs` (R32-FLEET.1).
 *
 * Since `geist/0.2` it also implements the device-credential exchange
 * (R33-REACH.5), which is what lets the corpus hold RECORDED `pair_device`,
 * `authenticate` and `device_credential` goldens rather than authored ones:
 *
 *   - `pair_device` spends a single-use bootstrap token and is answered with a
 *     `device_credential` bound to a device id the daemon assigns. The token is
 *     invalidated at exchange, so a replay is refused with `not_authenticated`
 *     on the replaying connection only — the device bound by the first exchange
 *     keeps its credential and its stream (R33-REACH.7).
 *   - `authenticate` presents an already-issued credential and is answered with
 *     a `device_credential` carrying a ROTATED value; the presented one dies at
 *     that moment, so an observed credential is worth nothing on the next
 *     connect (R33-REACH.5).
 *   - nothing about the fleet, and no `attach`, is reachable before the exchange
 *     completes: `fleet` is sent only after a credential is issued, and an
 *     `attach` on an unauthenticated connection is refused `not_authenticated`.
 *
 * Since `geist/0.3` it also relays the permission arm (R34-PERM.1): the attach
 * line it writes to the session declares the `permission-relay` capability, and
 * `permission_response` is relayed to the session exactly as `input` is.
 *
 * Since `geist/0.4` it speaks the fleet-projection half (R35-ALWAYS.7,
 * R35-ALWAYS.8, R35-ALWAYS.10) and it is worth being precise about which parts of
 * that are REAL here and which are MODELLED, because the corpus freezes whatever
 * this process actually emits:
 *
 *   - REAL. `origin: "socket"`, `attachable: true`, `resumable: false`, `pid`,
 *     `cwd` and `startedAt` for a live row still come straight off the
 *     `<id>.sock` + `.lock` contract, read from disk on every projection, dead
 *     pids skipped. `resumable: false` on a live row is the SHIPPED projection's
 *     answer, mirrored here on purpose — see `discoverSessions()`.
 *   - REAL. `fleet_delta`. This daemon keeps the last fleet it projected and, on
 *     a `rescan`, DIFFS the new projection against it. The `appeared` and
 *     `disappeared` frames in the corpus are what really happened to real sockets
 *     in a real directory — the recorder starts and stops a second session to
 *     make them happen. It never fabricates a change.
 *   - REAL. `fleet_resync`, and its answer: a fresh projection with the current
 *     `epoch` and the next `seq`.
 *   - MODELLED. The `origin: "history"` row. History lives in a session-file
 *     index this process deliberately does not have (it imports no
 *     `@draht/coding-agent`), so ONE fixed synthetic row is projected alongside
 *     the real sockets, purely so the corpus freezes the shape of a history row —
 *     `pid` absent, `attachable: false`, `resumable: true`. Fixed, for the same
 *     reason the socket daemon's permission ask is fixed: a recorder fixture has
 *     no business being non-deterministic.
 *   - MODELLED. `status`. There is no git probe here; the deadline-bounded
 *     quad-state probe is the shipped daemon's. A live row is therefore reported
 *     `status: "unknown", statusAt: null` — the honest answer for "never
 *     observed", and the one value that is safe to be wrong about, since
 *     `unknown` is never actionable. It must never be `clean`.
 *   - MODELLED. `session_resume`. This process has no spawn surface at all, by
 *     design — it imports node builtins and `@draht/geist-protocol` and nothing
 *     else. It resolves the id honestly (`already_live` for a live socket,
 *     `not_found` for an id it has never heard of) and answers `refused` for a
 *     history id it could otherwise have started, saying so in the message. The
 *     `resumed` path belongs to the shipped daemon and to its Class-3 acceptance.
 *
 * `epoch` is a fixed literal here. In a shipped daemon it is the observer run's
 * identity and changes whenever continuity is lost; in a recording there is one
 * run and the goldens compare byte-wise.
 *
 * No credential is ever written to stdout, stderr or a URL (R33-REACH.3): it
 * crosses this wire as a first message and nowhere else.
 *
 * Readiness is one newline-JSON line on stdout: {"ready":true,"port":N}
 *
 * Usage: bun scripts/geist-conformance/reference-daemon.mjs --socket-dir <dir> --token <bearer> --bootstrap <t1,t2,…>
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
	DEFAULT_TRANSPORT_LIMITS,
	decodeClientFrame,
	decodeServerFrame,
	encodeFrame,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	protocolError,
	ServerFrameSchema,
} from "../../packages/geist-protocol/src/index.js";

const DAEMON_NAME = "geist-reference-daemon";
const DAEMON_VERSION = "0.1.0";
/** How long an issued device credential is good for. Short on purpose. */
const CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined) {
		if (fallback !== undefined) return fallback;
		throw new Error(`missing required --${name}`);
	}
	return value;
}

const socketDir = arg("socket-dir");
const token = arg("token");
const limits = DEFAULT_TRANSPORT_LIMITS;

/**
 * What this daemon is willing to be ASKED, advertised in `server_hello`
 * (geist/0.4). The renderer-side counterpart of `attach.capabilities`: it says a
 * frame will be understood, never that anyone has earned anything.
 */
const DAEMON_CAPABILITIES = ["fleet-delta", "fleet-resync", "session-resume"];

/**
 * This observer run's identity. Fixed, because the corpus compares byte-wise and
 * there is exactly one run per recording. A shipped daemon mints a fresh one
 * whenever it loses continuity, which is what tells a renderer to discard.
 */
const FLEET_EPOCH = "conformance-epoch";

/**
 * The one MODELLED history row — see the header. `pid` is absent because there is
 * no process, `attachable` is false because nothing is listening, and `resumable`
 * is true because a session file is what resume needs. Its `status` is fixed too,
 * so the corpus freezes a non-null `statusAt` alongside the live row's null one.
 */
const HISTORY_SESSIONS = [
	{
		id: "conformance-history",
		cwd: "/geist/conformance/archived",
		startedAt: "1970-01-01T00:00:00.000Z",
		origin: "history",
		attachable: false,
		resumable: true,
		status: "no_repo",
		statusAt: "1970-01-01T00:00:00.000Z",
	},
];

/** Monotonic within `FLEET_EPOCH`. Every `fleet` and every `fleet_delta` takes the next one. */
let fleetSeq = 0;

/** Connections that have completed the device exchange, so a broadcast has somewhere to go. */
const readyConnections = new Set();

/** The last projection this daemon emitted, keyed by id — the basis every delta is diffed against. */
let lastProjection = new Map();

/**
 * The single-use bootstrap tokens this daemon will honour, spent on first use.
 * A `Set` rather than a list because "spent" is a deletion: the second `pair_device`
 * presenting the same bytes finds nothing and is refused.
 */
const bootstrapTokens = new Set(
	arg("bootstrap", "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean),
);

/** deviceId → the one credential currently valid for it. Rotated on every issue. */
const devices = new Map();

/** Constant-time compare, so a wrong credential leaks nothing through timing. */
function credentialMatches(presented, stored) {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(stored, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The device id is derived from the name the device gave itself, not claimed by
 * the renderer: a `pair_device` cannot name the device id it wants to become, so it
 * cannot aim at one another device already holds.
 */
function deviceIdFor(name) {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return `device-${slug || "unnamed"}`;
}

/**
 * Issue — or rotate — the credential for a device and return the frame that
 * carries it. The previous value is overwritten here, which is what makes an
 * observed credential worthless after the next exchange.
 */
function issueCredential(deviceId, device) {
	const issuedAt = new Date();
	const record = {
		credential: randomBytes(32).toString("base64url"),
		name: device?.name ?? devices.get(deviceId)?.name,
		platform: device?.platform ?? devices.get(deviceId)?.platform,
	};
	devices.set(deviceId, record);
	return {
		type: "device_credential",
		deviceId,
		credential: record.credential,
		issuedAt: issuedAt.toISOString(),
		expiresAt: new Date(issuedAt.getTime() + CREDENTIAL_TTL_MS).toISOString(),
	};
}

/**
 * Live rows, straight off the `<id>.sock` + `.lock` contract: pid on line 1, cwd
 * on line 2, ISO creation time on line 3. A lock naming a dead pid is skipped, so
 * a session whose draht process is gone never reaches a renderer.
 *
 * `attachable` is true for every row this returns and that is not decoration: the
 * whole of what this function does is establish that a socket exists and a live
 * process is behind it.
 *
 * `resumable` is FALSE for a live row, and this daemon says so because the shipped
 * projection (`geist-core/src/attach/socket-sessions.ts`) says so and the corpus is
 * the frozen record of what the wire IS — the two disagreed, and a corpus that
 * disagrees with what ships is worse than no corpus. `resumable` and `attachable`
 * are the two VERBS a renderer may offer, and for a live session the verb is
 * ATTACH: offering "Resume" invites an action that would put a second process
 * appending to one session JSONL, which is the hazard the busy lock exists for. A
 * `session_resume` on a live id is still refused `already_live` below — defence in
 * depth — but no renderer should be led to send one. They remain two carried
 * fields rather than one derived from the other because a history row inverts
 * them, and nothing here reads a session file to find out.
 *
 * `status` is `unknown` with a null `statusAt` because this daemon never probes;
 * see the header. `unknown` is the safe wrong answer, `clean` would not be.
 */
function discoverSessions() {
	if (!existsSync(socketDir)) return [];
	const sessions = [];
	for (const entry of readdirSync(socketDir).sort()) {
		if (!entry.endsWith(".sock")) continue;
		const id = entry.slice(0, -".sock".length);
		const lockPath = join(socketDir, `${id}.lock`);
		if (!existsSync(lockPath)) continue;
		try {
			if (!statSync(join(socketDir, entry)).isSocket()) continue;
			const [pidLine, cwd, createdAt] = readFileSync(lockPath, "utf8").trim().split("\n");
			const pid = Number.parseInt(pidLine, 10);
			if (!Number.isInteger(pid) || pid <= 0) continue;
			process.kill(pid, 0);
			sessions.push({
				id,
				cwd,
				pid,
				startedAt: createdAt,
				origin: "socket",
				attachable: true,
				resumable: false,
				status: "unknown",
				statusAt: null,
			});
		} catch {
			// Unreadable lock or dead pid — the session is not attachable, so it is not fleet.
		}
	}
	return sessions;
}

/**
 * The whole fleet: live sockets plus the modelled history rows, minus any history
 * row whose id is live right now. A session that is BOTH on disk and listening is
 * one row, and it is the socket one — `origin` is what the fleet can observe, and
 * observing a live socket beats observing a file.
 *
 * Sorted by id so two projections of the same world are the same list.
 */
function projectFleet() {
	const live = discoverSessions();
	const liveIds = new Set(live.map((session) => session.id));
	const history = HISTORY_SESSIONS.filter((session) => !liveIds.has(session.id));
	return [...live, ...history].sort((a, b) => a.id.localeCompare(b.id));
}

/** The projection as a map, so two of them can be diffed by id. */
function projectionMap(sessions) {
	return new Map(sessions.map((session) => [session.id, session]));
}

/**
 * A `fleet` snapshot, and the projection it describes becomes the new diff basis.
 * Taking the next `seq` here rather than at the call site is what keeps a snapshot
 * and the deltas around it on one order.
 */
function buildFleetFrame() {
	const sessions = projectFleet();
	lastProjection = projectionMap(sessions);
	return { type: "fleet", sessions, epoch: FLEET_EPOCH, seq: fleetSeq++ };
}

/**
 * Re-project, diff against the last projection, and return a `fleet_delta` — or
 * undefined when nothing moved. NOTHING IS FABRICATED: every change here is a
 * difference between two reads of a real directory.
 *
 * `appeared` and `changed` carry the FULL session body. A renderer must replace
 * the row it holds rather than merge into it: a resumed session reuses its id with
 * a new pid, so merging keeps the dead one.
 */
function buildFleetDelta() {
	const before = lastProjection;
	const sessions = projectFleet();
	const after = projectionMap(sessions);
	const changes = [];
	for (const [id, session] of after) {
		const previous = before.get(id);
		if (previous === undefined) changes.push({ kind: "appeared", session });
		else if (JSON.stringify(previous) !== JSON.stringify(session)) changes.push({ kind: "changed", session });
	}
	for (const id of before.keys()) {
		if (!after.has(id)) changes.push({ kind: "disappeared", id });
	}
	lastProjection = after;
	if (changes.length === 0) return undefined;
	return { type: "fleet_delta", epoch: FLEET_EPOCH, seq: fleetSeq++, changes };
}

/**
 * Answer one `session_resume` — see the header for why this daemon never answers
 * `resumed`. The id is resolved against what it can actually see, so
 * `already_live` and `not_found` are real verdicts, not stubs.
 */
function resolveResume(sessionId) {
	if (discoverSessions().some((session) => session.id === sessionId)) {
		return {
			ok: false,
			code: "already_live",
			message: "that session is already listening on a socket — attach to it instead of resuming it",
		};
	}
	if (HISTORY_SESSIONS.some((session) => session.id === sessionId)) {
		return {
			ok: false,
			code: "refused",
			message: "the reference daemon has no spawn surface by design; the shipped daemon starts the process",
		};
	}
	return { ok: false, code: "not_found", message: "no session with that id is known to this daemon" };
}

/** The only way a frame leaves this daemon: validated, then encoded. */
function send(ws, frame) {
	if (ws.readyState !== 1) return;
	if (ws.getBufferedAmount?.() > limits.maxBufferedOutputBytes) {
		const overflow = protocolError("buffered_output_overflow", `buffered output exceeded ${limits.maxBufferedOutputBytes} bytes`);
		ws.send(encodeFrame(ServerFrameSchema.parse(overflow)));
		ws.close(1008, "buffered_output_overflow");
		return;
	}
	ws.send(encodeFrame(ServerFrameSchema.parse(frame)));
}

/** Answer with a typed refusal and drop only this connection. */
function refuse(ws, code, message) {
	send(ws, protocolError(code, message));
	ws.close(1008, code);
}

function openUpstream(state, ws, frame) {
	const socketPath = join(socketDir, `${frame.sessionId}.sock`);
	if (!discoverSessions().some((session) => session.id === frame.sessionId)) {
		refuse(ws, "unknown_session", `no live attachable session ${JSON.stringify(frame.sessionId)}`);
		return;
	}

	const upstream = connect(socketPath);
	state.upstream = upstream;
	state.upstreamBuffer = "";
	upstream.on("connect", () => {
		// `sessionId` is this wire's one declared addition to the socket wire's
		// `attach`; it names which socket to dial and does not travel down it.
		//
		// The capability is the BRIDGE's, not the renderer's: this process can
		// decode and relay permission frames, so it says so. A daemon built before
		// geist/0.3 writes this line without `capabilities` and the session
		// therefore never sends it a frame it would have to refuse.
		upstream.write(
			`${JSON.stringify({ type: "attach", clientId: frame.clientId, mode: frame.mode, capabilities: ["permission-relay"] })}\n`,
		);
	});
	upstream.on("data", (chunk) => {
		state.upstreamBuffer += chunk.toString();
		const lines = state.upstreamBuffer.split("\n");
		state.upstreamBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const decoded = decodeServerFrame(line, limits);
			if (!decoded.ok) {
				// The socket wire produced something this protocol does not declare.
				// Refusing here is the point: it surfaces socket-side drift at the
				// bridge instead of relaying an undeclared shape onward.
				refuse(ws, decoded.code, `socket wire: ${decoded.message}`);
				return;
			}
			send(ws, decoded.frame);
		}
	});
	upstream.on("error", () => {
		refuse(ws, "unknown_session", `socket for ${JSON.stringify(frame.sessionId)} is not accepting connections`);
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(arg("port", "0")),
	fetch(request, bunServer) {
		const url = new URL(request.url);
		// Auth is checked on the upgrade request, before any Unix socket exists
		// for this connection to reach (R32-FLEET.3).
		if (request.headers.get("authorization") !== `Bearer ${token}`) {
			return new Response("unauthorized", { status: 401 });
		}
		if (url.pathname !== "/attach") return new Response("not found", { status: 404 });
		if (bunServer.upgrade(request, { data: { state: { phase: "awaiting_hello", deviceId: null, upstream: null, upstreamBuffer: "" } } })) {
			return undefined;
		}
		return new Response("expected websocket upgrade", { status: 426 });
	},
	websocket: {
		message(ws, raw) {
			const state = ws.data.state;
			const decoded = decodeClientFrame(typeof raw === "string" ? raw : raw.toString(), limits);
			if (!decoded.ok) {
				refuse(ws, decoded.code, decoded.message);
				return;
			}
			const frame = decoded.frame;

			if (state.phase === "awaiting_hello" && frame.type !== "hello") {
				refuse(ws, "handshake_required", `expected hello, got ${frame.type}`);
				return;
			}

			// A device that has gone away between two frames of the same connection
			// is refused at THIS frame, not merely at its next connect (R33-REACH.6).
			if (state.deviceId && !devices.has(state.deviceId)) {
				refuse(ws, "not_authenticated", "this device is no longer authorized");
				return;
			}

			switch (frame.type) {
				case "hello": {
					state.phase = "awaiting_credential";
					send(ws, {
						type: "server_hello",
						protocol: GEIST_PROTOCOL_FAMILY,
						version: GEIST_PROTOCOL_VERSION,
						server: { name: DAEMON_NAME, version: DAEMON_VERSION },
						limits,
						capabilities: DAEMON_CAPABILITIES,
					});
					// No `fleet` yet: nothing about the fleet reaches a socket that has
					// not completed the device exchange.
					return;
				}
				case "pair_device": {
					if (state.deviceId) {
						refuse(ws, "invalid_frame", "this connection has already completed the device exchange");
						return;
					}
					// Spend-on-use. `delete` returning false is both "never issued" and
					// "already spent" — the replaying connection learns nothing about
					// which, and the device bound by the first exchange is untouched.
					if (!bootstrapTokens.delete(frame.bootstrapToken)) {
						refuse(ws, "not_authenticated", "bootstrap token is not valid");
						return;
					}
					const issued = issueCredential(deviceIdFor(frame.device.name), frame.device);
					state.deviceId = issued.deviceId;
					state.phase = "ready";
					readyConnections.add(ws);
					send(ws, issued);
					send(ws, buildFleetFrame());
					return;
				}
				case "authenticate": {
					if (state.deviceId) {
						refuse(ws, "invalid_frame", "this connection has already completed the device exchange");
						return;
					}
					const record = devices.get(frame.deviceId);
					if (!record || !credentialMatches(frame.credential, record.credential)) {
						refuse(ws, "not_authenticated", "device credential is not valid");
						return;
					}
					const issued = issueCredential(frame.deviceId, record);
					state.deviceId = issued.deviceId;
					state.phase = "ready";
					readyConnections.add(ws);
					send(ws, issued);
					send(ws, buildFleetFrame());
					return;
				}
				case "attach": {
					if (!state.deviceId) {
						refuse(ws, "not_authenticated", "attach before the device exchange");
						return;
					}
					if (state.upstream) {
						refuse(ws, "invalid_frame", "this connection is already attached");
						return;
					}
					openUpstream(state, ws, frame);
					return;
				}
				case "fleet_resync": {
					// A distinct post-authentication verb, and it has to be one: a repeated
					// `hello` is refused `invalid_frame` and an undeclared type is refused
					// `unknown_type`, and both close the connection a resync exists to save.
					if (!state.deviceId) {
						refuse(ws, "not_authenticated", "fleet_resync before the device exchange");
						return;
					}
					send(ws, buildFleetFrame());
					return;
				}
				case "session_resume": {
					if (!state.deviceId) {
						refuse(ws, "not_authenticated", "session_resume before the device exchange");
						return;
					}
					// An id and nothing else crossed the wire, so an id and nothing else is
					// resolved: there is no path, argv or environment here to honour.
					const outcome = resolveResume(frame.sessionId);
					send(ws, { type: "session_resumed", sessionId: frame.sessionId, ...outcome });
					return;
				}
				case "input":
				case "detach":
				case "permission_response": {
					if (!state.deviceId) {
						refuse(ws, "not_authenticated", `${frame.type} before the device exchange`);
						return;
					}
					if (!state.upstream) {
						refuse(ws, "invalid_frame", `${frame.type} before attach`);
						return;
					}
					// Exact mirrors of the socket wire — relayed verbatim after validation.
					state.upstream.write(`${encodeFrame(frame)}\n`);
					if (frame.type === "detach") {
						state.upstream.end();
						state.upstream = null;
					}
					return;
				}
			}
		},
		close(ws) {
			readyConnections.delete(ws);
			const upstream = ws.data.state.upstream;
			ws.data.state.upstream = null;
			try {
				upstream?.end();
			} catch {
				// The session may already be gone; nothing to unwind.
			}
		},
	},
});

process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	if (chunk.includes("stop")) {
		server.stop(true);
		process.exit(0);
	}
	// `rescan` is the recorder asking this daemon to observe again. A shipped
	// daemon runs this off its own poll; driving it from stdin is what makes the
	// recording ordered rather than a race between a timer and a script. The DIFF
	// is real either way — if nothing moved on disk, nothing is sent.
	if (chunk.includes("rescan")) {
		const delta = buildFleetDelta();
		if (delta) {
			for (const ws of readyConnections) send(ws, delta);
		}
	}
});
