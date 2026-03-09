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

	test("POST /sessions/:id/input with no-process session → 200 (lazy spawn)", async () => {
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

		// Should succeed and spawn process automatically
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("success", true);

		// Process should now exist
		expect(session.process).toBeDefined();
		expect(session.status).toBe("running");

		// Clean up
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
