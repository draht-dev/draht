/**
 * R33-REACH.3, .5, .7 — the first-message authentication gate inside the
 * attach bridge, and the bounded window a connection has to pass it.
 *
 * The session below is a REAL Unix socket with a real `<id>.lock` beside it,
 * for one reason: every test here asserts that no socket was dialled, and that
 * assertion is worth nothing against a session that could not be dialled
 * anyway. The device store is the real `DeviceRegistry` too — the bridge's
 * authenticator port exists to be filled by it, and a stub on both sides would
 * prove only that the stub agrees with itself.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	DEFAULT_TRANSPORT_LIMITS,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	type GeistServerFrame,
	ServerFrameSchema,
} from "@draht/geist-protocol";
import {
	AttachBridge,
	type AttachBridgeOptions,
	type DeviceAuthenticator,
	type RendererConnection,
} from "../../src/attach/attach-bridge.js";
import { DeviceRegistry } from "../../src/pairing/device-registry.js";

const SESSION_ID = "session-under-test";
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1000);

let socketDir: string;
let session: Server;
let sessionSockets: Socket[] = [];
let connectionCount = 0;
let registry: DeviceRegistry;
const bridges: AttachBridge[] = [];

/** A renderer whose flush behaviour the test controls. */
class FakeRenderer implements RendererConnection {
	readonly sent: string[] = [];
	readonly closes: { code: number; reason: string }[] = [];
	buffered = 0;

	bufferedBytes(): number {
		return this.buffered;
	}

	send(text: string): void {
		this.sent.push(text);
	}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
	}

	frames(): GeistServerFrame[] {
		return this.sent.map((text) => ServerFrameSchema.parse(JSON.parse(text)));
	}

	types(): string[] {
		return this.frames().map((frame) => frame.type);
	}

	last(): GeistServerFrame {
		const frames = this.frames();
		const frame = frames[frames.length - 1];
		if (!frame) throw new Error("renderer received no frames");
		return frame;
	}
}

/**
 * The registry as the bridge's authenticator port sees it. This is the shape a
 * later task wires into the daemon for real; writing it here is what proves the
 * port is fillable by the registry that already exists.
 */
function issued(deviceId: string, credential: string) {
	const now = Date.now();
	return {
		ok: true as const,
		deviceId,
		credential,
		issuedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + 86_400_000).toISOString(),
	};
}

function registryAuthenticator(store: DeviceRegistry): DeviceAuthenticator {
	return {
		pair({ bootstrapToken, device }) {
			const exchanged = store.exchange(bootstrapToken, device);
			if (!exchanged.ok) return { ok: false, reason: exchanged.reason };
			return issued(exchanged.deviceId, exchanged.credential);
		},
		authenticate({ deviceId, credential }) {
			const verified = store.verify(deviceId, credential);
			if (!verified.ok) return { ok: false, reason: verified.outcome };
			const rotated = store.rotate(deviceId);
			if (!rotated.ok) return { ok: false, reason: rotated.reason };
			return issued(rotated.deviceId, rotated.credential);
		},
	};
}

beforeEach(async () => {
	socketDir = mkdtempSync("/tmp/geist-bridge-auth-");
	sessionSockets = [];
	connectionCount = 0;
	registry = new DeviceRegistry({ path: join(socketDir, "devices.json") });

	session = createServer((socket) => {
		connectionCount += 1;
		sessionSockets.push(socket);
		socket.on("data", () => {});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve, reject) => {
		session.once("error", reject);
		session.listen(join(socketDir, `${SESSION_ID}.sock`), resolve);
	});
	writeFileSync(
		join(socketDir, `${SESSION_ID}.lock`),
		`${process.pid}\n/work/session\n2026-08-18T09:00:00.000Z\n${PROCESS_STARTED_AT_MS}`,
		{ mode: 0o600 },
	);
});

afterEach(() => {
	for (const bridge of bridges) bridge.close();
	bridges.length = 0;
	for (const socket of sessionSockets) socket.destroy();
	session.close();
	rmSync(socketDir, { recursive: true, force: true });
});

function makeBridge(renderer: FakeRenderer, overrides: Partial<AttachBridgeOptions> = {}): AttachBridge {
	const bridge = new AttachBridge({
		socketDir,
		connection: renderer,
		limits: DEFAULT_TRANSPORT_LIMITS,
		drainCheckMs: 5,
		devices: registryAuthenticator(registry),
		...overrides,
	});
	bridges.push(bridge);
	return bridge;
}

function hello(): string {
	return JSON.stringify({
		type: "hello",
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		client: { name: "test-renderer", version: "0.0.0" },
	});
}

function attach(clientId = "c1"): string {
	return JSON.stringify({ type: "attach", sessionId: SESSION_ID, clientId, mode: "read-write" });
}

/** Long enough for a dial to have landed if one had been made. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("first-message authentication", () => {
	test("an attach frame sent after hello but before any credential is refused with protocol_error not_authenticated, and no Unix socket is dialled", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);

		bridge.receive(hello());
		bridge.receive(attach());

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
		await settle();
		expect(connectionCount).toBe(0);
	});
});

describe("the gate", () => {
	test("hello is answered with server_hello alone — the fleet is session data and waits for a credential", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);

		bridge.receive(hello());

		expect(renderer.types()).toEqual(["server_hello"]);
		expect(renderer.closes).toHaveLength(0);
	});

	test("input before a credential is refused with not_authenticated, like every frame that is not pair_device or authenticate", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());

		bridge.receive(JSON.stringify({ type: "input", data: "rm -rf /\r", clientId: "c1" }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
	});

	test("a bootstrap token is exchanged for a device credential, and only then does the fleet arrive", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		const bootstrap = registry.mintBootstrap();
		bridge.receive(hello());

		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "Oskar's iPhone", platform: "ios" },
			}),
		);

		expect(renderer.types()).toEqual(["server_hello", "device_credential", "fleet"]);
		const credential = renderer.frames()[1];
		if (credential?.type !== "device_credential") throw new Error("expected a device_credential frame");
		expect(credential.deviceId).toMatch(/^dev_/);
		expect(credential.credential).not.toBe(bootstrap.token);
		expect(bridge.identity).toEqual({ deviceId: credential.deviceId });

		bridge.receive(attach());
		await settle();
		expect(connectionCount).toBe(1);
	});

	test("a paired device authenticates on reconnect and is handed a rotated credential", () => {
		const bootstrap = registry.mintBootstrap();
		const paired = registry.exchange(bootstrap.token, { name: "iPhone", platform: "ios" });
		if (!paired.ok) throw new Error("pairing the fixture device failed");

		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({ type: "authenticate", deviceId: paired.deviceId, credential: paired.credential }),
		);

		expect(renderer.types()).toEqual(["server_hello", "device_credential", "fleet"]);
		const rotated = renderer.frames()[1];
		if (rotated?.type !== "device_credential") throw new Error("expected a device_credential frame");
		expect(rotated.deviceId).toBe(paired.deviceId);
		expect(rotated.credential).not.toBe(paired.credential);
		expect(registry.verify(paired.deviceId, paired.credential)).toEqual({ ok: false, outcome: "credential_reuse" });
	});

	test("one connection is one guess: a wrong credential closes the socket and the refusal names no registry outcome", async () => {
		const bootstrap = registry.mintBootstrap();
		const paired = registry.exchange(bootstrap.token, { name: "iPhone", platform: "ios" });
		if (!paired.ok) throw new Error("pairing the fixture device failed");

		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());
		bridge.receive(JSON.stringify({ type: "authenticate", deviceId: paired.deviceId, credential: "f".repeat(64) }));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
		const refusal = renderer.last();
		if (refusal.type !== "protocol_error") throw new Error("expected a protocol_error frame");
		expect(refusal.message).not.toMatch(/credential_mismatch|unknown_device|revoked|credential_reuse/);

		// The second guess is not merely refused — it is not even attempted, and
		// the correct credential does not rescue this connection.
		const sentAfterRefusal = renderer.sent.length;
		bridge.receive(
			JSON.stringify({ type: "authenticate", deviceId: paired.deviceId, credential: paired.credential }),
		);
		expect(renderer.sent).toHaveLength(sentAfterRefusal);
		expect(bridge.identity).toBeNull();
		await settle();
		expect(connectionCount).toBe(0);
	});

	test("a replayed bootstrap token is refused on the replaying connection and the device it already bound is untouched", () => {
		const bootstrap = registry.mintBootstrap();
		const first = registry.exchange(bootstrap.token, { name: "iPhone", platform: "ios" });
		if (!first.ok) throw new Error("pairing the fixture device failed");

		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "attacker", platform: "linux" },
			}),
		);

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(registry.verify(first.deviceId, first.credential)).toEqual({
			ok: true,
			outcome: "ok",
			deviceId: first.deviceId,
		});
		expect(registry.list()).toHaveLength(1);
	});

	test("a second authentication on an already-authenticated connection is refused", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer);
		const bootstrap = registry.mintBootstrap();
		const second = registry.mintBootstrap();
		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);
		const identity = bridge.identity;

		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: second.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
		expect(bridge.identity).toEqual(identity);
	});
});

describe("credentials presented on the upgrade request", () => {
	test("a header-authenticated client needs no first message: hello alone unlocks the fleet", async () => {
		const bootstrap = registry.mintBootstrap();
		const paired = registry.exchange(bootstrap.token, { name: "iPhone", platform: "ios" });
		if (!paired.ok) throw new Error("pairing the fixture device failed");

		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			presentedCredential: { deviceId: paired.deviceId, credential: paired.credential },
		});

		bridge.receive(hello());

		expect(renderer.types()).toEqual(["server_hello", "device_credential", "fleet"]);
		expect(bridge.identity).toEqual({ deviceId: paired.deviceId });

		bridge.receive(attach());
		await settle();
		expect(connectionCount).toBe(1);
	});

	test("a bad credential on the upgrade request is refused at hello, before server_hello and before any dial", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			presentedCredential: { deviceId: "dev_nope", credential: "f".repeat(64) },
		});

		bridge.receive(hello());

		expect(renderer.types()).toEqual(["protocol_error"]);
		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		bridge.receive(attach());
		await settle();
		expect(connectionCount).toBe(0);
	});

	test("a bridge with no authenticator is one whose host authenticated the upgrade — it behaves exactly as before", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, { devices: undefined });

		bridge.receive(hello());

		expect(renderer.types()).toEqual(["server_hello", "fleet"]);
		expect(bridge.authenticated).toBe(true);
	});
});

describe("the pre-auth window", () => {
	test("a connection that presents nothing is closed once the deadline passes", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, { authDeadlineMs: 20 });
		bridge.receive(hello());

		expect(renderer.closes).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(renderer.last()).toMatchObject({ type: "protocol_error", code: "not_authenticated" });
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
		expect(bridge.authenticated).toBe(false);
	});

	test("the deadline stops mattering the moment a credential lands", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, { authDeadlineMs: 20 });
		const bootstrap = registry.mintBootstrap();
		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);

		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(renderer.closes).toHaveLength(0);
		expect(renderer.types()).toEqual(["server_hello", "device_credential", "fleet"]);
	});
});

describe("identity is per-bridge, never per-module", () => {
	test("two bridges authenticated concurrently as different devices never see each other's identity", () => {
		const firstBootstrap = registry.mintBootstrap();
		const secondBootstrap = registry.mintBootstrap();
		const rendererA = new FakeRenderer();
		const rendererB = new FakeRenderer();
		const bridgeA = makeBridge(rendererA);
		const bridgeB = makeBridge(rendererB);

		// Interleaved on purpose: both connections are mid-handshake at once, so
		// a shared "current identity" would be observable here.
		bridgeA.receive(hello());
		bridgeB.receive(hello());
		bridgeA.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: firstBootstrap.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);
		expect(bridgeB.identity).toBeNull();
		expect(bridgeB.authenticated).toBe(false);

		bridgeB.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: secondBootstrap.token,
				device: { name: "Quest", platform: "android" },
			}),
		);

		const a = bridgeA.identity;
		const b = bridgeB.identity;
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a).not.toEqual(b);

		// And a third bridge, constructed after both, starts from nothing.
		const rendererC = new FakeRenderer();
		const bridgeC = makeBridge(rendererC);
		bridgeC.receive(hello());
		expect(bridgeC.identity).toBeNull();
		expect(bridgeC.authenticated).toBe(false);
	});
});

describe("the authorize seam", () => {
	test("authorize is consulted on every inbound frame and before every outbound emit", async () => {
		const seen: { direction: string; frame: string; deviceId: string | null }[] = [];
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			authorize: (request) => {
				seen.push({
					direction: request.direction,
					frame: request.frame.type,
					deviceId: request.identity?.deviceId ?? null,
				});
				return { allow: true };
			},
		});
		const bootstrap = registry.mintBootstrap();

		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);

		expect(seen.map((entry) => `${entry.direction}:${entry.frame}`)).toEqual([
			"inbound:hello",
			"outbound:server_hello",
			"inbound:pair_device",
			"outbound:device_credential",
			"outbound:fleet",
		]);
		// The identity is on the request from the moment it exists, which is what
		// makes this the seam a per-device policy hangs off.
		expect(seen[0]?.deviceId).toBeNull();
		expect(seen[2]?.deviceId).toBeNull();
		expect(seen[4]?.deviceId).toBe(bridge.identity?.deviceId ?? null);
	});

	test("a denied inbound frame is refused with the policy's code and never reaches a session", async () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			authorize: (request) =>
				request.direction === "inbound" && request.frame.type === "attach"
					? { allow: false, code: "not_authenticated", message: "this device may not attach" }
					: { allow: true },
		});
		const bootstrap = registry.mintBootstrap();
		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);

		bridge.receive(attach());

		expect(renderer.last()).toEqual({
			type: "protocol_error",
			code: "not_authenticated",
			message: "this device may not attach",
		});
		await settle();
		expect(connectionCount).toBe(0);
	});

	test("a denied outbound frame is not sent, and the connection is refused rather than left with a hole in it", () => {
		const renderer = new FakeRenderer();
		const bridge = makeBridge(renderer, {
			authorize: (request) =>
				request.direction === "outbound" && request.frame.type === "fleet"
					? { allow: false, code: "not_authenticated", message: "this device may not list the fleet" }
					: { allow: true },
		});
		const bootstrap = registry.mintBootstrap();
		bridge.receive(hello());
		bridge.receive(
			JSON.stringify({
				type: "pair_device",
				bootstrapToken: bootstrap.token,
				device: { name: "iPhone", platform: "ios" },
			}),
		);

		expect(renderer.types()).toEqual(["server_hello", "device_credential", "protocol_error"]);
		expect(renderer.closes).toEqual([{ code: 1008, reason: "not_authenticated" }]);
	});
});
