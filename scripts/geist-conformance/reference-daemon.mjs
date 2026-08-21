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
 * Fleet projection straight off the `<id>.sock` + `.lock` contract: pid on line
 * 1, cwd on line 2, ISO creation time on line 3. A lock naming a dead pid is
 * skipped, so a session whose draht process is gone never reaches a renderer.
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
			sessions.push({ id, cwd, pid, startedAt: createdAt });
		} catch {
			// Unreadable lock or dead pid — the session is not attachable, so it is not fleet.
		}
	}
	return sessions;
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
					send(ws, issued);
					send(ws, { type: "fleet", sessions: discoverSessions() });
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
					send(ws, issued);
					send(ws, { type: "fleet", sessions: discoverSessions() });
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
});
