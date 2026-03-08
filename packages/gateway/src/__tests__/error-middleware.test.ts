import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorHandler, notFoundHandler } from "../gateway/middleware/error";

function buildApp(): Hono {
	const app = new Hono();
	app.onError(errorHandler);
	app.notFound(notFoundHandler);
	return app;
}

describe("Error middleware", () => {
	test("1. Route that throws → 500, body { error: 'Internal server error' }, no stack trace", async () => {
		const app = buildApp();
		app.get("/boom", () => {
			throw new Error("something broke");
		});

		const res = await app.request("/boom");
		expect(res.status).toBe(500);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("Internal server error");
		// Must NOT contain stack trace
		const raw = JSON.stringify(body);
		expect(raw).not.toContain("at ");
		expect(raw).not.toContain("Error:");
	});

	test("2. Unknown route → 404, body { error: 'Not found' }", async () => {
		const app = buildApp();

		const res = await app.request("/nonexistent");
		expect(res.status).toBe(404);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("Not found");
	});

	test("3. errorHandler does not re-throw (process doesn't crash)", async () => {
		const app = buildApp();
		app.get("/safe", () => {
			throw new Error("contained error");
		});

		// If re-thrown, app.request would reject; we expect it to resolve
		const res = await app.request("/safe");
		expect(res.status).toBe(500);
	});

	test("4. HTTPException(422) → 422 status, body { error: <message> }", async () => {
		const app = buildApp();
		app.get("/unprocessable", () => {
			throw new HTTPException(422, { message: "Invalid input" });
		});

		const res = await app.request("/unprocessable");
		expect(res.status).toBe(422);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("Invalid input");
	});
});
