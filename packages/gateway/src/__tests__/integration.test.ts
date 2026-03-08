import { describe, expect, test } from "bun:test";
import { createServer, parseArgs } from "../index";

describe("barrel exports (integration)", () => {
	test("createServer is a function", () => {
		expect(typeof createServer).toBe("function");
	});

	test("parseArgs is a function", () => {
		expect(typeof parseArgs).toBe("function");
	});

	test("full integration: parsed args → createServer → GET /health returns 200", async () => {
		const { port, authToken } = parseArgs(["--port", "7878", "--auth", "integration-token"]);
		const { app } = createServer({ port, authToken });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
	});
});
