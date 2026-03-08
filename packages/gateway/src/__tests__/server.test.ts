import { describe, expect, test } from "bun:test";
import { createServer } from "../gateway/server";

describe("createServer", () => {
	test("GET /health returns 200 with { status: 'ok' }", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
	});

	test("GET /health returns Content-Type application/json", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/health");
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	test("5. GET /nonexistent with valid auth → 404 { error: 'Not found' }", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/nonexistent", {
			headers: { Authorization: "Bearer test-token" },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("Not found");
	});
});
