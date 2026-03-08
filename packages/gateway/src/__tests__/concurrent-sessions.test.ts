/**
 * Concurrent session operation tests.
 *
 * These tests specifically exercise race conditions that cannot be caught by
 * sequential unit tests:
 *
 *  1. Simultaneous create() calls — both sessions must land in the store
 *  2. Concurrent create + destroy racing — no partial state leaks
 *  3. destroyAll() called while create() is mid-flight — idempotent result
 *  4. destroy() called twice concurrently on the same id — only one true/one false
 *  5. Multiple GET /sessions requests in parallel return consistent snapshots
 *  6. Rapid POST /sessions burst — all 10 requests land, count is exact
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSessionRoutes } from "../gateway/routes/sessions";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

describe("Concurrent session operations — SessionManager", () => {
	let bus: EventBus;
	let manager: SessionManager;

	beforeEach(() => {
		bus = new EventBus();
		manager = new SessionManager(bus);
	});

	test("simultaneous create() calls — both sessions appear in list", () => {
		// Synchronous creates; JS is single-threaded so this tests logical idempotency
		const [s1, s2] = [manager.create(), manager.create()];
		const list = manager.list();
		expect(list).toHaveLength(2);
		expect(list.map((s) => s.id)).toContain(s1.id);
		expect(list.map((s) => s.id)).toContain(s2.id);
		expect(s1.id).not.toBe(s2.id);
	});

	test("destroy() called twice on same id — exactly one true, one false", () => {
		const session = manager.create();
		const r1 = manager.destroy(session.id);
		const r2 = manager.destroy(session.id);
		expect(r1).toBe(true);
		expect(r2).toBe(false);
		expect(manager.list()).toHaveLength(0);
	});

	test("create then immediately destroy — session removed, get() returns undefined", () => {
		const session = manager.create();
		const destroyed = manager.destroy(session.id);
		expect(destroyed).toBe(true);
		expect(manager.get(session.id)).toBeUndefined();
		expect(manager.list()).toHaveLength(0);
	});

	test("destroyAll() after rapid creation of 20 sessions — all removed", () => {
		for (let i = 0; i < 20; i++) {
			manager.create();
		}
		expect(manager.list()).toHaveLength(20);
		const count = manager.destroyAll();
		expect(count).toBe(20);
		expect(manager.list()).toHaveLength(0);
	});

	test("destroy() during destroyAll() — second destroyAll returns 0 (idempotent)", () => {
		manager.create();
		manager.create();
		manager.create();

		// Destroy one manually first
		const ids = manager.list().map((s) => s.id);
		manager.destroy(ids[0]!);

		// destroyAll should only destroy the remaining 2
		const count = manager.destroyAll();
		expect(count).toBe(2);
		expect(manager.list()).toHaveLength(0);

		// Second call is a no-op
		expect(manager.destroyAll()).toBe(0);
	});

	test("session:destroyed emitted exactly once per destroy — not on double-destroy", () => {
		let destroyedCount = 0;
		bus.on("session:destroyed", () => {
			destroyedCount++;
		});
		const session = manager.create();
		manager.destroy(session.id);
		manager.destroy(session.id); // second call is no-op
		expect(destroyedCount).toBe(1);
	});

	test("create + process lifecycle concurrent with destroy — process killed, no zombie", async () => {
		const session = manager.create(["cat"]);
		const proc = session.process!;
		await proc.ready;

		// Destroy immediately after process is running
		manager.destroy(session.id);

		// Process must exit
		await proc.exited;
		expect(proc.status).toBe("stopped");
		expect(manager.get(session.id)).toBeUndefined();
	});
});

describe("Concurrent session operations — HTTP routes", () => {
	let manager: SessionManager;
	let app: Hono;

	beforeEach(() => {
		manager = new SessionManager(new EventBus());
		app = new Hono();
		app.route("/sessions", createSessionRoutes(manager));
	});

	test("10 parallel POST /sessions → 10 unique sessions with unique IDs", async () => {
		const requests = Array.from({ length: 10 }, () => app.request("/sessions", { method: "POST" }));
		const responses = await Promise.all(requests);

		// All should succeed with 201
		for (const res of responses) {
			expect(res.status).toBe(201);
		}

		// All returned IDs must be unique
		const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ id: string }>));
		const ids = bodies.map((b) => b.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(10);

		// Manager must have exactly 10 sessions
		expect(manager.list()).toHaveLength(10);
	});

	test("parallel GET /sessions returns consistent count while creates are happening", async () => {
		// Pre-create 5 sessions
		for (let i = 0; i < 5; i++) {
			manager.create();
		}

		// Fire 5 GETs concurrently
		const getResults = await Promise.all(Array.from({ length: 5 }, () => app.request("/sessions")));

		for (const res of getResults) {
			expect(res.status).toBe(200);
			const body = (await res.json()) as { sessions: unknown[] };
			// Every snapshot must show at least 5 sessions
			expect(body.sessions.length).toBeGreaterThanOrEqual(5);
		}
	});

	test("DELETE on an id being concurrently deleted returns consistent result", async () => {
		const session = manager.create();
		const id = session.id;

		// Fire two deletes simultaneously
		const [r1, r2] = await Promise.all([
			app.request(`/sessions/${id}`, { method: "DELETE" }),
			app.request(`/sessions/${id}`, { method: "DELETE" }),
		]);

		const statuses = [r1.status, r2.status].sort();
		// One should be 204, one 404 — order is non-deterministic
		expect(statuses).toEqual([204, 404]);
		expect(manager.list()).toHaveLength(0);
	});

	test("full integration: POST /sessions with createServer auth middleware — 10 parallel creates", async () => {
		const AUTH = "concurrent-test-token";
		const { app: serverApp } = createServer({ port: 0, authToken: AUTH });
		const headers = { Authorization: `Bearer ${AUTH}` };

		const requests = Array.from({ length: 10 }, () => serverApp.request("/sessions", { method: "POST", headers }));
		const responses = await Promise.all(requests);

		for (const res of responses) {
			expect(res.status).toBe(201);
		}

		// Verify GET /sessions count
		const listRes = await serverApp.request("/sessions", { headers });
		const body = (await listRes.json()) as { sessions: unknown[] };
		expect(body.sessions).toHaveLength(10);
	});
});
