import { afterEach, describe, expect, test } from "bun:test";
import { createPairingServer, type PairingServerHandle } from "../../src/pairing/server.js";

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
