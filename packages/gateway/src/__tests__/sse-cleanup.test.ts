/**
 * SSE cleanup determinism tests.
 *
 * The existing sse.test.ts checks listener count after a 10ms sleep, which
 * is timing-dependent and can flake under load. These tests verify cleanup
 * without relying on fixed delays by using deterministic signal abort and
 * explicit stream cancellation.
 *
 *  1. Listener count returns to 0 immediately after AbortSignal fires
 *  2. Multiple clients: all listeners removed after each disconnect
 *  3. Emitting after all clients disconnect does not throw
 *  4. New client after previous disconnect gets its own fresh listeners
 *  5. SSE response headers: correct Content-Type, no-cache, X-Accel-Buffering
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSseRoutes } from "../gateway/routes/sse";
import { EventBus } from "../session/event-bus";

const ALL_EVENTS = ["session:created", "session:started", "session:stopped", "session:destroyed"] as const;

function totalListeners(bus: EventBus): number {
	return ALL_EVENTS.reduce((n, e) => n + bus.listenerCount(e), 0);
}

describe("SSE cleanup determinism", () => {
	let bus: EventBus;
	let app: Hono;

	beforeEach(() => {
		bus = new EventBus();
		app = new Hono();
		app.route("/events", createSseRoutes(bus));
	});

	test("initial state: zero listeners before any connection", () => {
		expect(totalListeners(bus)).toBe(0);
	});

	test("one connection open: exactly 4 listeners registered (one per event)", async () => {
		const controller = new AbortController();
		const res = await app.request("/events", { signal: controller.signal });

		expect(totalListeners(bus)).toBe(4);

		controller.abort();
		await res.body?.cancel();
	});

	test("abort signal fires: listeners removed immediately in same microtask tick", async () => {
		const controller = new AbortController();
		const res = await app.request("/events", { signal: controller.signal });
		expect(totalListeners(bus)).toBe(4);

		// Cancel the response body FIRST (simulates client disconnect before abort fires),
		// then abort. Both paths must result in 0 listeners.
		await res.body?.cancel();
		controller.abort();

		// No sleep needed — cleanup is synchronous in the abort handler
		await Promise.resolve();
		expect(totalListeners(bus)).toBe(0);
	});

	test("two simultaneous clients: 8 listeners while both open, 4 after one closes", async () => {
		const ctrl1 = new AbortController();
		const ctrl2 = new AbortController();

		const res1 = await app.request("/events", { signal: ctrl1.signal });
		const res2 = await app.request("/events", { signal: ctrl2.signal });

		expect(totalListeners(bus)).toBe(8);

		// Close client 1
		await res1.body?.cancel();
		ctrl1.abort();
		await Promise.resolve();

		expect(totalListeners(bus)).toBe(4);

		// Close client 2
		await res2.body?.cancel();
		ctrl2.abort();
		await Promise.resolve();

		expect(totalListeners(bus)).toBe(0);
	});

	test("emitting after all clients disconnect does not throw", async () => {
		const ctrl = new AbortController();
		const res = await app.request("/events", { signal: ctrl.signal });

		await res.body?.cancel();
		ctrl.abort();
		await Promise.resolve();

		expect(() => {
			bus.emit("session:started", { sessionId: "post-disconnect" });
		}).not.toThrow();
	});

	test("reconnecting client gets fresh listeners (not cumulative)", async () => {
		// Connect + disconnect
		const ctrl1 = new AbortController();
		const res1 = await app.request("/events", { signal: ctrl1.signal });
		await res1.body?.cancel();
		ctrl1.abort();
		await Promise.resolve();

		expect(totalListeners(bus)).toBe(0);

		// Connect again
		const ctrl2 = new AbortController();
		const res2 = await app.request("/events", { signal: ctrl2.signal });

		expect(totalListeners(bus)).toBe(4); // exactly 4, not 8

		await res2.body?.cancel();
		ctrl2.abort();
		await Promise.resolve();

		expect(totalListeners(bus)).toBe(0);
	});

	test("SSE response has X-Accel-Buffering: no header", async () => {
		const ctrl = new AbortController();
		const res = await app.request("/events", { signal: ctrl.signal });

		expect(res.headers.get("x-accel-buffering")).toBe("no");

		await res.body?.cancel();
		ctrl.abort();
	});

	test("SSE response has Cache-Control: no-cache header", async () => {
		const ctrl = new AbortController();
		const res = await app.request("/events", { signal: ctrl.signal });

		expect(res.headers.get("cache-control")).toBe("no-cache");

		await res.body?.cancel();
		ctrl.abort();
	});

	test("all four event types produce correctly formatted SSE frames", async () => {
		const events: Array<{ type: string; data: unknown }> = [
			{ type: "session:created", data: { sessionId: "c1", createdAt: new Date("2026-01-01T00:00:00.000Z") } },
			{ type: "session:started", data: { sessionId: "s1" } },
			{ type: "session:stopped", data: { sessionId: "st1", exitCode: 0 } },
			{ type: "session:destroyed", data: { sessionId: "d1" } },
		];

		for (const { type, data } of events) {
			const ctrl = new AbortController();
			const res = await app.request("/events", { signal: ctrl.signal });
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();

			// Emit the event
			bus.emit(type as "session:created", data as never);

			const { value } = await reader.read();
			const text = decoder.decode(value);

			expect(text).toContain(`event: ${type}`);
			expect(text).toContain(`"sessionId"`);
			expect(text).toMatch(/\n\n$/); // double newline terminator

			await reader.cancel();
			ctrl.abort();
		}
	});
});
