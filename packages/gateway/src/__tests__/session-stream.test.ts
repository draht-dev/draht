/**
 * Tests for GET /sessions/:id/stream (SSE endpoint)
 */

import { describe, expect, test } from "bun:test";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

const AUTH_TOKEN = "test-token";

function authHeaders() {
	return {
		Authorization: `Bearer ${AUTH_TOKEN}`,
		Accept: "text/event-stream",
	};
}

describe("Session streaming (SSE)", () => {
	test("GET /sessions/:id/stream with valid session → 200 text/event-stream", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		// Create a session
		const session = manager.create();

		const res = await app.request(`/sessions/${session.id}/stream`, {
			headers: authHeaders(),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Connection")).toBe("keep-alive");
	});

	test("GET /sessions/:id/stream with non-existent session → 404", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		const res = await app.request("/sessions/nonexistent/stream", {
			headers: authHeaders(),
		});

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toHaveProperty("error", "Session not found");
	});

	test("GET /sessions/:id/stream without auth → 401", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		const session = manager.create();

		const res = await app.request(`/sessions/${session.id}/stream`, {
			headers: { Accept: "text/event-stream" },
		});

		expect(res.status).toBe(401);
	});

	test("GET /sessions/:id/stream for no-process session → sends ready event", async () => {
		const bus = new EventBus();
		const manager = new SessionManager(bus);
		const { app } = createServer({ port: 7878, authToken: AUTH_TOKEN, manager });

		// Create session without process
		const session = manager.create();

		const res = await app.request(`/sessions/${session.id}/stream`, {
			headers: authHeaders(),
		});

		expect(res.status).toBe(200);

		// Read the first event from the stream
		const reader = res.body?.getReader();
		if (!reader) throw new Error("No response body");

		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);

		// Should contain a "ready" event
		expect(text).toContain("event: ready");
		expect(text).toContain(`"sessionId":"${session.id}"`);
		expect(text).toContain('"status":"starting"');

		reader.cancel();
	});
});
