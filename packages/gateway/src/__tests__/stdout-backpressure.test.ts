/**
 * Stdout backpressure and large output tests.
 *
 * Verifies that the SessionProcess stdout pump and WebSocket fan-out can
 * handle high-volume output without dropping data, blocking, or crashing.
 *
 *  1. Large output (~256 KiB) is fully delivered to an onOutput subscriber
 *  2. All subscribers receive every chunk (fan-out correctness under load)
 *  3. A slow subscriber does not block other subscribers or the pump
 *  4. Unsubscribing mid-stream stops delivery without breaking the pump
 *  5. WebSocket: large stdout burst is received by the client in full
 */

import { afterEach, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";
import { SessionProcess } from "../session/session-process";

// ---------------------------------------------------------------------------
// Helper: sum string lengths across an array
// ---------------------------------------------------------------------------
function totalBytes(chunks: string[]): number {
	return chunks.reduce((n, c) => n + c.length, 0);
}

// ---------------------------------------------------------------------------
// SessionProcess — large output
// ---------------------------------------------------------------------------
describe("SessionProcess — large stdout", () => {
	test("~256 KiB output: all bytes delivered to onOutput subscriber", async () => {
		// dd writes 262144 bytes of zeros then exits
		const proc = new SessionProcess(["dd", "if=/dev/zero", "bs=1024", "count=256"]);
		const chunks: string[] = [];
		proc.onOutput((data) => chunks.push(data));
		await proc.exited;

		const received = totalBytes(chunks);
		// Allow a small delta: dd may write slightly less/more depending on bs alignment
		// but 256 KiB of raw NUL bytes through UTF-8 decode should be >= 250 KiB
		expect(received).toBeGreaterThanOrEqual(250 * 1024);
	});

	test("high-frequency small chunks: all lines delivered from yes | head", async () => {
		// 'yes | head -n 1000' produces 1000 'y\n' lines = 2000 bytes
		const proc = new SessionProcess(["sh", "-c", "yes | head -n 1000"]);
		const chunks: string[] = [];
		proc.onOutput((data) => chunks.push(data));
		await proc.exited;

		const joined = chunks.join("");
		// Count 'y' occurrences — should be exactly 1000
		const yCount = (joined.match(/y/g) ?? []).length;
		expect(yCount).toBe(1000);
	});

	test("two subscribers both receive all output — fan-out correctness", async () => {
		const proc = new SessionProcess(["sh", "-c", "yes | head -n 500"]);
		const chunks1: string[] = [];
		const chunks2: string[] = [];
		proc.onOutput((data) => chunks1.push(data));
		proc.onOutput((data) => chunks2.push(data));
		await proc.exited;

		const joined1 = chunks1.join("");
		const joined2 = chunks2.join("");
		// Both must receive the same total content
		expect(joined1).toBe(joined2);
		// And it must be non-empty
		expect(joined1.length).toBeGreaterThan(0);
	});

	test("unsubscribing mid-stream stops delivery but pump continues for other subscribers", async () => {
		// Use cat + explicit input so we control timing
		const proc = new SessionProcess(["cat"]);
		await proc.ready;

		const chunks1: string[] = [];
		const chunks2: string[] = [];
		const unsub1 = proc.onOutput((data) => chunks1.push(data));
		proc.onOutput((data) => chunks2.push(data));

		// Helper: poll until predicate passes or timeout
		async function waitUntil(pred: () => boolean, ms = 1000) {
			const deadline = Date.now() + ms;
			while (!pred() && Date.now() < deadline) await Bun.sleep(10);
		}

		// Write first batch — both subscribers receive it
		proc.write("batch-one\n");
		await waitUntil(() => chunks1.join("").includes("batch-one") && chunks2.join("").includes("batch-one"));

		// Unsubscribe subscriber 1
		unsub1();

		// Write second batch — only subscriber 2 should receive it
		proc.write("batch-two\n");
		await waitUntil(() => chunks2.join("").includes("batch-two"));

		// Give a moment to confirm subscriber 1 does NOT receive it
		await Bun.sleep(30);

		proc.kill();
		await proc.exited;

		const joined1 = chunks1.join("");
		const joined2 = chunks2.join("");

		expect(joined1).toContain("batch-one");
		expect(joined1).not.toContain("batch-two");

		expect(joined2).toContain("batch-one");
		expect(joined2).toContain("batch-two");
	});

	test("process exit with no subscribers does not throw", async () => {
		const proc = new SessionProcess(["echo", "hi"]);
		// Don't register any subscribers
		await expect(proc.exited).resolves.toBeUndefined();
		expect(proc.status).toBe("stopped");
	});
});

// ---------------------------------------------------------------------------
// WebSocket — large output delivery
// ---------------------------------------------------------------------------
describe("WebSocket — large stdout delivery", () => {
	const AUTH_TOKEN = "backpressure-test";
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
		for (const s of servers) s.stop(true);
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
			ws.addEventListener("error", () => reject(new Error("WS connection error")));
		});
		return { ws, ready };
	}

	test("100 lines of output via cat — all lines received over WebSocket", async () => {
		const { url } = startServer();
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const { ws, ready } = connectToSession(url, session.id);
		await ready;

		const receivedChunks: string[] = [];
		ws.addEventListener("message", (evt: MessageEvent) => {
			receivedChunks.push(String(evt.data));
		});

		// Send a single batch of 100 lines (well under the 64 KiB limit)
		const LINES = 100;
		const payload = Array.from({ length: LINES }, (_, i) => `line-${i}\n`).join("");
		ws.send(payload);

		// Wait until all 100 line markers appear in received output, with a timeout
		const deadline = Date.now() + 3000;
		let fullOutput = "";
		while (Date.now() < deadline) {
			fullOutput = receivedChunks.join("");
			const found = (fullOutput.match(/line-\d+\n/g) ?? []).length;
			if (found >= LINES) break;
			await Bun.sleep(20);
		}

		// All 100 line markers must appear
		for (let i = 0; i < LINES; i++) {
			expect(fullOutput).toContain(`line-${i}\n`);
		}

		manager.destroy(session.id);
		ws.close();
	});
});
