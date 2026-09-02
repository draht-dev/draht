/**
 * R33-REACH.3, R33-REACH.5 — `/attach` authenticates on the wire, not on the
 * upgrade request.
 *
 * Until Phase 33 the daemon answered an unauthenticated `/attach` with a 401 on
 * the upgrade: no WebSocket existed, so no frame could arrive, so no Unix socket
 * could be dialled. That mechanism cannot survive R33-REACH.5. A device
 * presents its credential in a frame — `pair_device` on its first connect,
 * `authenticate` on every one after — and a frame needs a WebSocket, which needs
 * a 101, which the strict middleware refused to let happen.
 *
 * So the 101 now happens before authentication, and the refusal moved onto the
 * wire as a typed `not_authenticated` `protocol_error`. The invariant did not
 * move: the bridge answers `hello` with `server_hello` and nothing else, and
 * refuses every other frame — including the `attach` that would dial a session —
 * until this connection has presented a credential. What changed is which layer
 * says no, not whether anything is reachable before it does.
 *
 * These are package-level proofs over a real `Bun.serve`; the emitted-daemon
 * proof of the same property is `fleet-attach.e2e.test.ts`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import {
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";
import { websocket } from "hono/bun";
import type { AttachDeviceAuthenticator } from "../gateway/routes/fleet";
import { createServer } from "../gateway/server";

/** The daemon's shared operator token. Never a device credential. */
const TOKEN = "attach-first-message-token";
const DEVICE_ID = "dev_beefcafe";
/** What the device was issued last connect, and re-presents this connect. */
const CREDENTIAL = "credential-as-issued";
/** What it is rotated to when it presents the above (R33-REACH.5). */
const ROTATED = "credential-after-rotation";

/**
 * A device store with exactly one paired device.
 *
 * Hand-written rather than a real `DeviceRegistry`: what is under test here is
 * the gateway's wiring — that a credential reaches the bridge and that nothing
 * is reachable before one does — and a fake makes "the credential the store
 * accepts" a constant the assertions can name.
 */
const devices: AttachDeviceAuthenticator = {
	pair() {
		return { ok: false, reason: "this store issues no bootstrap tokens" };
	},
	authenticate(input) {
		if (input.deviceId !== DEVICE_ID || input.credential !== CREDENTIAL) {
			return { ok: false, reason: "unknown device or credential" };
		}
		return {
			ok: true,
			deviceId: DEVICE_ID,
			credential: ROTATED,
			issuedAt: new Date(0).toISOString(),
			expiresAt: new Date(86_400_000).toISOString(),
		};
	},
};

let server: ReturnType<typeof Bun.serve>;
let socketDir: string;
let httpBase: string;
let wsBase: string;

beforeAll(() => {
	// An empty socket directory: every refusal below must hold without any
	// session existing, and a dial that somehow happened would fail loudly
	// rather than quietly succeed against a real session.
	socketDir = mkdtempSync("/tmp/gafm-");
	const { app } = createServer({ port: 0, authToken: TOKEN, socketDir, devices });
	// Loopback named explicitly: a hostname-less `Bun.serve` binds every
	// interface (R32-FLEET.9).
	server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
	httpBase = `http://127.0.0.1:${server.port}`;
	wsBase = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	rmSync(socketDir, { recursive: true, force: true });
});

/** One renderer connection, collecting every frame the daemon emits. */
class Wire {
	readonly frames: GeistServerFrame[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly opened: Promise<"open" | "refused">;
	readonly #ws: WebSocket;

	constructor(url: string, headers?: Record<string, string>) {
		this.#ws = headers
			? new (WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => WebSocket)(
					url,
					{ headers },
				)
			: new WebSocket(url);
		this.#ws.addEventListener("message", (event: MessageEvent) => {
			// Re-validated on arrival: nothing the daemon emits is trusted here.
			this.frames.push(ServerFrameSchema.parse(JSON.parse(String(event.data))));
		});
		this.#ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
		this.opened = new Promise((resolve) => {
			this.#ws.addEventListener("open", () => resolve("open"));
			this.#ws.addEventListener("error", () => resolve("refused"));
			this.#ws.addEventListener("close", () => resolve("refused"));
		});
	}

	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	hello(): void {
		this.send({
			type: "hello",
			protocol: GEIST_PROTOCOL_FAMILY,
			version: GEIST_PROTOCOL_VERSION,
			client: { name: "attach-auth-test", version: "0.0.0" },
		});
	}

	async waitFor(predicate: (frame: GeistServerFrame) => boolean, what: string): Promise<GeistServerFrame> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const found = this.frames.find(predicate);
			if (found) return found;
			await Bun.sleep(10);
		}
		throw new Error(`timed out waiting for ${what} (saw: ${this.frames.map((f) => f.type).join(", ")})`);
	}

	async waitForClose(): Promise<{ code: number; reason: string }> {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (this.closed) return this.closed;
			await Bun.sleep(10);
		}
		throw new Error("timed out waiting for the daemon to close the connection");
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// Already gone.
		}
	}
}

test("a /attach upgrade carrying ?token=<valid> gets a 101 then a not_authenticated protocol_error and a close, while the same credential sent as the first frame after hello is accepted", async () => {
	// The query string is not a credential source (spec §6.4, R33-REACH.3), so
	// this is a valid credential in a place the daemon does not look. It is also
	// the only way a *browser* could have smuggled one onto an upgrade before
	// R33-REACH.3, which is why it is the case worth pinning.
	const smuggled = `${DEVICE_ID}:${CREDENTIAL}`;
	const viaQuery = new Wire(`${wsBase}/attach?token=${encodeURIComponent(smuggled)}`);

	// The 101 happens: authentication is no longer a property of the upgrade.
	expect(await viaQuery.opened).toBe("open");

	viaQuery.hello();
	const greeting = await viaQuery.waitFor((frame) => frame.type === "server_hello", "server_hello");
	expect(greeting.type).toBe("server_hello");
	// …and nothing else. The fleet is session data — which sessions exist, where,
	// under which pid — and it goes out once this connection is somebody.
	expect(viaQuery.frames.filter((frame) => frame.type === "fleet")).toHaveLength(0);
	expect(viaQuery.frames.filter((frame) => frame.type === "device_credential")).toHaveLength(0);

	// The frame that would dial a Unix socket. Refused above the switch that
	// would have looked the session up, so nothing on the filesystem is touched.
	viaQuery.send({ type: "attach", sessionId: "any-session", clientId: "intruder", mode: "read-write" });
	const refusal = await viaQuery.waitFor((frame) => frame.type === "protocol_error", "the refusal");
	expect(refusal).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
	expect((await viaQuery.waitForClose()).code).toBe(1008);
	viaQuery.close();

	// The same credential, in the one place the daemon does read it: a frame.
	const viaFrame = new Wire(`${wsBase}/attach`);
	expect(await viaFrame.opened).toBe("open");
	viaFrame.hello();
	await viaFrame.waitFor((frame) => frame.type === "server_hello", "server_hello");
	viaFrame.send({ type: "authenticate", deviceId: DEVICE_ID, credential: CREDENTIAL });

	const issued = await viaFrame.waitFor((frame) => frame.type === "device_credential", "device_credential");
	expect(issued).toMatchObject({ type: "device_credential", deviceId: DEVICE_ID, credential: ROTATED });
	// The fleet follows the credential, never precedes it.
	await viaFrame.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	expect(viaFrame.closed).toBeNull();
	viaFrame.close();
}, 20_000);

test("the credential may also ride the upgrade headers, which is where the browser has to put it", async () => {
	// `Authorization` for a native client, `Sec-WebSocket-Protocol` for a browser
	// — the only two sources R33-REACH.3 leaves standing. Both are handed to the
	// bridge, which spends them down the same path an `authenticate` frame takes.
	const viaHeader = new Wire(`${wsBase}/attach`, { Authorization: `Bearer ${DEVICE_ID}:${CREDENTIAL}` });
	expect(await viaHeader.opened).toBe("open");
	viaHeader.hello();
	const issued = await viaHeader.waitFor((frame) => frame.type === "device_credential", "device_credential");
	expect(issued).toMatchObject({ deviceId: DEVICE_ID, credential: ROTATED });
	viaHeader.close();
});

test("a wrong credential on the upgrade headers is refused on the wire, not with a 401", async () => {
	const viaHeader = new Wire(`${wsBase}/attach`, { Authorization: `Bearer ${DEVICE_ID}:not-the-credential` });
	expect(await viaHeader.opened).toBe("open");
	viaHeader.hello();
	const refusal = await viaHeader.waitFor((frame) => frame.type === "protocol_error", "the refusal");
	expect(refusal).toMatchObject({ code: "not_authenticated" });
	// A bad credential on the upgrade costs the handshake it had not earned.
	expect(viaHeader.frames.filter((frame) => frame.type === "server_hello")).toHaveLength(0);
	expect((await viaHeader.waitForClose()).code).toBe(1008);
	viaHeader.close();
});

test("every other route stays strict — only /attach left the middleware", async () => {
	// `/fleet` is the same session data the bridge withholds before a credential,
	// over HTTP. It has no first-message channel to refuse on, so it keeps the
	// 401 it always had.
	expect((await fetch(`${httpBase}/fleet`)).status).toBe(401);
	expect((await fetch(`${httpBase}/fleet`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);

	// The route that writes into a session's stdin. If the carve-out had been
	// written with a prefix instead of an exact path, this is what it would have
	// taken with it.
	const input = await fetch(`${httpBase}/sessions/any-session/input`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ data: "rm -rf /\n" }),
	});
	expect(input.status).toBe(401);

	// The two carve-outs that were always there are unchanged.
	expect((await fetch(`${httpBase}/health`)).status).toBe(200);
});
