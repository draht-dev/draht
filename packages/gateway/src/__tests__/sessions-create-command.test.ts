import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSessionRoutes } from "../gateway/routes/sessions";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";
import { SessionProcess } from "../session/session-process";

/**
 * Tests for POST /sessions with and without a command body.
 * Validates input sanitisation, happy paths, and error responses.
 */
describe("POST /sessions command body handling", () => {
	let manager: SessionManager;
	let app: Hono;

	beforeEach(() => {
		manager = new SessionManager(new EventBus());
		app = new Hono();
		app.route("/sessions", createSessionRoutes(manager));
	});

	// Clean up any spawned processes after each test
	afterEach(async () => {
		const sessions = manager.list();
		for (const s of sessions) {
			manager.destroy(s.id);
		}
		// Give processes time to exit
		await Bun.sleep(50);
	});

	test("POST /sessions with no body → 201, status 'starting', no process", async () => {
		const res = await app.request("/sessions", { method: "POST" });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.status).toBe("starting");
		// Session created without a command should not spawn a process
		const session = manager.get(body.id);
		expect(session?.process).toBeUndefined();
	});

	test("POST /sessions with empty JSON body (no command key) → 201, no process", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		const session = manager.get(body.id);
		expect(session?.process).toBeUndefined();
	});

	test("POST /sessions with Content-Type: application/json but empty body → 201 (Adler use case)", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "",
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body).toHaveProperty("id");
		expect(body).toHaveProperty("status", "starting");
		expect(body).toHaveProperty("createdAt");
		const session = manager.get(body.id);
		expect(session?.process).toBeUndefined(); // No process for empty body
	});

	test("POST /sessions with command array → 201, session has a process", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["echo", "hello"] }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.status).toBe("starting"); // still starting synchronously
		const session = manager.get(body.id);
		expect(session?.process).toBeInstanceOf(SessionProcess);
		// Wait for process to exit cleanly
		await session!.process!.exited;
	});

	test("POST /sessions with command=['cat'] → process is a SessionProcess and reaches running", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["cat"] }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		const session = manager.get(body.id);
		expect(session?.process).toBeInstanceOf(SessionProcess);
		await session!.process!.ready;
		expect(session!.process!.status).toBe("running");
		manager.destroy(body.id);
	});

	test("POST /sessions with command=[] → 400 validation error", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: [] }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("non-empty");
	});

	test("POST /sessions with command='string' (not array) → 400 validation error", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: "echo hello" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("array");
	});

	test("POST /sessions with command containing empty string → 400", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["echo", ""] }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("non-empty string");
	});

	test("POST /sessions with malformed JSON → 400 parse error", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{ not valid json",
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("Invalid JSON");
	});
});

/**
 * Integration: POST /sessions with command is protected by auth middleware.
 */
describe("POST /sessions command — auth integration", () => {
	const AUTH_TOKEN = "cmd-test-token";
	const authHeaders = {
		Authorization: `Bearer ${AUTH_TOKEN}`,
		"Content-Type": "application/json",
	};

	function makeApp() {
		return createServer({ port: 0, authToken: AUTH_TOKEN }).app;
	}

	test("POST /sessions with command + valid auth → 201", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ command: ["echo", "hi"] }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(typeof body.id).toBe("string");
	});

	test("POST /sessions with command + no auth → 401", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["echo", "hi"] }),
		});
		expect(res.status).toBe(401);
	});
});
