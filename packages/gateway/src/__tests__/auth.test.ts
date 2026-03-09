import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bearerAuthMiddleware } from "../gateway/middleware/auth";
import { createServer } from "../gateway/server";

describe("bearerAuthMiddleware", () => {
	function buildApp(): Hono {
		const app = new Hono();
		app.use("*", bearerAuthMiddleware("test-secret"));
		app.get("/probe", (c) => c.json({ ok: true }));
		return app;
	}

	test("valid Bearer token → 200 pass-through", async () => {
		const app = buildApp();
		const res = await app.request("/probe", {
			headers: { Authorization: "Bearer test-secret" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});

	test("wrong token → 401 Unauthorized", async () => {
		const app = buildApp();
		const res = await app.request("/probe", {
			headers: { Authorization: "Bearer wrong" },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toEqual({ error: "Unauthorized" });
	});

	test("no Authorization header → 401 Unauthorized", async () => {
		const app = buildApp();
		const res = await app.request("/probe");
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toEqual({ error: "Unauthorized" });
	});

	test("malformed header (Basic scheme) → 401 Unauthorized", async () => {
		const app = buildApp();
		const res = await app.request("/probe", {
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body).toEqual({ error: "Unauthorized" });
	});

	test("createServer: GET /health without auth → 200 (public endpoint)", async () => {
		const { app } = createServer({ port: 7878, authToken: "real-secret" });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
	});

	test("query parameter ?token=correct → 200 (for WebSocket compat)", async () => {
		const app = buildApp();
		const res = await app.request("/probe?token=test-secret");
		expect(res.status).toBe(200);
	});

	test("query parameter ?token=wrong → 401", async () => {
		const app = buildApp();
		const res = await app.request("/probe?token=wrongtoken");
		expect(res.status).toBe(401);
	});

	test("both header and query param, header takes precedence", async () => {
		const app = buildApp();
		const res = await app.request("/probe?token=wrongtoken", {
			headers: { Authorization: "Bearer test-secret" },
		});
		expect(res.status).toBe(200); // Header is correct, query is wrong, but header wins
	});
});
