import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { createServer } from "../gateway/server";

const AUTH = "enforcement-token";

/**
 * A stand-in for the Bun `Server` object Bun.serve passes to `app.fetch` as the
 * second argument (which Hono exposes as `c.env`). Only `requestIP` is used by
 * the guard, so only `requestIP` is modelled.
 */
function serverEnvWithPeer(address: string | null): unknown {
	return {
		requestIP: () =>
			address === null ? null : { address, family: address.includes(":") ? "IPv6" : "IPv4", port: 1 },
	};
}

/** First non-internal IPv4 address of this host, or null when the box has none. */
function externalIPv4(): string | null {
	for (const iface of Object.values(networkInterfaces())) {
		for (const entry of iface ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

describe("embedder bind enforcement", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];
	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	test("refuses a request arriving from a non-loopback peer", async () => {
		const { app } = createServer({ port: 0, authToken: AUTH, warn: () => {} });

		const res = await app.fetch(
			new Request("http://192.168.1.10/health"),
			serverEnvWithPeer("192.168.1.50") as never,
		);

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Forbidden: gateway is bound loopback-only" });
	});

	test("refuses an authenticated session create from a non-loopback peer", async () => {
		const { app } = createServer({ port: 0, authToken: AUTH, warn: () => {} });

		const res = await app.fetch(
			new Request("http://192.168.1.10/sessions", {
				method: "POST",
				headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "application/json" },
				body: JSON.stringify({ command: ["echo", "pwned"] }),
			}),
			serverEnvWithPeer("192.168.1.50") as never,
		);

		expect(res.status).toBe(403);
	});

	test("serves a loopback peer", async () => {
		const { app } = createServer({ port: 0, authToken: AUTH, warn: () => {} });

		for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) {
			const res = await app.fetch(new Request("http://localhost/health"), serverEnvWithPeer(peer) as never);
			expect({ peer, status: res.status }).toEqual({ peer, status: 200 });
		}
	});

	test("serves a non-loopback peer once the opt-in is given", async () => {
		const { app } = createServer({
			port: 0,
			authToken: AUTH,
			host: "0.0.0.0",
			allowNonLoopback: true,
			warn: () => {},
		});

		const res = await app.fetch(
			new Request("http://192.168.1.10/health"),
			serverEnvWithPeer("192.168.1.50") as never,
		);

		expect(res.status).toBe(200);
	});

	test("logs the refusal once, with remediation, no matter how many requests arrive", async () => {
		const warnings: string[] = [];
		const { app } = createServer({ port: 0, authToken: AUTH, warn: (m) => warnings.push(m) });

		for (let i = 0; i < 3; i++) {
			await app.fetch(new Request("http://192.168.1.10/health"), serverEnvWithPeer("192.168.1.50") as never);
		}

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("192.168.1.50");
		expect(warnings[0]).toMatch(/startGateway|allowNonLoopback/);
	});

	test("still serves when the peer cannot be determined (unix socket / direct fetch)", async () => {
		const { app } = createServer({ port: 0, authToken: AUTH, warn: () => {} });

		expect((await app.fetch(new Request("http://localhost/health"))).status).toBe(200);
		expect((await app.fetch(new Request("http://localhost/health"), serverEnvWithPeer(null) as never)).status).toBe(
			200,
		);
	});

	const lan = externalIPv4();
	test.skipIf(lan === null)("end-to-end: embedder binds 0.0.0.0 without opt-in, off-box request refused", async () => {
		const { app, websocket } = createServer({ port: 0, authToken: AUTH, warn: () => {} });

		// The embedder ignores the vetted hostname and binds every interface.
		const server = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: app.fetch, websocket });
		servers.push(server);

		const offBox = await fetch(`http://${lan}:${server.port}/health`);
		expect(offBox.status).toBe(403);

		// Loopback traffic to the same listener is untouched.
		const onBox = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(onBox.status).toBe(200);
	});
});
