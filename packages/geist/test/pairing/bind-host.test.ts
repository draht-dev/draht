import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import {
	assertBindHostAllowed,
	createPairingServer,
	isLoopbackHost,
	type PairingServerHandle,
} from "../../src/pairing/server.js";

/**
 * Bind posture of the pairing server (R32-FLEET.9, GSEC-04 bind half).
 *
 * `createPairingServer()` used to call `Bun.serve({ port })` with no
 * `hostname`, which binds EVERY interface — the pairing token, and the
 * permission relay behind it, were reachable from any machine that could route
 * to this host. GSEC-04 names that exact line. The bind now goes through
 * `assertBindHostAllowed`, so loopback is the default and anything else is an
 * explicit, warned opt-in.
 *
 * The listener is asserted by connecting to it, not by reading
 * `server.hostname`: Bun reports a hostname for a wildcard bind too, so only an
 * off-box connection attempt distinguishes the two.
 */

/** First non-internal IPv4 address of this host, or null when the box has none. */
function externalIPv4(): string | null {
	for (const iface of Object.values(networkInterfaces())) {
		for (const entry of iface ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return null;
}

/**
 * The TCP sockets this test process is currently listening on, one per line.
 *
 * `lsof` exits non-zero when nothing matches, which is a legitimate answer here
 * ("no listeners"), so the status is ignored and stdout is what is read.
 */
function listeningSockets(): string[] {
	const res = spawnSync("lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN"], {
		encoding: "utf-8",
	});
	return (res.stdout ?? "").split("\n").filter((line) => line.includes("(LISTEN)"));
}

describe("createPairingServer bind host", () => {
	const handles: PairingServerHandle[] = [];

	afterEach(() => {
		for (const h of handles) h.close();
		handles.length = 0;
	});

	function start(opts: Parameters<typeof createPairingServer>[0] = {}): PairingServerHandle {
		const handle = createPairingServer(opts);
		handles.push(handle);
		return handle;
	}

	test("binds loopback by default", () => {
		const handle = start();
		expect(handle.server.hostname).toBe("127.0.0.1");
		expect(handle.url).toContain("127.0.0.1");
	});

	const lan = externalIPv4();
	test.skipIf(lan === null)("the default listener is not reachable from a non-loopback address", async () => {
		const handle = start();

		// Same listener, two addresses: loopback answers, the LAN address does not
		// even accept a connection.
		const onBox = await fetch(`http://127.0.0.1:${handle.server.port}/pair`);
		expect(onBox.status).toBeGreaterThanOrEqual(400); // a plain GET is not an upgrade — but it was served

		await expect(fetch(`http://${lan}:${handle.server.port}/pair`)).rejects.toThrow();
	});

	test("only one socket is opened, and lsof agrees it is loopback-bound", () => {
		const handle = start();
		const forThisServer = listeningSockets().filter((line) => line.includes(`:${handle.server.port}`));
		expect(forThisServer).toHaveLength(1);
		expect(forThisServer[0]).toContain(`127.0.0.1:${handle.server.port}`);
	});

	test("refuses a non-loopback hostname without the explicit opt-in, opening nothing", () => {
		const listenersBefore = listeningSockets().length;

		expect(() => start({ hostname: "0.0.0.0" })).toThrow(/Refusing to bind non-loopback host/);
		expect(() => start({ hostname: "0.0.0.0" })).toThrow(/tailscale serve/);
		expect(() => start({ hostname: "100.72.9.11" })).toThrow(/Refusing to bind non-loopback host/);

		// A refusal has to mean nothing was ever wired: the guard runs before the
		// Hono app, the session-bridge subscription and the socket exist.
		expect(listeningSockets()).toHaveLength(listenersBefore);
	});

	test("accepts a non-loopback hostname with the opt-in, and warns", () => {
		const warnings: string[] = [];
		const handle = start({ hostname: "0.0.0.0", allowNonLoopback: true, warn: (m) => warnings.push(m) });
		expect(handle.server.hostname).toBe("0.0.0.0");
		expect(warnings.join("\n")).toMatch(/NON-LOOPBACK/i);
	});

	test("isLoopbackHost accepts exactly the loopback spellings", () => {
		for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", " LOCALHOST "]) {
			expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: true });
		}
		for (const host of ["0.0.0.0", "::", "100.72.9.11", "192.168.1.4", "example.com"]) {
			expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: false });
		}
	});

	test("assertBindHostAllowed returns the host it approved", () => {
		expect(assertBindHostAllowed({ host: "127.0.0.1" })).toBe("127.0.0.1");
		expect(assertBindHostAllowed({ host: "0.0.0.0", allowNonLoopback: true, warn: () => {} })).toBe("0.0.0.0");
	});
});
