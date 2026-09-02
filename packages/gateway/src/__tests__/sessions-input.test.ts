/**
 * Tests for POST /sessions/:id/input endpoint
 */

import { describe, expect, test } from "bun:test";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

const AUTH_TOKEN = "test-token";

function authHeaders() {
	return {
		Authorization: `Bearer ${AUTH_TOKEN}`,
		"Content-Type": "application/json",
	};
}

describe("Session input endpoint", () => {
	test("POST /sessions/:id/input with text → 200", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		// Create session with a process that echoes input
		const session = manager.create(["cat"]);
		await session.process!.ready;

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ text: "hello\n" }),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("success", true);

		// Clean up
		manager.destroy(session.id);
	});

	test("POST /sessions/:id/input with non-existent session → 404", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		const res = await app.request("/sessions/nonexistent/input", {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ text: "hello" }),
		});

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toHaveProperty("error", "Session not found");
	});

	// Was "→ 200 (lazy spawn)" until Phase 35. The route used to start a draht
	// process on an HTTP request with no id resolution, no trust check, no
	// deadline and no teardown — an unguarded spawn reachable by anyone holding
	// the operator token. It was deleted rather than hardened, because a session
	// RECORD is not a session: POST /sessions creates a record and never a
	// process (R32-FLEET.8), so a record with nothing to type into should say so.
	// The only spawn left on this daemon is the resume primitive, which resolves
	// an id against the daemon's own history index and builds its own argv.
	test("POST /sessions/:id/input with no-process session → 409, and starts nothing", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		// Create session without a process
		const session = manager.create();
		expect(session.process).toBeUndefined();

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({ text: "hello\n" }),
		});

		// Refused, and the refusal says where a live session actually comes from.
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("never a process");
		expect(body.error).toContain("attach wire");

		// The load-bearing half: refusing is only honest if nothing was started.
		expect(session.process).toBeUndefined();
		expect(session.status).not.toBe("running");

		manager.destroy(session.id);
	});

	test("POST /sessions/:id/input without text field → 400", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		const session = manager.create(["cat"]);
		await session.process!.ready;

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toHaveProperty("error", "Missing 'text' field in request body");

		manager.destroy(session.id);
	});

	test("POST /sessions/:id/input with invalid JSON → 400", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		const session = manager.create(["cat"]);
		await session.process!.ready;

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: "POST",
			headers: authHeaders(),
			body: "not json",
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body).toHaveProperty("error", "Invalid JSON body");

		manager.destroy(session.id);
	});

	test("POST /sessions/:id/input without auth → 401", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		const session = manager.create(["cat"]);
		await session.process!.ready;

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		});

		expect(res.status).toBe(401);

		manager.destroy(session.id);
	});
});
