import { afterEach, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

const AUTH_TOKEN = "ws-limit-secret";
const MAX_MESSAGE_BYTES = 64 * 1024;

describe("WebSocket message size limit", () => {
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

	function connectToSession(url: string, sessionId: string): { ws: WebSocket; ready: Promise<void> } {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(`${url}/sessions/${sessionId}/ws`, {
			headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
		});
		const ready = new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("WebSocket connection error")));
		});
		return { ws, ready };
	}

	function waitForClose(ws: WebSocket, timeoutMs = 1000): Promise<{ code: number; reason: string }> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timeout waiting for close")), timeoutMs);
			ws.addEventListener("close", (evt: CloseEvent) => {
				clearTimeout(timer);
				resolve({ code: evt.code, reason: evt.reason });
			});
		});
	}

	test("message exactly at limit (64KiB) is accepted — no forced close", async () => {
		const { url } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		// Build a message exactly MAX_MESSAGE_BYTES bytes when UTF-8 encoded (all ASCII)
		const payload = "A".repeat(MAX_MESSAGE_BYTES);

		let closedByServer = false;
		ws.addEventListener("close", (evt: CloseEvent) => {
			// Code 1009 = message too large (policy violation)
			if (evt.code === 1009) closedByServer = true;
		});

		ws.send(payload);
		// Wait briefly — if the server doesn't close on a limit-size message, we pass
		await Bun.sleep(200);

		expect(closedByServer).toBe(false);
		ws.close(1000, "done");
		manager.destroy(session.id);
	});

	test("message exceeding limit (64KiB + 1 byte) → server closes with 1009", async () => {
		const { url } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		const closePromise = waitForClose(ws);

		// MAX_MESSAGE_BYTES + 1 byte → should trigger policy violation
		const oversized = "A".repeat(MAX_MESSAGE_BYTES + 1);
		ws.send(oversized);

		const { code } = await closePromise;
		expect(code).toBe(1009);

		manager.destroy(session.id);
	});
});
