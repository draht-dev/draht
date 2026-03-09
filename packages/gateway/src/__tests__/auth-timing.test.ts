import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bearerAuthMiddleware } from "../gateway/middleware/auth";

/**
 * Tests verifying timing-safe token comparison behaviour.
 *
 * We cannot easily measure timing in a unit test environment, but we can verify
 * correctness: tokens of the same length but different content are rejected,
 * and tokens of different lengths are also rejected — without any observable
 * difference in return value (both return 401).
 */
describe("bearerAuthMiddleware — timing-safe comparison", () => {
	const SECRET = "super-secret-token-32-chars-long";

	function buildApp(token = SECRET): Hono {
		const app = new Hono();
		app.use("*", bearerAuthMiddleware(token));
		app.get("/probe", (c) => c.json({ ok: true }));
		return app;
	}

	test("correct token → 200", async () => {
		const app = buildApp();
		const res = await app.request("/probe", {
			headers: { Authorization: `Bearer ${SECRET}` },
		});
		expect(res.status).toBe(200);
	});

	test("token same length but different content → 401", async () => {
		const app = buildApp();
		// Same length, one character changed
		const wrong = `${SECRET.slice(0, -1)}X`;
		const res = await app.request("/probe", {
			headers: { Authorization: `Bearer ${wrong}` },
		});
		expect(res.status).toBe(401);
	});

	test("token shorter than secret → 401", async () => {
		const app = buildApp();
		const res = await app.request("/probe", {
			headers: { Authorization: `Bearer ${SECRET.slice(0, 10)}` },
		});
		expect(res.status).toBe(401);
	});

	test("token longer than secret → 401", async () => {
		const app = buildApp();
		const res = await app.request("/probe", {
			headers: { Authorization: `Bearer ${SECRET}extra` },
		});
		expect(res.status).toBe(401);
	});

	test("empty token → 401", async () => {
		const app = buildApp();
		// Authorization header with just 'Bearer ' (empty token after space)
		// The regex /^Bearer (.+)$/i requires at least one char — so this is
		// caught by the regex check, not the comparison. Still should be 401.
		const res = await app.request("/probe", {
			headers: { Authorization: "Bearer " },
		});
		expect(res.status).toBe(401);
	});

	test("token that prefix-matches but has extra chars → 401", async () => {
		// Verify the comparison catches prefix attacks (longer token that starts correctly)
		const app = buildApp();
		const prefixAttack = SECRET + SECRET; // double the expected token
		const res = await app.request("/probe", {
			headers: { Authorization: `Bearer ${prefixAttack}` },
		});
		expect(res.status).toBe(401);
	});

	test("all-zeros token (same length) → 401", async () => {
		const app = buildApp();
		const zeros = "0".repeat(SECRET.length);
		const res = await app.request("/probe", {
			headers: { Authorization: `Bearer ${zeros}` },
		});
		expect(res.status).toBe(401);
	});
});
