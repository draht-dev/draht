import { describe, expect, test } from "bun:test";
import { createServer } from "../gateway/server";

/**
 * Content-Security-Policy on the served document (R33-REACH.9, GSEC-04 #5).
 *
 * The console stores a device credential scoped to its origin (P33-T12), which
 * makes any script injected into `/ui` a credential thief rather than a
 * defacement. The policy below is the one thing standing between a bad byte in
 * the transcript and a stolen device credential, so it is asserted on every
 * `/ui*` response — the document, its stylesheet, its script, and the
 * handshake constants — not just on the document.
 */
const EXPECTED_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

const SERVED_PATHS = [
	"/ui",
	"/ui/",
	"/ui/console.css",
	"/ui/console.js",
	"/ui/tokens.css",
	"/ui/protocol.json",
] as const;

describe("Console Content-Security-Policy", () => {
	test("GET /ui answers with a Content-Security-Policy that forbids inline script and eval", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/ui");

		expect(res.status).toBe(200);
		const csp = res.headers.get("Content-Security-Policy");
		expect(csp).toBe(EXPECTED_CSP);
		expect(csp).not.toContain("unsafe-inline");
		expect(csp).not.toContain("unsafe-eval");
	});

	test("every served asset carries the same policy — CSS, JS and protocol.json included", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });

		for (const path of SERVED_PATHS) {
			const res = await app.request(path);
			expect({ path, status: res.status }).toEqual({ path, status: 200 });
			expect({ path, csp: res.headers.get("Content-Security-Policy") }).toEqual({
				path,
				csp: EXPECTED_CSP,
			});
		}
	});

	test("the policy survives the 404 path, so no /ui* response is unprotected", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const res = await app.request("/ui/not-an-asset");
		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Security-Policy")).toBe(EXPECTED_CSP);
	});

	test("script-src and style-src name only 'self' — no host, nonce or hash escape hatch", async () => {
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const csp = (await app.request("/ui")).headers.get("Content-Security-Policy") ?? "";

		const directives = new Map(
			csp
				.split(";")
				.map((part) => part.trim())
				.filter((part) => part.length > 0)
				.map((part) => {
					const [name, ...values] = part.split(/\s+/);
					return [name as string, values] as const;
				}),
		);

		expect(directives.get("script-src")).toEqual(["'self'"]);
		expect(directives.get("style-src")).toEqual(["'self'"]);
		expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
		expect(directives.get("base-uri")).toEqual(["'none'"]);
		expect(directives.get("default-src")).toEqual(["'self'"]);
	});

	test("the policy is scoped to /ui — API responses are not stamped with it", async () => {
		// The console router is mounted at the gateway root, so a wildcard
		// middleware would have leaked `frame-ancestors 'none'` onto every API
		// response. This is the regression that keeps the scoping honest.
		const { app } = createServer({ port: 7878, authToken: "test-token" });
		const health = await app.request("/health");
		expect(health.status).toBe(200);
		expect(health.headers.get("Content-Security-Policy")).toBeNull();
	});
});
