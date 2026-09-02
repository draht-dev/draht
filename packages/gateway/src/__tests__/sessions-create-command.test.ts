import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSessionRoutes } from "../gateway/routes/sessions";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

/**
 * POST /sessions body handling after R32-FLEET.8.
 *
 * The route used to accept a caller-supplied `command: string[]`, shape-check
 * it with `validateCommand`, and hand it to `Bun.spawn`. That was remote code
 * execution for any bearer-token holder, so the whole path is gone: `command`
 * is now refused outright and no request body can cause a process to exist.
 *
 * These are unit-level assertions on the route. The proof that the *emitted*
 * daemon behaves this way lives in `emitted-daemon.e2e.test.ts`.
 */
describe("POST /sessions body handling", () => {
	let manager: SessionManager;
	let app: Hono;

	beforeEach(() => {
		manager = new SessionManager(new EventBus());
		app = new Hono();
		app.route("/sessions", createSessionRoutes(manager));
	});

	// Any process that somehow came into existence must not outlive the test.
	afterEach(async () => {
		for (const s of manager.list()) {
			manager.destroy(s.id);
		}
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

	test("POST /sessions with a well-formed command array → 400, nothing spawned", async () => {
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["echo", "hello"] }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/command is not accepted/);
		expect(manager.list()).toHaveLength(0);
	});

	test("a command that would previously have been spawned is refused, not run", async () => {
		// ['cat'] used to reach Bun.spawn and reach 'running'. There is no longer
		// any shape of `command` that produces a process.
		const res = await app.request("/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ command: ["cat"] }),
		});
		expect(res.status).toBe(400);
		expect(manager.list()).toHaveLength(0);
	});

	test("every `command` shape is refused identically — no shape check survives", async () => {
		// The old route answered these with four *different* messages, which is
		// exactly the signal an attacker probes for. All of them are now one
		// refusal, and none creates a session.
		for (const command of [["echo", "hi"], [], "echo hello", ["echo", ""], null, 42, { 0: "echo" }]) {
			const res = await app.request("/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command }),
			});
			const body = await res.json();
			expect({ command, status: res.status, error: body.error }).toEqual({
				command,
				status: 400,
				error: body.error,
			});
			expect(body.error).toMatch(/command is not accepted/);
		}
		expect(manager.list()).toHaveLength(0);
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
 * Integration: the refusal sits behind auth, and an unauthenticated caller is
 * still rejected before the body is even considered.
 */
describe("POST /sessions command refusal — auth integration", () => {
	const AUTH_TOKEN = "cmd-test-token";
	const authHeaders = {
		Authorization: `Bearer ${AUTH_TOKEN}`,
		"Content-Type": "application/json",
	};

	function makeApp() {
		return createServer({ port: 0, authToken: AUTH_TOKEN }).app;
	}

	test("POST /sessions with command + valid auth → 400", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({ command: ["echo", "hi"] }),
		});
		expect(res.status).toBe(400);
	});

	test("POST /sessions without a command + valid auth → 201", async () => {
		const app = makeApp();
		const res = await app.request("/sessions", {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify({}),
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
