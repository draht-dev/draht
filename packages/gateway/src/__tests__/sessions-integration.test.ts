import { describe, expect, test } from "bun:test";
import { createServer } from "../index";

/**
 * Integration tests for session endpoints wired into the full server.
 * Auth middleware is active — all session routes require a Bearer token.
 * Uses `app.request()` (no network I/O).
 */
describe("sessions integration (full server)", () => {
	const AUTH_TOKEN = "test-token";
	const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}` };

	function makeApp() {
		return createServer({ port: 0, authToken: AUTH_TOKEN }).app;
	}

	test("POST /sessions with valid auth → 201 with session shape", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", { method: "POST", headers: authHeaders });

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(typeof body.id).toBe("string");
		expect(body.status).toBe("starting");
		expect(typeof body.createdAt).toBe("string");
		expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
	});

	test("GET /sessions with auth → 200 { sessions: [] } initially", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", { headers: authHeaders });

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ sessions: [] });
	});

	test("Create 2 sessions, GET /sessions → 2 items", async () => {
		const app = makeApp();
		await app.request("/sessions", { method: "POST", headers: authHeaders });
		await app.request("/sessions", { method: "POST", headers: authHeaders });

		const res = await app.request("/sessions", { headers: authHeaders });
		const body = await res.json();
		expect(body.sessions).toHaveLength(2);
	});

	test("GET /sessions/:id with valid id + auth → 200", async () => {
		const app = makeApp();
		const createRes = await app.request("/sessions", { method: "POST", headers: authHeaders });
		const created = await createRes.json();

		const res = await app.request(`/sessions/${created.id}`, { headers: authHeaders });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(created.id);
	});

	test("GET /sessions/:id with invalid id + auth → 404", async () => {
		const app = makeApp();
		const res = await app.request("/sessions/00000000-0000-4000-8000-000000000000", {
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "Session not found" });
	});

	test("DELETE /sessions/:id with valid id + auth → 204", async () => {
		const app = makeApp();
		const createRes = await app.request("/sessions", { method: "POST", headers: authHeaders });
		const created = await createRes.json();

		const res = await app.request(`/sessions/${created.id}`, {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(res.status).toBe(204);
	});

	test("After DELETE, GET /sessions omits deleted session", async () => {
		const app = makeApp();
		const createRes = await app.request("/sessions", { method: "POST", headers: authHeaders });
		const created = await createRes.json();

		await app.request(`/sessions/${created.id}`, { method: "DELETE", headers: authHeaders });

		const listRes = await app.request("/sessions", { headers: authHeaders });
		const body = await listRes.json();
		expect(body.sessions).toHaveLength(0);
	});

	test("DELETE /sessions/:id with invalid id → 404", async () => {
		const app = makeApp();
		const res = await app.request("/sessions/00000000-0000-4000-8000-000000000000", {
			method: "DELETE",
			headers: authHeaders,
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "Session not found" });
	});

	test("POST /sessions without auth → 401 (smoke test auth integration)", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", { method: "POST" });

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toEqual({ error: "Unauthorized" });
	});
});
