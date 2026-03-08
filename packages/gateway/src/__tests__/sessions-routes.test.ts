import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSessionRoutes } from "../gateway/routes/sessions";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

/**
 * Unit tests for session routes — mounted on a bare Hono app (no auth middleware).
 * Tests the HTTP layer in isolation from auth concerns.
 */
describe("session routes", () => {
	let manager: SessionManager;
	let app: Hono;

	beforeEach(() => {
		manager = new SessionManager(new EventBus());
		app = new Hono();
		app.route("/sessions", createSessionRoutes(manager));
	});

	test("POST /sessions → 201 with { id, status, createdAt }", async () => {
		const res = await app.request("/sessions", { method: "POST" });

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toHaveProperty("id");
		expect(typeof body.id).toBe("string");
		// UUID v4 format
		expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(body.status).toBe("starting");
		expect(typeof body.createdAt).toBe("string");
		// ISO 8601 string
		expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
	});

	test("GET /sessions (empty) → 200 { sessions: [] }", async () => {
		const res = await app.request("/sessions");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ sessions: [] });
	});

	test("After creating a session, GET /sessions → array with 1 matching item", async () => {
		const createRes = await app.request("/sessions", { method: "POST" });
		const created = await createRes.json();

		const listRes = await app.request("/sessions");
		expect(listRes.status).toBe(200);
		const body = await listRes.json();

		expect(body.sessions).toHaveLength(1);
		expect(body.sessions[0].id).toBe(created.id);
		expect(body.sessions[0].status).toBe(created.status);
		expect(body.sessions[0].createdAt).toBe(created.createdAt);
	});

	test("GET /sessions/:id with known id → 200 with session data", async () => {
		const createRes = await app.request("/sessions", { method: "POST" });
		const created = await createRes.json();

		const res = await app.request(`/sessions/${created.id}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(created.id);
		expect(body.status).toBe(created.status);
		expect(body.createdAt).toBe(created.createdAt);
	});

	test("GET /sessions/:id with unknown id → 404 { error: 'Session not found' }", async () => {
		const res = await app.request("/sessions/00000000-0000-4000-8000-000000000000");
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "Session not found" });
	});

	test("DELETE /sessions/:id with known id → 204 empty body", async () => {
		const createRes = await app.request("/sessions", { method: "POST" });
		const created = await createRes.json();

		const res = await app.request(`/sessions/${created.id}`, { method: "DELETE" });
		expect(res.status).toBe(204);
		const text = await res.text();
		expect(text).toBe("");
	});

	test("After DELETE, GET /sessions no longer includes deleted session", async () => {
		const createRes = await app.request("/sessions", { method: "POST" });
		const created = await createRes.json();

		await app.request(`/sessions/${created.id}`, { method: "DELETE" });

		const listRes = await app.request("/sessions");
		const body = await listRes.json();
		expect(body.sessions).toHaveLength(0);
	});

	test("DELETE /sessions/:id with unknown id → 404 { error: 'Session not found' }", async () => {
		const res = await app.request("/sessions/00000000-0000-4000-8000-000000000000", {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body).toEqual({ error: "Session not found" });
	});
});
