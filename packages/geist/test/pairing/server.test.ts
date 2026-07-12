import { afterEach, describe, expect, test } from "bun:test";
import { createPairingServer, type PairingServerHandle } from "../../src/pairing/server.js";
import type { PermissionRelaySession, PermissionRequestEvent } from "../../src/session-bridge.js";

/**
 * Real integration test — no mocks. Starts the actual pairing server on an
 * ephemeral port (Bun.serve), connects a real WebSocket client, and drives
 * the on-wire handshake end to end. This is the concrete, automatable proof
 * of R33-M1.1: "WS pairing handshake (LAN, token) between bridge and
 * headset, survives reconnect" and spec §16 M1's "pairing survives restart".
 */

const TOKEN = "correct-lan-pairing-token";

describe("createPairingServer — WS pairing handshake", () => {
	const handles: PairingServerHandle[] = [];

	/** Injectable, manually-advanced clock so the grace-window assertions don't need a real 60s sleep. */
	function fakeClock(startMs = 0) {
		let current = startMs;
		return {
			now: () => current,
			advance: (byMs: number) => {
				current += byMs;
			},
		};
	}

	function start(opts: Parameters<typeof createPairingServer>[0] = {}): PairingServerHandle {
		const handle = createPairingServer({ token: TOKEN, ...opts });
		handles.push(handle);
		return handle;
	}

	afterEach(() => {
		for (const h of handles) h.close();
		handles.length = 0;
	});

	function waitForOpen(ws: WebSocket): Promise<void> {
		return new Promise((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket connection error")));
		});
	}

	function waitForMessage(ws: WebSocket, timeoutMs = 1000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timeout waiting for WS message (${timeoutMs}ms)`)),
				timeoutMs,
			);
			ws.addEventListener(
				"message",
				(evt: MessageEvent) => {
					clearTimeout(timer);
					resolve(JSON.parse(String(evt.data)));
				},
				{ once: true },
			);
		});
	}

	function waitForClose(ws: WebSocket, timeoutMs = 1000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for WS close (${timeoutMs}ms)`)), timeoutMs);
			ws.addEventListener(
				"close",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
	}

	/** Polls until `predicate()` is true or the timeout elapses — for asserting server-side state after a client-initiated close. */
	async function waitUntil(predicate: () => boolean, timeoutMs = 1000, intervalMs = 5): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) {
				throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
			}
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}

	test("full handshake: pair, disconnect, reconnect within grace resumes without re-pairing", async () => {
		const clock = fakeClock(0);
		const handle = start({ graceWindowMs: 60_000, now: clock.now });

		// 1. Headset connects and pairs with the correct token.
		const first = new WebSocket(handle.url);
		await waitForOpen(first);
		expect(handle.state.status).toBe("pairing");

		first.send(JSON.stringify({ type: "pair", token: TOKEN }));
		const pairResponse = await waitForMessage(first);
		expect(pairResponse).toEqual({ type: "paired" });
		expect(handle.state.status).toBe("paired");

		// 2. Headset app restarts — the socket drops.
		const closed = waitForClose(first);
		first.close();
		await closed;
		await waitUntil(() => handle.state.disconnectedAt !== null);
		expect(handle.state.status).toBe("paired"); // spec §16 M1: pairing survives restart
		expect(handle.state.disconnectedAt).toBe(0);

		// 3. Some time passes, well within the grace window.
		clock.advance(15_000);

		// 4. Headset reconnects with a NEW socket (as a real app restart would) and resumes.
		const second = new WebSocket(handle.url);
		await waitForOpen(second);
		second.send(JSON.stringify({ type: "reconnect", token: TOKEN }));
		const reconnectResponse = await waitForMessage(second);

		expect(reconnectResponse).toEqual({ type: "reconnected" });
		expect(handle.state.status).toBe("paired");
		expect(handle.state.disconnectedAt).toBeNull();

		second.close();
	});

	test("wrong token during initial pairing is rejected", async () => {
		const handle = start();

		const ws = new WebSocket(handle.url);
		await waitForOpen(ws);
		ws.send(JSON.stringify({ type: "pair", token: "not-the-right-token" }));
		const response = await waitForMessage(ws);

		expect(response).toEqual({ type: "pair_rejected", reason: "invalid_token" });
		expect(handle.state.status).toBe("unpaired");

		ws.close();
	});

	test("reconnect past the grace window is rejected and requires a fresh pairing", async () => {
		const clock = fakeClock(0);
		const handle = start({ graceWindowMs: 100, now: clock.now });

		const first = new WebSocket(handle.url);
		await waitForOpen(first);
		first.send(JSON.stringify({ type: "pair", token: TOKEN }));
		await waitForMessage(first);
		expect(handle.state.status).toBe("paired");

		const closed = waitForClose(first);
		first.close();
		await closed;
		await waitUntil(() => handle.state.disconnectedAt !== null);

		clock.advance(101); // just past the 100ms grace window

		const second = new WebSocket(handle.url);
		await waitForOpen(second);
		second.send(JSON.stringify({ type: "reconnect", token: TOKEN }));
		const reconnectResponse = await waitForMessage(second);

		expect(reconnectResponse).toEqual({ type: "reconnect_rejected", reason: "grace_expired" });
		expect(handle.state.status).toBe("unpaired");

		// A fresh pair on the SAME socket now succeeds — proving re-pairing works after grace expiry.
		second.send(JSON.stringify({ type: "pair", token: TOKEN }));
		const rePairResponse = await waitForMessage(second);
		expect(rePairResponse).toEqual({ type: "paired" });

		second.close();
	});
});

/**
 * Real integration test — no mocks. Proves R35-M3.5's WS relay: a session's
 * `permission_request` reaches the paired headset over a real socket, and a
 * `permission_answer` sent back over that same socket reaches the session's
 * `answerPermission`. The ACP side (spawning a real agent subprocess, ACP's
 * own `session/request_permission`) was already proven end to end by the
 * prior task's `geist-acp` work — this only proves the relay, so the session
 * here is a minimal `PermissionRelaySession`-shaped fake, not a real
 * `AcpHarnessSession`.
 */
describe("createPairingServer — permission_request/permission_answer relay (spec §9.2, R35-M3.5)", () => {
	const handles: PairingServerHandle[] = [];

	function start(opts: Parameters<typeof createPairingServer>[0] = {}): PairingServerHandle {
		const handle = createPairingServer({ token: TOKEN, ...opts });
		handles.push(handle);
		return handle;
	}

	afterEach(() => {
		for (const h of handles) h.close();
		handles.length = 0;
	});

	function waitForOpen(ws: WebSocket): Promise<void> {
		return new Promise((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket connection error")));
		});
	}

	function waitForMessage(ws: WebSocket, timeoutMs = 1000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timeout waiting for WS message (${timeoutMs}ms)`)),
				timeoutMs,
			);
			ws.addEventListener(
				"message",
				(evt: MessageEvent) => {
					clearTimeout(timer);
					resolve(JSON.parse(String(evt.data)));
				},
				{ once: true },
			);
		});
	}

	/** A minimal `PermissionRelaySession`-shaped fake — no ACP subprocess needed to prove the relay. */
	function fakePermissionSession(id: string) {
		const listeners = new Set<(event: PermissionRequestEvent) => void>();
		const answered: Array<{ requestId: string; optionId: string }> = [];
		let resolveAnswered: (() => void) | undefined;
		const answeredOnce = new Promise<void>((resolve) => {
			resolveAnswered = resolve;
		});

		const session: PermissionRelaySession = {
			id,
			onPermissionRequest(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			async answerPermission(requestId, optionId) {
				answered.push({ requestId, optionId });
				resolveAnswered?.();
			},
		};

		return {
			session,
			answered,
			answeredOnce,
			raise(event: PermissionRequestEvent) {
				for (const listener of listeners) listener(event);
			},
		};
	}

	/** Connects, pairs, and returns the socket ready to exchange domain messages. */
	async function connectAndPair(handle: PairingServerHandle): Promise<WebSocket> {
		const ws = new WebSocket(handle.url);
		await waitForOpen(ws);
		ws.send(JSON.stringify({ type: "pair", token: TOKEN }));
		const response = await waitForMessage(ws);
		expect(response).toEqual({ type: "paired" });
		return ws;
	}

	test("a registered session's permission_request reaches the paired headset, and permission_answer resolves it", async () => {
		const handle = start();
		const fake = fakePermissionSession("session-1");
		handle.sessionBridge.registerSession(fake.session);

		const ws = await connectAndPair(handle);

		const permissionRequestReceived = waitForMessage(ws);
		fake.raise({
			requestId: "perm-1",
			title: "Allow write to config.yaml?",
			options: [
				{ id: "allow", label: "Allow", kind: "allow_once" },
				{ id: "deny", label: "Deny", kind: "reject_once" },
			],
		});

		const message = await permissionRequestReceived;
		expect(message).toEqual({
			type: "permission_request",
			payload: {
				sessionId: "session-1",
				requestId: "perm-1",
				title: "Allow write to config.yaml?",
				options: [
					{ id: "allow", label: "Allow", kind: "allow_once" },
					{ id: "deny", label: "Deny", kind: "reject_once" },
				],
			},
		});

		ws.send(
			JSON.stringify({
				type: "permission_answer",
				payload: { sessionId: "session-1", requestId: "perm-1", optionId: "allow" },
			}),
		);
		await fake.answeredOnce;

		expect(fake.answered).toEqual([{ requestId: "perm-1", optionId: "allow" }]);

		ws.close();
	});

	test("permission_answer for an unregistered session id gets an error reply instead of crashing the server", async () => {
		const handle = start();
		const ws = await connectAndPair(handle);

		ws.send(
			JSON.stringify({
				type: "permission_answer",
				payload: { sessionId: "no-such-session", requestId: "perm-1", optionId: "allow" },
			}),
		);
		const response = await waitForMessage(ws);

		expect(response).toEqual({ type: "error", reason: "permission_answer_failed" });

		ws.close();
	});

	test("permission_answer before pairing completes is rejected", async () => {
		const handle = start();
		const ws = new WebSocket(handle.url);
		await waitForOpen(ws);

		ws.send(
			JSON.stringify({
				type: "permission_answer",
				payload: { sessionId: "session-1", requestId: "perm-1", optionId: "allow" },
			}),
		);
		const response = await waitForMessage(ws);

		expect(response).toEqual({ type: "error", reason: "not_paired" });

		ws.close();
	});

	test("a permission_request raised while nobody is connected does not throw", () => {
		const handle = start();
		const fake = fakePermissionSession("session-1");
		handle.sessionBridge.registerSession(fake.session);

		expect(() => fake.raise({ requestId: "perm-1", title: "unheard", options: [] })).not.toThrow();
	});

	/** Rejects if any message arrives on `ws` within `ms`; resolves if the window passes silently. */
	function expectNoMessage(ws: WebSocket, ms = 250): Promise<void> {
		return new Promise((resolve, reject) => {
			const onMessage = (evt: MessageEvent) => {
				clearTimeout(timer);
				reject(new Error(`unexpected WS message: ${String(evt.data)}`));
			};
			const timer = setTimeout(() => {
				ws.removeEventListener("message", onMessage);
				resolve();
			}, ms);
			ws.addEventListener("message", onMessage);
		});
	}

	test("an unauthenticated second socket is not treated as the paired session (no leak, no hijack, no spurious disconnect)", async () => {
		const handle = start();
		const fake = fakePermissionSession("session-1");
		handle.sessionBridge.registerSession(fake.session);

		// Socket A is the legitimate headset: it pairs successfully.
		const socketA = await connectAndPair(handle);
		expect(handle.state.status).toBe("paired");

		// Socket B merely connects to /pair and NEVER presents a token.
		const socketB = new WebSocket(handle.url);
		await waitForOpen(socketB);
		// B opening must not disturb A's paired session.
		expect(handle.state.status).toBe("paired");
		expect(handle.state.disconnectedAt).toBeNull();

		// A permission_request must reach A only — B must NOT see the tool title.
		const aReceives = waitForMessage(socketA);
		const bStaysSilent = expectNoMessage(socketB);
		fake.raise({
			requestId: "perm-1",
			title: "Allow write to secrets.env?",
			options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
		});

		const aMessage = await aReceives;
		expect(aMessage).toEqual({
			type: "permission_request",
			payload: {
				sessionId: "session-1",
				requestId: "perm-1",
				title: "Allow write to secrets.env?",
				options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
			},
		});
		await bStaysSilent;

		// B tries to answer the permission it never should have seen: it must be
		// rejected and never routed to the session's answerPermission.
		const bRejected = waitForMessage(socketB);
		socketB.send(
			JSON.stringify({
				type: "permission_answer",
				payload: { sessionId: "session-1", requestId: "perm-1", optionId: "allow" },
			}),
		);
		expect(await bRejected).toEqual({ type: "error", reason: "not_paired" });
		expect(fake.answered).toEqual([]);

		// B closing must NOT disconnect A's still-connected paired session.
		const bClosed = new Promise<void>((resolve) => {
			socketB.addEventListener("close", () => resolve(), { once: true });
		});
		socketB.close();
		await bClosed;
		// Give the server's onClose a beat to run before asserting it did nothing.
		await new Promise((r) => setTimeout(r, 100));
		expect(handle.state.status).toBe("paired");
		expect(handle.state.disconnectedAt).toBeNull();

		// A's own answer still lands, proving A remained the authenticated socket.
		socketA.send(
			JSON.stringify({
				type: "permission_answer",
				payload: { sessionId: "session-1", requestId: "perm-1", optionId: "allow" },
			}),
		);
		await fake.answeredOnce;
		expect(fake.answered).toEqual([{ requestId: "perm-1", optionId: "allow" }]);

		socketA.close();
	});
});
