import { afterEach, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

/**
 * WebSocket streaming tests:
 *  OT-2: Agent stdout streamed to connected clients
 *  OT-3: Client input forwarded to agent stdin
 *  OT-5: Clean connection close on session destroy or process exit
 */
describe("WebSocket streaming", () => {
	const AUTH_TOKEN = "ws-stream-secret";
	const servers: ReturnType<typeof Bun.serve>[] = [];
	let manager: SessionManager;

	function startServer(): { url: string; server: ReturnType<typeof Bun.serve> } {
		manager = new SessionManager(new EventBus());
		const { app } = createServer({ port: 0, authToken: AUTH_TOKEN, manager });
		const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
		servers.push(server);
		return { url: `ws://localhost:${server.port}`, server };
	}

	afterEach(async () => {
		for (const s of servers) {
			s.stop(true);
		}
		servers.length = 0;
	});

	/**
	 * Open a WebSocket to the given session URL with auth.
	 * Returns the socket and a promise that resolves when it's open.
	 */
	function connectToSession(url: string, sessionId: string): { ws: WebSocket; ready: Promise<void> } {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(`${url}/sessions/${sessionId}/ws`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
		const ready = new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket connection error")));
		});
		return { ws, ready };
	}

	/**
	 * Wait for a WebSocket message matching a predicate, with a timeout.
	 */
	function waitForMessage(ws: WebSocket, predicate: (data: string) => boolean, timeoutMs = 500): Promise<string> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for matching WS message (${timeoutMs}ms)`));
			}, timeoutMs);

			const handler = (evt: MessageEvent) => {
				const data = String(evt.data);
				if (predicate(data)) {
					clearTimeout(timer);
					ws.removeEventListener("message", handler);
					resolve(data);
				}
			};
			ws.addEventListener("message", handler);
		});
	}

	/**
	 * Wait for a WebSocket close event with a timeout.
	 */
	function waitForClose(ws: WebSocket, timeoutMs = 1000): Promise<{ code: number; reason: string }> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timeout waiting for WS close (${timeoutMs}ms)`));
			}, timeoutMs);

			ws.addEventListener("close", (evt: CloseEvent) => {
				clearTimeout(timer);
				resolve({ code: evt.code, reason: evt.reason });
			});
		});
	}

	test("OT-2: stdout streaming — cat echoes sent text back over WS", async () => {
		const { url } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		const messagePromise = waitForMessage(ws, (d) => d.includes("hello\n"));
		ws.send("hello\n");
		const received = await messagePromise;

		expect(received).toContain("hello\n");
		ws.close();
		manager.destroy(session.id);
	});

	test("OT-3: stdin forwarding — WS message is written to process stdin", async () => {
		const { url } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		const messagePromise = waitForMessage(ws, (d) => d.includes("world\n"));
		ws.send("world\n");
		const received = await messagePromise;

		expect(received).toContain("world\n");
		ws.close();
		manager.destroy(session.id);
	});

	test("OT-5: session destroy closes WS with code 1001", async () => {
		const { url, server } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		const closePromise = waitForClose(ws, 1000);

		// Issue DELETE /sessions/:id via HTTP to the live server
		const deleteRes = await fetch(`http://localhost:${server.port}/sessions/${session.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
		});
		expect(deleteRes.status).toBe(204);

		const closeEvent = await closePromise;
		// Bun's WebSocket client normalizes 1001 → 1000 at the protocol level;
		// the server sends 1001 but the client may receive either value.
		expect([1000, 1001]).toContain(closeEvent.code);
	});

	test("OT-5: process natural exit closes WS", async () => {
		const { url } = startServer();
		// Process that exits naturally after a short delay
		const session = manager.create(["sh", "-c", "sleep 0.05 && exit 0"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		const closeEvent = await waitForClose(ws, 2000);
		// 1001 (going away) is expected on natural process exit
		expect([1000, 1001]).toContain(closeEvent.code);
	});

	test("OT-2: broadcast — both clients receive message from one send", async () => {
		const { url } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws: ws1, ready: ready1 } = connectToSession(url, session.id);
		const { ws: ws2, ready: ready2 } = connectToSession(url, session.id);
		await Promise.all([ready1, ready2]);

		const msg1Promise = waitForMessage(ws1, (d) => d.includes("broadcast\n"));
		const msg2Promise = waitForMessage(ws2, (d) => d.includes("broadcast\n"));

		// Only ws1 sends; both should receive (cat echoes stdin to stdout)
		ws1.send("broadcast\n");

		const [msg1, msg2] = await Promise.all([msg1Promise, msg2Promise]);
		expect(msg1).toContain("broadcast\n");
		expect(msg2).toContain("broadcast\n");

		ws1.close();
		ws2.close();
		manager.destroy(session.id);
	});
});
