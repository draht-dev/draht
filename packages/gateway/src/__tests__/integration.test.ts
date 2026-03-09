import { describe, expect, test } from "bun:test";
import type { GatewaySettings } from "../config/config";
import { createServer, parseArgs } from "../index";

const TEST_CONFIG: GatewaySettings = {
	port: 7878,
	host: "0.0.0.0",
	tokens: {},
	allowedPaths: ["~/"],
	maxSessions: 100,
	idleTimeout: 255,
};

describe("barrel exports (integration)", () => {
	test("createServer is a function", () => {
		expect(typeof createServer).toBe("function");
	});

	test("parseArgs is a function", () => {
		expect(typeof parseArgs).toBe("function");
	});

	test("full integration: parsed args → createServer → GET /health returns 200", async () => {
		const { port, authToken, config } = parseArgs(["--port", "7878", "--auth", "integration-token"], TEST_CONFIG);
		const { app } = createServer({ port, authToken, config });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
	});
});
