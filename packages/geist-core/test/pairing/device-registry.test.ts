import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_BOOTSTRAP_TTL_MS,
	DEVICE_REGISTRY_PATH_ENV,
	DeviceRegistry,
	type DeviceRegistryEvent,
	resolveDeviceRegistryPath,
} from "../../src/pairing/device-registry.js";

/** Deterministic, manually-advanced clock — bootstrap TTLs are wall-clock bound. */
function fakeClock(startMs = 1_000_000) {
	let current = startMs;
	return {
		now: () => current,
		advance: (byMs: number) => {
			current += byMs;
		},
	};
}

let dir: string;
let registryPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "geist-device-registry-"));
	registryPath = join(dir, "devices.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function newRegistry(options: { now?: () => number; onEvent?: (event: DeviceRegistryEvent) => void } = {}) {
	return new DeviceRegistry({ path: registryPath, now: options.now, onEvent: options.onEvent });
}

const IPHONE = { name: "Oskar's iPhone", platform: "ios" } as const;
const QUEST = { name: "Quest 3", platform: "quest" } as const;

describe("DeviceRegistry bootstrap exchange", () => {
	test("a bootstrap token is accepted exactly once — the replay is refused and the device minted by the first exchange stays valid", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap({ ttlMs: 60_000 });

		const first = registry.exchange(bootstrap.token, IPHONE);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("unreachable");
		expect(first.deviceId).toBeTruthy();
		expect(first.credential).toBeTruthy();

		// The replay — same token, a second device claiming it — is refused outright.
		const replay = registry.exchange(bootstrap.token, QUEST);
		expect(replay).toEqual({ ok: false, reason: "bootstrap_consumed" });

		// ...and the first exchange's device is entirely undisturbed (R33-REACH.7).
		expect(registry.verify(first.deviceId, first.credential)).toEqual({
			ok: true,
			outcome: "ok",
			deviceId: first.deviceId,
		});
		expect(registry.list().map((device) => device.id)).toEqual([first.deviceId]);
	});

	test("an expired bootstrap token is refused and mints no device", () => {
		const clock = fakeClock();
		const registry = newRegistry({ now: clock.now });
		const bootstrap = registry.mintBootstrap({ ttlMs: 60_000 });

		clock.advance(60_001);

		expect(registry.exchange(bootstrap.token, IPHONE)).toEqual({ ok: false, reason: "bootstrap_expired" });
		expect(registry.list()).toEqual([]);
	});

	test("TTL boundary — valid one ms before expiry, expired exactly at it", () => {
		const clockA = fakeClock();
		const registryA = newRegistry({ now: clockA.now });
		const liveBootstrap = registryA.mintBootstrap({ ttlMs: 60_000 });
		expect(liveBootstrap.expiresAt).toBe(clockA.now() + 60_000);

		clockA.advance(59_999);
		expect(registryA.exchange(liveBootstrap.token, IPHONE).ok).toBe(true);

		// A second registry, same TTL, advanced to exactly `expiresAt`: expired.
		rmSync(registryPath, { force: true });
		const clockB = fakeClock();
		const registryB = newRegistry({ now: clockB.now });
		const edgeBootstrap = registryB.mintBootstrap({ ttlMs: 60_000 });
		clockB.advance(60_000);
		expect(registryB.exchange(edgeBootstrap.token, IPHONE)).toEqual({ ok: false, reason: "bootstrap_expired" });
	});

	test("an unknown bootstrap token is refused as unknown, not as consumed", () => {
		const registry = newRegistry();
		registry.mintBootstrap({ ttlMs: 60_000 });
		expect(registry.exchange("deadbeef".repeat(8), IPHONE)).toEqual({ ok: false, reason: "unknown_bootstrap" });
	});

	test("the default bootstrap TTL is short", () => {
		expect(DEFAULT_BOOTSTRAP_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
		const registry = newRegistry({ now: () => 5_000 });
		expect(registry.mintBootstrap().expiresAt).toBe(5_000 + DEFAULT_BOOTSTRAP_TTL_MS);
	});
});

describe("DeviceRegistry verify", () => {
	test("a wrong credential of a different length is refused, not thrown on", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");

		expect(registry.verify(exchanged.deviceId, "x")).toEqual({ ok: false, outcome: "credential_mismatch" });
		expect(registry.verify(exchanged.deviceId, "y".repeat(4096))).toEqual({
			ok: false,
			outcome: "credential_mismatch",
		});
	});

	test("an unknown device id is refused as unknown_device", () => {
		const registry = newRegistry();
		expect(registry.verify("dev_nope", "whatever")).toEqual({ ok: false, outcome: "unknown_device" });
	});

	test("the comparison is timing-safe", () => {
		const source = readFileSync(new URL("../../src/pairing/device-registry.ts", import.meta.url), "utf-8");
		expect(source).toContain("timingSafeEqual");
	});

	test("a successful verify advances lastSeen", () => {
		const clock = fakeClock();
		const registry = newRegistry({ now: clock.now });
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");
		expect(registry.list()[0]?.lastSeen).toBe(clock.now());

		clock.advance(30_000);
		registry.verify(exchanged.deviceId, exchanged.credential);
		expect(registry.list()[0]?.lastSeen).toBe(clock.now());
	});
});

describe("DeviceRegistry rotate", () => {
	test("rotation atomically invalidates the predecessor — the successor verifies, the predecessor is credential_reuse", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");

		const rotated = registry.rotate(exchanged.deviceId);
		expect(rotated.ok).toBe(true);
		if (!rotated.ok) throw new Error("unreachable");
		expect(rotated.credential).not.toBe(exchanged.credential);

		expect(registry.verify(exchanged.deviceId, rotated.credential)).toEqual({
			ok: true,
			outcome: "ok",
			deviceId: exchanged.deviceId,
		});
		expect(registry.verify(exchanged.deviceId, exchanged.credential)).toEqual({
			ok: false,
			outcome: "credential_reuse",
		});
	});

	test("presenting a rotated-away predecessor emits a credential_reuse event carrying the deviceId and never the credential", () => {
		const events: DeviceRegistryEvent[] = [];
		const registry = newRegistry({ onEvent: (event) => events.push(event) });
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");
		const rotated = registry.rotate(exchanged.deviceId);
		if (!rotated.ok) throw new Error("unreachable");

		events.length = 0;
		registry.verify(exchanged.deviceId, exchanged.credential);

		const reuse = events.filter((event) => event.type === "credential_reuse");
		expect(reuse).toHaveLength(1);
		expect(reuse[0]?.deviceId).toBe(exchanged.deviceId);

		// The theft signal must never itself leak credential material (GSEC-04).
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain(exchanged.credential);
		expect(serialized).not.toContain(rotated.credential);
		expect(serialized).not.toContain(bootstrap.token);
	});

	test("a wrong credential that was never issued is a mismatch, not a reuse — no theft signal is raised", () => {
		const events: DeviceRegistryEvent[] = [];
		const registry = newRegistry({ onEvent: (event) => events.push(event) });
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");
		registry.rotate(exchanged.deviceId);

		events.length = 0;
		expect(registry.verify(exchanged.deviceId, "f".repeat(exchanged.credential.length))).toEqual({
			ok: false,
			outcome: "credential_mismatch",
		});
		expect(events.filter((event) => event.type === "credential_reuse")).toHaveLength(0);
	});

	test("rotating an unknown device is refused", () => {
		const registry = newRegistry();
		expect(registry.rotate("dev_nope")).toEqual({ ok: false, reason: "unknown_device" });
	});

	test("rotating a revoked device is refused — revocation is not undone by a reconnect", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");
		registry.revoke(exchanged.deviceId);
		expect(registry.rotate(exchanged.deviceId)).toEqual({ ok: false, reason: "revoked" });
	});
});

describe("DeviceRegistry revoke and list", () => {
	test("a revoked device is refused at its next verify and listed as revoked", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");

		expect(registry.revoke(exchanged.deviceId)).toEqual({ ok: true, deviceId: exchanged.deviceId });
		expect(registry.verify(exchanged.deviceId, exchanged.credential)).toEqual({ ok: false, outcome: "revoked" });
		expect(registry.list()[0]?.revoked).toBe(true);
	});

	test("revoking an unknown device is refused", () => {
		const registry = newRegistry();
		expect(registry.revoke("dev_nope")).toEqual({ ok: false, reason: "unknown_device" });
	});

	test("list returns id/name/platform/lastSeen/revoked and never credential material", () => {
		const clock = fakeClock();
		const registry = newRegistry({ now: clock.now });
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");

		const listed = registry.list();
		expect(listed).toEqual([
			{
				id: exchanged.deviceId,
				name: IPHONE.name,
				platform: IPHONE.platform,
				lastSeen: clock.now(),
				revoked: false,
			},
		]);

		const serialized = JSON.stringify(listed);
		expect(serialized).not.toContain(exchanged.credential);
		expect(serialized).not.toContain(bootstrap.token);
	});
});

describe("DeviceRegistry persistence", () => {
	test("records store a hash, not the credential or the bootstrap token", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");
		const rotated = registry.rotate(exchanged.deviceId);
		if (!rotated.ok) throw new Error("unreachable");

		const onDisk = readFileSync(registryPath, "utf-8");
		expect(onDisk).not.toContain(bootstrap.token);
		expect(onDisk).not.toContain(exchanged.credential);
		expect(onDisk).not.toContain(rotated.credential);
		expect(onDisk).toContain(exchanged.deviceId);
	});

	test("the registry file is 0600 and written atomically — no temp file is left behind", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		registry.exchange(bootstrap.token, IPHONE);

		expect(statSync(registryPath).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["devices.json"]);
	});

	test("state survives a fresh registry over the same path", () => {
		const registry = newRegistry();
		const bootstrap = registry.mintBootstrap();
		const exchanged = registry.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");

		const reopened = newRegistry();
		expect(reopened.verify(exchanged.deviceId, exchanged.credential)).toEqual({
			ok: true,
			outcome: "ok",
			deviceId: exchanged.deviceId,
		});
	});

	test("an out-of-process write is observed — a revocation by another process is honoured by a live registry", () => {
		const daemon = newRegistry();
		const bootstrap = daemon.mintBootstrap();
		const exchanged = daemon.exchange(bootstrap.token, IPHONE);
		if (!exchanged.ok) throw new Error("unreachable");
		expect(daemon.list()).toHaveLength(1); // daemon has the file loaded

		// The CLI — a second process over the same path — revokes the device.
		const cli = newRegistry();
		expect(cli.revoke(exchanged.deviceId).ok).toBe(true);

		// The daemon must observe it at the device's NEXT frame, not at next connect.
		expect(daemon.verify(exchanged.deviceId, exchanged.credential)).toEqual({ ok: false, outcome: "revoked" });
		expect(daemon.list()[0]?.revoked).toBe(true);
	});
});

describe("resolveDeviceRegistryPath", () => {
	test("defaults under the per-user geist state directory", () => {
		expect(resolveDeviceRegistryPath({ HOME: "/home/oskar" } as NodeJS.ProcessEnv)).toBe(
			"/home/oskar/.geist/devices.json",
		);
	});

	test("is relocatable by env so the daemon and the CLI can be pointed at one file", () => {
		const env = { [DEVICE_REGISTRY_PATH_ENV]: "/tmp/elsewhere/devices.json" } as unknown as NodeJS.ProcessEnv;
		expect(resolveDeviceRegistryPath(env)).toBe("/tmp/elsewhere/devices.json");
	});
});
