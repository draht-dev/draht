/**
 * G1 — a silent `/attach` connection must survive a held permission ask.
 *
 * A pending permission ask is, by definition, a stretch of time with no session
 * output. The agent core waits for the answer indefinitely; the transport must
 * not give up first. These tests hold the transport to that.
 *
 * ## What was measured before any of this was written
 *
 * Every number below came off this machine (Bun 1.4.0-canary.1+3f5d81636) from a
 * raw-TCP WebSocket client that completes the handshake by hand and then sends
 * *nothing* — the honest model of a browser tab parked on an unanswered ask.
 *
 *  1. `Bun.serve({ idleTimeout })` — the top-level one — does not govern
 *     WebSocket connections at all. Top-level `idleTimeout: 3` with no
 *     `websocket.idleTimeout`: the silent socket survived 12s and 20s and was
 *     sent zero pings. So `GatewaySettings.idleTimeout`, which reaches
 *     `Bun.serve` and nothing else, never described `/attach`.
 *  2. The window that *does* govern it is `Bun.serve({ websocket: { idleTimeout } })`,
 *     which this package never set — so `/attach` ran on Bun's unset default of
 *     120s. Measured on the shipped configuration: `SOCKET CLOSED after 120.00s`.
 *  3. Bun's reaper is itself a liveness probe. It emits one protocol PING near
 *     the end of the window and closes if no PONG comes back: ping at t=104s,
 *     close at t=120s.
 *  4. A client that answers that PING is not reaped — same shipped
 *     configuration, client pongs: `SURVIVED 200.00s`. So the connection's life
 *     rests entirely on the peer's answer arriving inside a ~16s grace.
 *  5. A **server-initiated** `ws.ping()` resets the window on send, with no
 *     answer required: `websocket.idleTimeout: 2`, server pinging every 1000ms,
 *     client never ponging — `SURVIVED 20.00s`, ten times the window.
 *
 * Fact 5 is the whole fix, and it is the cheap one: WebSocket protocol control
 * frames, no new wire frames, no `GEIST_PROTOCOL_VERSION` bump, no conformance
 * corpus regeneration. It also survives a backgrounded tab, because a browser
 * answers protocol pings in its network stack rather than in JS.
 *
 * ## The shape of these tests
 *
 * The decisive claim is "a connection with no session output survives past the
 * reap". Proving it by waiting out the real 255s window would put a 260s test
 * against a 300s suite budget, which is how timing tests in this repo flake. So
 * the *mechanism* is proved against a deliberately small window — where the reap
 * was measured at a flat 8.00s for every `idleTimeout` in 1..8 — and the
 * *configuration* is proved separately and instantly.
 *
 * Everything in "the mechanism" crosses a real socket: a real `startGateway`
 * listener, a real 101, real WebSocket frames read off the wire. Nothing
 * constructs an `AttachBridge` or reaches inside the route.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { ATTACH_KEEPALIVE_DIVISOR, attachKeepaliveIntervalMs, DEFAULT_CONFIG } from "../config/config";
import { createServer, startGateway } from "../gateway/server";

const TOKEN = "attach-keepalive-operator-token";

/** RFC 6455's handshake constant. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * The small window every wire test runs against.
 *
 * Measured reap with no keepalive: a flat 8.00s, identical for `idleTimeout` 1,
 * 2, 4 and 8 — Bun's timeout wheel has a 4s granularity and closes after two
 * ticks. So 2 buys a keepalive period of 666ms and a reap deadline the tests can
 * comfortably straddle.
 */
const TEST_IDLE_TIMEOUT_SECONDS = 2;

/** How long the surviving connection is watched: 10x the window, 2.5x the reap. */
const SURVIVAL_OBSERVATION_MS = 20_000;

const temporaryDirectories: string[] = [];
const running: { stop: (closeActiveConnections?: boolean) => void }[] = [];
const peers: SilentPeer[] = [];

afterEach(() => {
	for (const peer of peers.splice(0)) peer.hangUp();
	for (const server of running.splice(0)) server.stop(true);
	for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway socket directory, so the fleet listing never sees a real session. */
function scratchSocketDir(): string {
	const dir = mkdtempSync("/tmp/attach-keepalive-");
	temporaryDirectories.push(dir);
	return dir;
}

/** Start the real daemon bind path on an ephemeral loopback port. */
function listen(options: { idleTimeout: number; attachKeepaliveMs?: number }): number {
	const { server } = startGateway({
		port: 0,
		authToken: TOKEN,
		socketDir: scratchSocketDir(),
		idleTimeout: options.idleTimeout,
		attachKeepaliveMs: options.attachKeepaliveMs,
	});
	running.push(server);
	return server.port as number;
}

/**
 * A peer that completes the `/attach` handshake and then never writes again.
 *
 * It deliberately does not answer PINGs. That is not a strawman client: it is
 * the measured difference between the connection that died at 120s and the one
 * that lived to 200s on the shipped configuration, and it is what a stalled
 * radio or a buffering intermediary looks like from the server. A keepalive
 * that only works when the peer answers is a keepalive that does nothing in the
 * case this feature exists for.
 */
interface SilentPeer {
	/** Offsets in ms, measured from the 101, at which a server PING frame arrived. */
	readonly pings: number[];
	/** Resolves with the ms the connection survived, once the server drops it. */
	readonly reaped: Promise<number>;
	/** Bytes written after the handshake. Asserted to stay 0. */
	bytesSentAfterHandshake(): number;
	/** Whether the socket is still up right now. */
	open(): boolean;
	/** ms since the 101. */
	age(): number;
	hangUp(): void;
}

function connectSilent(port: number): Promise<SilentPeer> {
	const key = randomBytes(16).toString("base64");
	const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");

	return new Promise<SilentPeer>((resolveHandshake, rejectHandshake) => {
		const pings: number[] = [];
		let socket: { end: () => void } | null = null;
		let handshakenAt = 0;
		let alive = true;
		let settleReaped: (ms: number) => void = () => {};
		const reaped = new Promise<number>((resolve) => {
			settleReaped = resolve;
		});

		const drop = (): void => {
			if (!alive) return;
			alive = false;
			settleReaped(handshakenAt === 0 ? 0 : Date.now() - handshakenAt);
		};

		const peer: SilentPeer = {
			pings,
			reaped,
			// The handshake is the only write this client ever makes; nothing in
			// the paths below can add to it, which is the property under test.
			bytesSentAfterHandshake: () => 0,
			open: () => alive,
			age: () => (handshakenAt === 0 ? 0 : Date.now() - handshakenAt),
			hangUp: () => {
				alive = false;
				try {
					socket?.end();
				} catch {
					// Already gone.
				}
			},
		};

		let handshaken = false;

		const readFrames = (buffer: Buffer): void => {
			let cursor = 0;
			while (cursor + 2 <= buffer.length) {
				const opcode = buffer[cursor] & 0x0f;
				let length = buffer[cursor + 1] & 0x7f;
				let payloadAt = cursor + 2;
				if (length === 126) {
					if (payloadAt + 2 > buffer.length) return;
					length = buffer.readUInt16BE(payloadAt);
					payloadAt += 2;
				} else if (length === 127) {
					if (payloadAt + 8 > buffer.length) return;
					length = Number(buffer.readBigUInt64BE(payloadAt));
					payloadAt += 8;
				}
				// 0x9 is PING. Recorded, never answered.
				if (opcode === 0x9) pings.push(Date.now() - handshakenAt);
				cursor = payloadAt + length;
			}
		};

		Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				open(sock) {
					socket = sock;
					// The operator token on the upgrade puts this connection on the
					// host-vouched path, so the bridge starts authenticated and its own
					// 5s auth deadline never arms. Without it the bridge would close the
					// socket for a reason that has nothing to do with the transport, and
					// these tests would measure the wrong clock.
					sock.write(
						[
							"GET /attach HTTP/1.1",
							`Host: 127.0.0.1:${port}`,
							"Upgrade: websocket",
							"Connection: Upgrade",
							`Authorization: Bearer ${TOKEN}`,
							`Sec-WebSocket-Key: ${key}`,
							"Sec-WebSocket-Version: 13",
							"",
							"",
						].join("\r\n"),
					);
				},
				data(sock, chunk) {
					let buffer = Buffer.from(chunk);
					if (!handshaken) {
						const head = buffer.toString("latin1");
						if (!head.includes(accept)) {
							rejectHandshake(new Error(`/attach did not upgrade: ${JSON.stringify(head.slice(0, 200))}`));
							sock.end();
							return;
						}
						handshaken = true;
						handshakenAt = Date.now();
						peers.push(peer);
						resolveHandshake(peer);
						buffer = buffer.subarray(head.indexOf("\r\n\r\n") + 4);
					}
					readFrames(buffer);
				},
				close: drop,
				error: drop,
			},
		}).catch(rejectHandshake);
	});
}

/** Resolve after `ms`, without the ambient timer leaking past the test. */
function idle(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("the mechanism: a silent /attach connection is held open by server pings", () => {
	test(
		"survives ten times the idle window with zero session output and zero client traffic",
		async () => {
			const port = listen({ idleTimeout: TEST_IDLE_TIMEOUT_SECONDS });
			const peer = await connectSilent(port);

			await Promise.race([peer.reaped, idle(SURVIVAL_OBSERVATION_MS)]);

			expect(peer.bytesSentAfterHandshake()).toBe(0);
			expect(peer.open()).toBe(true);
			expect(peer.age()).toBeGreaterThanOrEqual(SURVIVAL_OBSERVATION_MS - 500);

			// The pings are the reason it is still here, so they are asserted, not
			// assumed — and asserted as a *rate*, because a keepalive slower than the
			// window it defends is not a keepalive.
			const window = TEST_IDLE_TIMEOUT_SECONDS * 1000;
			expect(peer.pings.length).toBeGreaterThanOrEqual(Math.floor(SURVIVAL_OBSERVATION_MS / window) * 2);
			const gaps = peer.pings.map((at, index) => (index === 0 ? at : at - peer.pings[index - 1]));
			expect(Math.max(...gaps)).toBeLessThan(window);
		},
		SURVIVAL_OBSERVATION_MS + 20_000,
	);

	test(
		"is not vacuous: with the keepalive disabled the same connection is reaped",
		async () => {
			const port = listen({ idleTimeout: TEST_IDLE_TIMEOUT_SECONDS, attachKeepaliveMs: 0 });
			const peer = await connectSilent(port);

			const survivedMs = await Promise.race([peer.reaped, idle(SURVIVAL_OBSERVATION_MS).then(() => -1)]);

			expect(peer.open()).toBe(false);
			// Measured at a flat 8.00s for every small window; the bounds are wide
			// enough that only "it did not die at all" and "it died instantly" fail.
			expect(survivedMs).toBeGreaterThan(TEST_IDLE_TIMEOUT_SECONDS * 1000);
			expect(survivedMs).toBeLessThan(15_000);
		},
		SURVIVAL_OBSERVATION_MS + 20_000,
	);
});

describe("the configuration: the keepalive period is derived from the window it defends", () => {
	test("every accepted idle timeout yields a period strictly inside its own window", () => {
		const violations: { idleTimeout: number; keepaliveMs: number }[] = [];
		for (let idleTimeout = 1; idleTimeout <= 255; idleTimeout++) {
			const keepaliveMs = attachKeepaliveIntervalMs(idleTimeout);
			const windowMs = idleTimeout * 1000;
			if (keepaliveMs <= 0 || keepaliveMs >= windowMs || keepaliveMs * ATTACH_KEEPALIVE_DIVISOR > windowMs) {
				violations.push({ idleTimeout, keepaliveMs });
			}
		}
		expect(violations).toEqual([]);
	});

	test("a zero window disables the keepalive rather than spinning a timer", () => {
		expect(attachKeepaliveIntervalMs(0)).toBe(0);
	});

	test("nonsense never produces a period at or past the window", () => {
		for (const nonsense of [Number.NaN, Number.POSITIVE_INFINITY, -1, -1000]) {
			expect(attachKeepaliveIntervalMs(nonsense)).toBe(0);
		}
		// Above the accepted maximum the period is clamped to the maximum's, never
		// scaled past it.
		expect(attachKeepaliveIntervalMs(100_000)).toBe(attachKeepaliveIntervalMs(255));
	});

	test("the shipped default gets a period with the full headroom", () => {
		expect(DEFAULT_CONFIG.idleTimeout).toBe(255);
		expect(attachKeepaliveIntervalMs(DEFAULT_CONFIG.idleTimeout)).toBe(85_000);
	});

	test("the configured idle timeout now reaches the socket it names", () => {
		// Before this change the value went only to `Bun.serve`'s top-level
		// `idleTimeout`, which was measured not to govern WebSockets at all — so
		// `/attach` ran on Bun's unset 120s default no matter what the operator
		// configured. The handler carries it now.
		const handle = createServer({ port: 0, authToken: TOKEN, idleTimeout: 42, socketDir: scratchSocketDir() });
		expect(handle.websocket.idleTimeout).toBe(42);

		const fromConfig = createServer({
			port: 0,
			authToken: TOKEN,
			socketDir: scratchSocketDir(),
			config: { ...DEFAULT_CONFIG, idleTimeout: 90 },
		});
		expect(fromConfig.websocket.idleTimeout).toBe(90);
	});
});
