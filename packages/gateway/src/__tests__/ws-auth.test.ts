import { afterEach, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

/**
 * WebSocket auth tests — verifying that:
 *  1. No auth header → rejected before upgrade (non-101)
 *  2. Wrong token    → rejected before upgrade (non-101)
 *  3. Valid auth + non-existent session → 101 upgrade then close 4404
 *  4. Valid auth + stopped session     → 101 upgrade then close 4403
 *  5. Valid auth + running session     → 101 upgrade, socket stays OPEN
 */
describe("WebSocket auth", () => {
	const AUTH_TOKEN = "ws-test-secret";
	const servers: ReturnType<typeof Bun.serve>[] = [];

	function startServer(manager: SessionManager): { url: string; server: ReturnType<typeof Bun.serve> } {
		const { app } = createServer({ port: 0, authToken: AUTH_TOKEN, manager });
		const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
		servers.push(server);
		const url = `ws://localhost:${server.port}`;
		return { url, server };
	}

	afterEach(async () => {
		for (const s of servers) {
			s.stop(true);
		}
		servers.length = 0;
	});

	/**
	 * Helper: open a WebSocket with optional Bun-specific headers option.
	 * Returns info about whether it opened and with what close code.
	 *
	 * NOTE: The DOM `WebSocket` constructor only accepts `(url, protocols?)`.
	 * Bun extends it to accept `(url, options)` where options can contain `headers`.
	 * We cast through `unknown` to access Bun's overload without TS errors.
	 */
	function openWs(url: string, headers?: Record<string, string>): WebSocket {
		if (headers) {
			// Bun-specific: pass headers as second arg options object
			return new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(
				url,
				{ headers },
			);
		}
		return new WebSocket(url);
	}

	function wsConnect(
		url: string,
		headers?: Record<string, string>,
		timeoutMs = 2000,
	): Promise<{ opened: boolean; closeCode?: number; closeReason?: string; error?: boolean }> {
		return new Promise((resolve) => {
			let opened = false;
			let settled = false;

			const settle = (result: { opened: boolean; closeCode?: number; closeReason?: string; error?: boolean }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};

			const ws = openWs(url, headers);

			const timer = setTimeout(() => {
				ws.close();
				settle({ opened, closeCode: undefined });
			}, timeoutMs);

			ws.addEventListener("open", () => {
				opened = true;
			});

			ws.addEventListener("close", (evt: CloseEvent) => {
				settle({ opened, closeCode: evt.code, closeReason: evt.reason });
			});

			ws.addEventListener("error", () => {
				settle({ opened, error: true });
			});
		});
	}

	test("case 1: no Authorization header → never reaches OPEN state", async () => {
		const manager = new SessionManager(new EventBus());
		const { url } = startServer(manager);

		const result = await wsConnect(`${url}/sessions/fake-id/ws`);
		// Auth rejected at HTTP layer — socket never opens
		expect(result.opened).toBe(false);
	});

	test("case 2: wrong token → never reaches OPEN state", async () => {
		const manager = new SessionManager(new EventBus());
		const { url } = startServer(manager);

		const result = await wsConnect(`${url}/sessions/fake-id/ws`, {
			Authorization: "Bearer wrong-token",
		});
		expect(result.opened).toBe(false);
	});

	test("case 3: correct token, non-existent session → upgrade succeeds then close 4404", async () => {
		const manager = new SessionManager(new EventBus());
		const { url } = startServer(manager);
		const nonExistentId = "00000000-0000-4000-8000-000000000000";

		const result = await wsConnect(`${url}/sessions/${nonExistentId}/ws`, {
			Authorization: `Bearer ${AUTH_TOKEN}`,
		});
		expect(result.closeCode).toBe(4404);
	});

	test("case 4: correct token, stopped session → upgrade succeeds, stays open (new behavior)", async () => {
		const manager = new SessionManager(new EventBus());
		const { url } = startServer(manager);

		// Create session with a process, then kill it and wait for stopped
		const session = manager.create(["sh", "-c", "exit 0"]);
		await session.process!.exited;
		// status should now be 'stopped'

		// NEW BEHAVIOR: We now allow WebSocket connections to sessions in any status
		// This supports no-process sessions created by Adler
		const result = await wsConnect(`${url}/sessions/${session.id}/ws`, {
			Authorization: `Bearer ${AUTH_TOKEN}`,
		});
		// Connection succeeds and closes normally (no process to stream from)
		expect(result.closeCode).toBe(1000);
	});

	test("case 5: correct token, running session → WebSocket stays OPEN", async () => {
		const manager = new SessionManager(new EventBus());
		const { url } = startServer(manager);

		const session = manager.create(["cat"]);
		await session.process!.ready;

		// Connect and wait briefly to confirm it stays open
		const result = await new Promise<{ opened: boolean; closeCode?: number }>((resolve) => {
			const ws = openWs(`${url}/sessions/${session.id}/ws`, {
				Authorization: `Bearer ${AUTH_TOKEN}`,
			});

			let opened = false;

			ws.addEventListener("open", () => {
				opened = true;
				// Give it 300ms to confirm it stays open
				setTimeout(() => {
					ws.close(1000, "test done");
					resolve({ opened });
				}, 300);
			});

			ws.addEventListener("close", (evt: CloseEvent) => {
				if (!opened) {
					resolve({ opened: false, closeCode: evt.code });
				}
			});

			ws.addEventListener("error", () => {
				if (!opened) resolve({ opened: false });
			});

			setTimeout(() => {
				ws.close();
				resolve({ opened });
			}, 2000);
		});

		expect(result.opened).toBe(true);

		// Clean up
		manager.destroy(session.id);
	});
});
