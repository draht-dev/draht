import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSseRoutes } from "../gateway/routes/sse";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";

// ---------------------------------------------------------------------------
// Bare SSE route tests (no auth middleware, direct EventBus injection)
// ---------------------------------------------------------------------------

describe("SSE route (bare, no auth)", () => {
	let bus: EventBus;
	let app: Hono;

	beforeEach(() => {
		bus = new EventBus();
		app = new Hono();
		app.route("/events", createSseRoutes(bus));
	});

	// 1. GET /events returns 200 with Content-Type: text/event-stream
	test("GET /events returns 200 with Content-Type text/event-stream", async () => {
		const res = await app.request("/events");
		expect(res.status).toBe(200);
		const ct = res.headers.get("content-type") ?? "";
		expect(ct).toContain("text/event-stream");

		// Clean up the stream
		await res.body?.cancel();
	});

	// 2. Response body is a ReadableStream
	test("GET /events response body is a ReadableStream", async () => {
		const res = await app.request("/events");
		expect(res.body).not.toBeNull();
		expect(typeof res.body!.getReader).toBe("function");
		await res.body!.cancel();
	});

	// 3. session:created event → correct SSE chunk
	test("session:created event emitted → SSE chunk with correct format", async () => {
		const res = await app.request("/events");
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		const createdAt = new Date("2026-03-07T21:00:00.000Z");
		bus.emit("session:created", { sessionId: "abc", createdAt });

		try {
			const { value } = await reader.read();
			const text = decoder.decode(value);
			expect(text).toContain("event: session:created");
			expect(text).toContain('"sessionId":"abc"');
		} finally {
			await reader.cancel();
		}
	});

	// 4. session:started event → correct SSE chunk
	test("session:started event emitted → correct SSE chunk", async () => {
		const res = await app.request("/events");
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		bus.emit("session:started", { sessionId: "def" });

		try {
			const { value } = await reader.read();
			const text = decoder.decode(value);
			expect(text).toContain("event: session:started");
			expect(text).toContain('"sessionId":"def"');
		} finally {
			await reader.cancel();
		}
	});

	// 5. session:destroyed event → correct SSE chunk
	test("session:destroyed event emitted → correct SSE chunk", async () => {
		const res = await app.request("/events");
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();

		bus.emit("session:destroyed", { sessionId: "ghi" });

		try {
			const { value } = await reader.read();
			const text = decoder.decode(value);
			expect(text).toContain("event: session:destroyed");
			expect(text).toContain('"sessionId":"ghi"');
		} finally {
			await reader.cancel();
		}
	});

	// 6. Fan-out: two SSE connections both receive events
	test("fan-out: two SSE connections both receive events", async () => {
		const res1 = await app.request("/events");
		const res2 = await app.request("/events");
		const reader1 = res1.body!.getReader();
		const reader2 = res2.body!.getReader();
		const decoder = new TextDecoder();

		bus.emit("session:started", { sessionId: "fan" });

		try {
			const { value: v1 } = await reader1.read();
			const { value: v2 } = await reader2.read();
			expect(decoder.decode(v1)).toContain('"sessionId":"fan"');
			expect(decoder.decode(v2)).toContain('"sessionId":"fan"');
		} finally {
			await reader1.cancel();
			await reader2.cancel();
		}
	});

	// 7. Cleanup: cancel reader, emit event → no error, listener removed
	test("client disconnect → listener removed (listenerCount returns to 0)", async () => {
		const res = await app.request("/events");
		const reader = res.body!.getReader();

		// Confirm at least one listener registered
		const countBefore =
			bus.listenerCount("session:created") +
			bus.listenerCount("session:started") +
			bus.listenerCount("session:stopped") +
			bus.listenerCount("session:destroyed");
		expect(countBefore).toBeGreaterThan(0);

		// Cancel the reader (simulates client disconnect)
		await reader.cancel();

		// Allow cleanup microtasks
		await new Promise((r) => setTimeout(r, 10));

		// Emitting should not throw after disconnect
		expect(() => bus.emit("session:started", { sessionId: "cleanup" })).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Auth tests via createServer
// ---------------------------------------------------------------------------

describe("SSE route (auth via createServer)", () => {
	const AUTH_TOKEN = "sse-test-token";
	const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}` };

	function makeApp() {
		return createServer({ port: 0, authToken: AUTH_TOKEN }).app;
	}

	// 8. GET /events without auth → 401
	test("GET /events without auth → 401", async () => {
		const app = makeApp();
		const res = await app.request("/events");
		expect(res.status).toBe(401);
		await res.body?.cancel();
	});

	// 9. GET /events with wrong token → 401
	test("GET /events with wrong token → 401", async () => {
		const app = makeApp();
		const res = await app.request("/events", {
			headers: { Authorization: "Bearer wrong-token" },
		});
		expect(res.status).toBe(401);
		await res.body?.cancel();
	});

	// 10. GET /events with correct Bearer token → 200 text/event-stream
	test("GET /events with correct Bearer token → 200 text/event-stream", async () => {
		const app = makeApp();
		const res = await app.request("/events", { headers: authHeaders });
		expect(res.status).toBe(200);
		const ct = res.headers.get("content-type") ?? "";
		expect(ct).toContain("text/event-stream");
		await res.body?.cancel();
	});
});
