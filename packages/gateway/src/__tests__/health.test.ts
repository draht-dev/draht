import { describe, expect, test } from "bun:test";
import { createServer } from "../gateway/server";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";

// Read version from package.json for test 4
const pkg = (await import("../../package.json")).default as { version: string };

describe("Health endpoint", () => {
	test("1. GET /health → 200 with { status, sessions, uptime, version }", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(typeof body.sessions).toBe("number");
		expect(typeof body.uptime).toBe("number");
		expect(typeof body.version).toBe("string");
	});

	test("2. sessions reflects manager state (create 2 sessions → sessions === 2)", async () => {
		const manager = new SessionManager(new EventBus());
		manager.create(); // no process, just seed
		manager.create();

		const { app } = createServer({ port: 7878, authToken: "test-token", manager });
		const res = await app.request("/health");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.sessions).toBe(2);
	});

	test("3. uptime >= 0 and < 5 (fast test)", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/health");
		const body = (await res.json()) as Record<string, unknown>;
		const uptime = body.uptime as number;
		expect(uptime).toBeGreaterThanOrEqual(0);
		expect(uptime).toBeLessThan(5);
	});

	test("4. version matches package.json version", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/health");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.version).toBe(pkg.version);
	});

	test("5. GET /health does not require auth", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		// No Authorization header
		const res = await app.request("/health");
		expect(res.status).toBe(200);
	});
});
