/**
 * R32-FLEET.10 — a browser must be able to authenticate a WebSocket upgrade with
 * a *header*, because the `?token=` query fallback it uses today is deleted by
 * R33-REACH.3 and forbidden outright by spec §6.4.
 *
 * These are unit-level proofs of the codec and of the middleware decision. The
 * end-to-end proof — that Chromium really sends this header, that Bun really
 * echoes it, and that a token containing `+`, `/` and `=` really survives the
 * trip — is `scripts/geist-console-bundle.e2e.test.mjs`, in a real browser.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { except } from "hono/combine";
import { bearerAuthMiddleware } from "../gateway/middleware/auth";
import {
	decodeWsBearerSubprotocol,
	encodeWsBearerSubprotocol,
	WS_BEARER_SUBPROTOCOL_PREFIX,
} from "../gateway/ws-bearer";

/** A token with every character that is illegal in a raw subprotocol value. */
const AWKWARD_TOKEN = "aGVsbG8+d29ybGQ/Cg==";

describe("the WebSocket bearer subprotocol codec", () => {
	test("round-trips a token whose base64 alphabet a browser would refuse", () => {
		const offered = encodeWsBearerSubprotocol(AWKWARD_TOKEN);

		// Every character must be an RFC 7230 tchar or Chromium throws in the
		// WebSocket constructor before anything reaches the daemon.
		expect(offered).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
		expect(offered).not.toContain("/");
		expect(offered).not.toContain("=");
		expect(decodeWsBearerSubprotocol(offered)).toBe(AWKWARD_TOKEN);
	});

	test("round-trips non-ASCII, so a credential is bytes and not code units", () => {
		const token = "tökén-ünicode-✓";
		expect(decodeWsBearerSubprotocol(encodeWsBearerSubprotocol(token))).toBe(token);
	});

	test("finds the namespaced entry in a multi-value preference list", () => {
		const header = `chat, ${encodeWsBearerSubprotocol(AWKWARD_TOKEN)} , superchat`;
		expect(decodeWsBearerSubprotocol(header)).toBe(AWKWARD_TOKEN);
	});

	test("reports no credential rather than a partial one", () => {
		expect(decodeWsBearerSubprotocol(undefined)).toBeUndefined();
		expect(decodeWsBearerSubprotocol("")).toBeUndefined();
		expect(decodeWsBearerSubprotocol("chat, superchat")).toBeUndefined();
		expect(decodeWsBearerSubprotocol(WS_BEARER_SUBPROTOCOL_PREFIX)).toBeUndefined();
		expect(decodeWsBearerSubprotocol(`${WS_BEARER_SUBPROTOCOL_PREFIX}!!!not!!!base64!!!`)).toBeUndefined();
	});
});

describe("bearerAuthMiddleware and the upgrade header", () => {
	const app = new Hono();
	app.use("*", except("/health", bearerAuthMiddleware(AWKWARD_TOKEN)));
	app.get("/attach", (c) => c.text("upgraded"));

	async function attach(headers: Record<string, string>): Promise<Response> {
		return app.fetch(new Request("http://127.0.0.1/attach", { headers }));
	}

	test("accepts the credential from Sec-WebSocket-Protocol", async () => {
		const response = await attach({ "Sec-WebSocket-Protocol": encodeWsBearerSubprotocol(AWKWARD_TOKEN) });
		expect(response.status).toBe(200);
	});

	test("refuses a subprotocol carrying the wrong token", async () => {
		const response = await attach({ "Sec-WebSocket-Protocol": encodeWsBearerSubprotocol("not-the-token") });
		expect(response.status).toBe(401);
	});

	test("refuses a subprotocol that carries no credential at all", async () => {
		expect((await attach({ "Sec-WebSocket-Protocol": "chat, superchat" })).status).toBe(401);
		expect((await attach({})).status).toBe(401);
	});

	test("still accepts the Authorization header — this adds a way in, it does not move the door", async () => {
		expect((await attach({ Authorization: `Bearer ${AWKWARD_TOKEN}` })).status).toBe(200);
		expect((await attach({ Authorization: "Bearer wrong" })).status).toBe(401);
	});

	test("prefers the Authorization header when both are present", async () => {
		const response = await attach({
			Authorization: `Bearer ${AWKWARD_TOKEN}`,
			"Sec-WebSocket-Protocol": encodeWsBearerSubprotocol("not-the-token"),
		});
		expect(response.status).toBe(200);
	});
});
