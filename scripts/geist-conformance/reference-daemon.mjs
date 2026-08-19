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
 * Readiness is one newline-JSON line on stdout: {"ready":true,"port":N}
 *
 * Usage: bun scripts/geist-conformance/reference-daemon.mjs --socket-dir <dir> --token <bearer>
 */

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
		upstream.write(`${JSON.stringify({ type: "attach", clientId: frame.clientId, mode: frame.mode })}\n`);
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
		if (bunServer.upgrade(request, { data: { state: { phase: "awaiting_hello", upstream: null, upstreamBuffer: "" } } })) {
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

			switch (frame.type) {
				case "hello": {
					state.phase = "ready";
					send(ws, {
						type: "server_hello",
						protocol: GEIST_PROTOCOL_FAMILY,
						version: GEIST_PROTOCOL_VERSION,
						server: { name: DAEMON_NAME, version: DAEMON_VERSION },
						limits,
					});
					send(ws, { type: "fleet", sessions: discoverSessions() });
					return;
				}
				case "attach": {
					if (state.upstream) {
						refuse(ws, "invalid_frame", "this connection is already attached");
						return;
					}
					openUpstream(state, ws, frame);
					return;
				}
				case "input":
				case "detach": {
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
